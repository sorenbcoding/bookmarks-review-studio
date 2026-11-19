// End-to-end tests of the extension controller against a temporary UiPath project on disk.
// The `vscode` module is replaced by test/helpers/vscode-mock.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const mockPath = path.join(__dirname, 'helpers', 'vscode-mock.js');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'vscode' ? mockPath : originalResolve.call(this, request, ...rest);
};
const vscode = require('vscode');
const { activate } = require('../src/extension');
const opener = require('../src/openFile');
const { unzip } = require('./helpers/unzip');

// Never start a real image viewer from the tests.
opener.openWithDefaultApp = async (uri) => {
  vscode.mock.opened.push(uri);
  return { ok: true, via: 'test' };
};

const BOOKMARK = 'c7311c1d-903e-4b37-af5e-f02ec9413a1b';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bookmarks-review-'));
  fs.mkdirSync(path.join(root, '.project'));
  fs.writeFileSync(path.join(root, 'project.json'), '{}');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'bookmarks.json'), path.join(root, '.project', 'bookmarks.json'));

  vscode.mock.workspaceFolders = [{ uri: vscode.Uri.file(root) }];
  vscode.mock.messages = [];
  vscode.mock.opened = [];
  vscode.mock.settings = {};
  vscode.mock.settingsReadOnly = false;
  const stored = new Map();
  const globalState = { get: (k) => stored.get(k), update: async (k, v) => void (v === undefined ? stored.delete(k) : stored.set(k, v)) };
  const context = { subscriptions: [], globalState, extensionUri: vscode.Uri.file(path.join(__dirname, '..')) };
  activate(context);
  const controller = vscode.mock.providers.get('bookmarksReview.view');
  await controller.ready;

  const posted = [];
  let handler;
  const hooks = { beforeRender: null }; // test hook: runs while the panel "renders" the report
  const webview = {
    cspSource: 'mock',
    options: {},
    html: '',
    asWebviewUri: (u) => ({ toString: () => `https://wv/${u.fsPath.replace(/\\/g, '/')}` }),
    postMessage: (m) => {
      posted.push(m);
      // The panel renders report Markdown with Toast UI; here each piece becomes one <p>, with images.
      if (m.type === 'renderReport') {
        const toHtml = (md) => `<p>${md.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">')}</p>`;
        const html = Object.fromEntries(m.sections.map((sct) => [sct.id, toHtml(sct.markdown)]));
        setTimeout(async () => {
          if (hooks.beforeRender) await hooks.beforeRender();
          handler({ type: 'reportRendered', requestId: m.requestId, html });
        }, 0);
      }
    },
    onDidReceiveMessage: (fn) => (handler = fn),
  };
  await controller.resolveWebviewView({ webview, onDidDispose() {} });
  const send = async (msg) => {
    await handler(msg);
    await new Promise((r) => setTimeout(r, 20)); // let refreshLater() finish
    await controller.queue;
  };
  const last = (type) => posted.filter((m) => m.type === type).at(-1);
  const file = (...p) => path.join(root, '.review', ...p);
  return { root, controller, posted, send, last, file, globalState, hooks };
}

async function pasteImage(t) {
  await t.send({ type: 'pasteImage', requestId: Math.random(), noteId: BOOKMARK, dataUrl: PNG });
  return t.last('imageSaved').src;
}

test('lists the bookmarks from bookmarks.json', async () => {
  const t = await setup();
  await t.send({ type: 'ready' });
  const state = t.last('state');
  assert.equal(state.workflows.flatMap((w) => w.bookmarks).length, 3);
});

test('note, reply and screenshots: stored with relative paths, shown with webview URLs', async () => {
  const t = await setup();
  const noteShot = await pasteImage(t);
  await t.send({ type: 'save', bookmarkId: BOOKMARK, noteId: BOOKMARK, body: `Check this\n\n![s](${noteShot})`, status: 'open' });
  const noteText = fs.readFileSync(t.file('notes', `${BOOKMARK}.md`), 'utf8');
  assert.match(noteText, new RegExp(`\\]\\(\\.\\./assets/${BOOKMARK}/[^)]+\\.png\\)`));
  assert.match(noteText, /status: "open"/);

  const replyShot = await pasteImage(t);
  await t.send({ type: 'saveReply', bookmarkId: BOOKMARK, noteId: BOOKMARK, body: `Fixed\n\n![s](${replyShot})` });
  const replyFiles = fs.readdirSync(t.file('replies', BOOKMARK));
  assert.equal(replyFiles.length, 1);
  assert.match(replyFiles[0], /^\d{8}T\d{6}Z-[a-z0-9]{4}\.md$/);
  const replyText = fs.readFileSync(t.file('replies', BOOKMARK, replyFiles[0]), 'utf8');
  assert.match(replyText, new RegExp(`\\]\\(\\.\\./\\.\\./assets/${BOOKMARK}/`));
  assert.match(replyText, new RegExp(`author: ${JSON.stringify(t.controller.author)}`));

  await t.send({ type: 'open', bookmarkId: BOOKMARK });
  const note = t.last('note');
  assert.ok(note.body.includes(noteShot), 'note screenshot shown via webview URL');
  assert.equal(note.replies.length, 1);
  assert.ok(note.replies[0].body.includes(replyShot), 'reply screenshot shown via webview URL');
  assert.equal(note.replies[0].mine, true);
  assert.equal(t.last('state').workflows.flatMap((w) => w.bookmarks).find((b) => b.id === BOOKMARK).note.replyCount, 1);
});

test('screenshot cleanup keeps images still used by a reply', async () => {
  const t = await setup();
  // As in the panel: the note is written first, the reply later (a reply draft and the note editor are never open together).
  const noteShot = await pasteImage(t);
  await t.send({ type: 'save', bookmarkId: BOOKMARK, noteId: BOOKMARK, body: `![a](${noteShot})`, status: 'open' });
  const replyShot = await pasteImage(t);
  await t.send({ type: 'saveReply', bookmarkId: BOOKMARK, noteId: BOOKMARK, body: `![b](${replyShot})` });
  assert.equal(fs.readdirSync(t.file('assets', BOOKMARK)).length, 2);

  await t.send({ type: 'save', bookmarkId: BOOKMARK, noteId: BOOKMARK, body: 'Image removed from the note', status: 'open' });
  const left = fs.readdirSync(t.file('assets', BOOKMARK));
  assert.equal(left.length, 1);
  assert.ok(replyShot.endsWith(left[0]), 'the reply screenshot is kept');
});

test('status changes from the read view keep the note text', async () => {
  const t = await setup();
  await t.send({ type: 'save', bookmarkId: BOOKMARK, noteId: BOOKMARK, body: 'Body text', status: 'open' });
  await t.send({ type: 'setStatus', noteId: BOOKMARK, status: 'resolved' });
  const text = fs.readFileSync(t.file('notes', `${BOOKMARK}.md`), 'utf8');
  assert.match(text, /status: "resolved"/);
  assert.match(text, /Body text/);
  await t.send({ type: 'setStatus', noteId: BOOKMARK, status: 'bogus' });
  assert.match(fs.readFileSync(t.file('notes', `${BOOKMARK}.md`), 'utf8'), /status: "resolved"/);
});

test('an emptied note is kept while it has replies', async () => {
  const t = await setup();
  await t.send({ type: 'save', bookmarkId: BOOKMARK, noteId: BOOKMARK, body: 'Text', status: 'open' });
  await t.send({ type: 'saveReply', bookmarkId: BOOKMARK, noteId: BOOKMARK, body: 'A reply' });
  await t.send({ type: 'save', bookmarkId: BOOKMARK, noteId: BOOKMARK, body: '', status: 'open' });
  assert.ok(fs.existsSync(t.file('notes', `${BOOKMARK}.md`)));
});

test("someone else's reply can't be edited or deleted", async () => {
  const t = await setup();
  await t.send({ type: 'save', bookmarkId: BOOKMARK, noteId: BOOKMARK, body: 'Text', status: 'open' });
  const replyId = '20261119T101500Z-zzzz';
  fs.mkdirSync(t.file('replies', BOOKMARK), { recursive: true });
  const other = '---\nauthor: "Someone Else"\ncreated: "2026-11-19T10:15:00Z"\nupdated: "2026-11-19T10:15:00Z"\n---\n\nOriginal\n';
  fs.writeFileSync(t.file('replies', BOOKMARK, `${replyId}.md`), other);

  await t.send({ type: 'saveReply', bookmarkId: BOOKMARK, noteId: BOOKMARK, replyId, body: 'Changed' });
  assert.match(t.last('replyError').error, /Only Someone Else can change this reply/);
  await t.send({ type: 'deleteReply', bookmarkId: BOOKMARK, noteId: BOOKMARK, replyId });
  assert.equal(fs.readFileSync(t.file('replies', BOOKMARK, `${replyId}.md`), 'utf8'), other);
});

test('own reply: editing to empty removes it', async () => {
  const t = await setup();
  await t.send({ type: 'save', bookmarkId: BOOKMARK, noteId: BOOKMARK, body: 'Text', status: 'open' });
  await t.send({ type: 'saveReply', bookmarkId: BOOKMARK, noteId: BOOKMARK, body: 'Mine' });
  const [file] = fs.readdirSync(t.file('replies', BOOKMARK));
  await t.send({ type: 'saveReply', bookmarkId: BOOKMARK, noteId: BOOKMARK, replyId: file.replace(/\.md$/, ''), body: '   ' });
  assert.ok(!fs.existsSync(t.file('replies', BOOKMARK)));
});

test('openImage opens files under .review/assets only', async () => {
  const t = await setup();
  const shot = await pasteImage(t);
  await t.send({ type: 'openImage', src: shot });
  assert.equal(vscode.mock.opened.length, 1);
  assert.ok(vscode.mock.opened[0].fsPath.startsWith(t.file('assets', BOOKMARK)));

  const base = shot.slice(0, shot.indexOf('/assets/') + '/assets/'.length);
  assert.equal(t.last('notice').text, 'Opened in the image viewer');
  for (const bad of [
    `${base}${BOOKMARK}/../../../secret.png`,
    `${base}${BOOKMARK}/..%5C..%5Csecret.png`,
    `${base}../notes/${BOOKMARK}.md`,
    `${base}${BOOKMARK}/evil.exe`,
    `${base}${BOOKMARK}/missing.png`,
    'https://example.com/x.png',
    '%E0%A4%A',
  ]) {
    await t.send({ type: 'openImage', src: bad });
  }
  assert.equal(vscode.mock.opened.length, 1, 'no other file was opened');
  assert.equal(t.last('notice').text, 'Screenshot file not found');
});

test('deleting a note removes its replies and screenshots', async () => {
  const t = await setup();
  const shot = await pasteImage(t);
  await t.send({ type: 'save', bookmarkId: BOOKMARK, noteId: BOOKMARK, body: `![a](${shot})`, status: 'open' });
  await t.send({ type: 'saveReply', bookmarkId: BOOKMARK, noteId: BOOKMARK, body: 'Reply' });
  await t.send({ type: 'deleteNote', noteId: BOOKMARK });
  for (const p of [t.file('notes', `${BOOKMARK}.md`), t.file('replies', BOOKMARK), t.file('assets', BOOKMARK)]) {
    assert.ok(!fs.existsSync(p), `${p} removed`);
  }
});

/** Removes a bookmark from Studio's file, as deleting it in Studio does, and refreshes. */
async function deleteBookmark(t, id) {
  const file = path.join(t.root, '.project', 'bookmarks.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  for (const key of Object.keys(json.Value)) json.Value[key] = json.Value[key].filter((b) => b.Id !== id);
  fs.writeFileSync(file, JSON.stringify(json));
  await t.controller.refresh();
}

test('a note whose bookmark was deleted can be deleted without a host dialog', async () => {
  const t = await setup();
  await t.send({ type: 'save', bookmarkId: BOOKMARK, noteId: BOOKMARK, body: 'Fix this', status: 'resolved' });
  await deleteBookmark(t, BOOKMARK);
  assert.deepEqual(t.last('state').orphans.map((o) => o.noteId), [BOOKMARK]);

  vscode.mock.messages = [];
  await t.send({ type: 'deleteNote', noteId: BOOKMARK });
  assert.ok(!fs.existsSync(t.file('notes', `${BOOKMARK}.md`)));
  assert.equal(t.last('state').orphans.length, 0);
  assert.deepEqual(vscode.mock.messages, [], 'no host dialog');
});

test('Delete all removes only the notes without a bookmark', async () => {
  const t = await setup();
  const other = 'cb869369-1453-41dc-8a14-a4c93fb9250f';
  const kept = 'd52f3772-4097-4d10-b889-001015f31f64';
  for (const id of [BOOKMARK, other, kept]) {
    await t.send({ type: 'save', bookmarkId: id, noteId: id, body: `Note ${id}`, status: 'open' });
  }
  await t.send({ type: 'saveReply', bookmarkId: BOOKMARK, noteId: BOOKMARK, body: 'Reply' });
  await deleteBookmark(t, BOOKMARK);
  await deleteBookmark(t, other);
  assert.equal(t.last('state').orphans.length, 2);

  await t.send({ type: 'deleteOrphans', noteIds: t.last('state').orphans.map((o) => o.noteId) });
  assert.ok(!fs.existsSync(t.file('notes', `${BOOKMARK}.md`)));
  assert.ok(!fs.existsSync(t.file('replies', BOOKMARK)));
  assert.ok(!fs.existsSync(t.file('notes', `${other}.md`)));
  assert.ok(fs.existsSync(t.file('notes', `${kept}.md`)), 'the note with a bookmark is kept');
  assert.equal(t.last('state').orphans.length, 0);
});

test('hiding notes without a bookmark is a user setting, with extension storage as fallback', async () => {
  const t = await setup();
  await t.send({ type: 'ready' });
  assert.equal(t.last('state').hideOrphans, false);
  await t.send({ type: 'setHideOrphans', value: true });
  assert.equal(vscode.mock.settings['bookmarksReview.hideNotesWithoutBookmark'], true);
  assert.equal(t.last('state').hideOrphans, true);

  vscode.mock.settingsReadOnly = true;
  await t.send({ type: 'setHideOrphans', value: false });
  assert.equal(t.last('state').hideOrphans, false, 'kept in extension storage when the setting cannot be saved');
});

test('wrap up: exports a zip with summary, report and .review/, then removes resolved notes', async () => {
  const t = await setup();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bookmarks-review-archive-'));
  await t.globalState.update('archiveFolder', out);
  const resolved = 'cb869369-1453-41dc-8a14-a4c93fb9250f';
  const shot = await pasteImage(t);
  await t.send({ type: 'save', bookmarkId: BOOKMARK, noteId: BOOKMARK, body: `Look ![s](${shot})`, status: 'open' });
  await t.send({ type: 'saveReply', bookmarkId: BOOKMARK, noteId: BOOKMARK, body: 'On it' });
  await t.send({ type: 'save', bookmarkId: resolved, noteId: resolved, body: 'Done point', status: 'resolved' });

  await t.send({ type: 'exportArchive', remove: 'closed' });
  const done = t.last('archived');
  assert.ok(done, JSON.stringify(t.last('archiveError')));
  assert.equal(path.dirname(done.file), out);
  assert.match(path.basename(done.file), /-review-\d{4}-\d\d-\d\d-\d{4}\.zip$/);
  assert.deepEqual([done.removed, done.kept], [1, 1]);

  const files = unzip(fs.readFileSync(done.file));
  const names = Object.keys(files);
  for (const n of ['summary.md', 'report.html', 'studio-bookmarks.json', `.review/notes/${BOOKMARK}.md`, `.review/notes/${resolved}.md`]) {
    assert.ok(names.includes(n), `${n} in ${names.join(', ')}`);
  }
  assert.ok(names.some((n) => n.startsWith(`.review/replies/${BOOKMARK}/`)));
  const png = names.find((n) => n.startsWith(`.review/assets/${BOOKMARK}/`));
  assert.ok(png);
  const report = files['report.html'].toString();
  assert.match(report, /data:image\/png;base64,/, 'screenshot embedded in report.html');
  assert.match(report, /On it/);
  assert.ok(files['summary.md'].toString().includes(`](.review/${png.slice('.review/'.length)})`));

  // The resolved note is gone from the project, the open one and its files are kept.
  assert.ok(!fs.existsSync(t.file('notes', `${resolved}.md`)));
  assert.ok(fs.existsSync(t.file('notes', `${BOOKMARK}.md`)));
  assert.ok(fs.existsSync(path.join(t.root, '.review', png.slice('.review/'.length))));

  // A second export the same minute gets its own file name.
  await t.send({ type: 'exportArchive', remove: 'none' });
  assert.notEqual(t.last('archived').file, done.file);
});

test('wrap up: nothing is removed when the archive cannot be written', async () => {
  const t = await setup();
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bookmarks-review-archive-')), 'a-file');
  fs.writeFileSync(blocker, 'not a folder');
  await t.globalState.update('archiveFolder', blocker);
  await t.send({ type: 'save', bookmarkId: BOOKMARK, noteId: BOOKMARK, body: 'Point', status: 'resolved' });
  await t.send({ type: 'exportArchive', remove: 'all' });
  assert.match(t.last('archiveError')?.error ?? '', /Could not write the review archive .* No notes were removed/);
  assert.ok(fs.existsSync(t.file('notes', `${BOOKMARK}.md`)));
});

test('wrap up: an unknown removal mode is ignored', async () => {
  const t = await setup();
  await t.send({ type: 'save', bookmarkId: BOOKMARK, noteId: BOOKMARK, body: 'Point', status: 'resolved' });
  await t.send({ type: 'exportArchive', remove: 'everything' });
  assert.ok(!t.last('archived') && !t.last('archiveError'));
});

test('wrap up: Studio bookmarks are untouched unless removeBookmarksOnWrapUp is on', async () => {
  const t = await setup();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bookmarks-review-archive-'));
  await t.globalState.update('archiveFolder', out);
  const bookmarksFile = path.join(t.root, '.project', 'bookmarks.json');
  const before = fs.readFileSync(bookmarksFile);
  const resolved = 'cb869369-1453-41dc-8a14-a4c93fb9250f';
  await t.send({ type: 'save', bookmarkId: BOOKMARK, noteId: BOOKMARK, body: 'Still open', status: 'open' });
  await t.send({ type: 'save', bookmarkId: resolved, noteId: resolved, body: 'Done', status: 'resolved' });

  await t.send({ type: 'exportArchive', remove: 'none' });
  assert.equal(t.last('archived').removedBookmarks, 0);
  assert.ok(fs.readFileSync(bookmarksFile).equals(before), 'setting off: bookmarks.json byte-identical');

  await t.send({ type: 'setRemoveBookmarks', value: true });
  assert.equal(vscode.mock.settings['bookmarksReview.removeBookmarksOnWrapUp'], true);
  assert.equal(t.last('wrapUpInfo').removeBookmarks, true);

  await t.send({ type: 'exportArchive', remove: 'closed' });
  const done = t.last('archived');
  assert.equal(done.removedBookmarks, 2, 'the resolved note\'s bookmark and the one without a note');
  const left = JSON.parse(fs.readFileSync(bookmarksFile, 'utf8'));
  const leftIds = Object.values(left.Value).flat().map((b) => b.Id);
  assert.deepEqual(leftIds, [BOOKMARK], 'the open note keeps its bookmark');
  const archived = JSON.parse(unzip(fs.readFileSync(done.file))['studio-bookmarks.json'].toString());
  assert.equal(Object.values(archived.Value).flat().length, 3, 'the archive has all bookmarks from before');
});

test('settings: Delete all notes keeps Studio bookmarks; with bookmarks it clears them too', async () => {
  const t = await setup();
  const other = 'cb869369-1453-41dc-8a14-a4c93fb9250f';
  const bookmarksFile = path.join(t.root, '.project', 'bookmarks.json');
  const before = fs.readFileSync(bookmarksFile);
  const shot = await pasteImage(t);
  await t.send({ type: 'save', bookmarkId: BOOKMARK, noteId: BOOKMARK, body: `A ![s](${shot})`, status: 'open' });
  await t.send({ type: 'saveReply', bookmarkId: BOOKMARK, noteId: BOOKMARK, body: 'Reply' });
  await t.send({ type: 'save', bookmarkId: other, noteId: other, body: 'B', status: 'resolved' });

  await t.send({ type: 'deleteAll', withBookmarks: false, noteIds: [BOOKMARK, other] });
  assert.deepEqual(t.last('allDeleted'), { type: 'allDeleted', notes: 2, bookmarks: 0, withBookmarks: false });
  for (const dir of ['notes', 'replies', 'assets']) {
    const left = fs.existsSync(t.file(dir)) ? fs.readdirSync(t.file(dir)) : [];
    assert.deepEqual(left, [], `.review/${dir} is empty`);
  }
  assert.ok(fs.readFileSync(bookmarksFile).equals(before), 'bookmarks.json untouched');

  await t.send({ type: 'save', bookmarkId: other, noteId: other, body: 'Again', status: 'open' });
  const allBookmarks = t.last('state').workflows.flatMap((w) => w.bookmarks.map((b) => b.id));
  await t.send({ type: 'deleteAll', withBookmarks: true, noteIds: [other], bookmarkIds: allBookmarks });
  assert.deepEqual(t.last('allDeleted'), { type: 'allDeleted', notes: 1, bookmarks: 3, withBookmarks: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(bookmarksFile, 'utf8')).Value, {});
  assert.equal(t.last('state').workflows.length, 0);
});

test('settings: the Settings view gets and changes both settings', async () => {
  const t = await setup();
  await t.send({ type: 'settingsInfo' });
  assert.deepEqual(t.last('settingsInfo'), { type: 'settingsInfo', hideOrphans: false, removeBookmarks: false });
  await t.send({ type: 'setRemoveBookmarks', value: true });
  await t.send({ type: 'setHideOrphans', value: true });
  assert.deepEqual(t.last('settingsInfo'), { type: 'settingsInfo', hideOrphans: true, removeBookmarks: true });
});

test('review fix: Delete all deletes only the notes that were confirmed', async () => {
  const t = await setup();
  const other = 'cb869369-1453-41dc-8a14-a4c93fb9250f';
  const third = 'd52f3772-4097-4d10-b889-001015f31f64';
  for (const id of [BOOKMARK, other, third]) await t.send({ type: 'save', bookmarkId: id, noteId: id, body: `N ${id}`, status: 'open' });
  for (const id of [BOOKMARK, other]) await deleteBookmark(t, id);
  // "This workflow only": the panel confirmed just one of the two orphans.
  await t.send({ type: 'deleteOrphans', noteIds: [BOOKMARK] });
  assert.ok(!fs.existsSync(t.file('notes', `${BOOKMARK}.md`)));
  assert.ok(fs.existsSync(t.file('notes', `${other}.md`)), 'the orphan that was not shown is kept');
  // An id that is not an orphan is ignored.
  await t.send({ type: 'deleteOrphans', noteIds: [third, 'not-a-guid'] });
  assert.ok(fs.existsSync(t.file('notes', `${third}.md`)));

  // Settings: a note added after the confirmation stays, and only confirmed bookmarks go.
  await t.send({ type: 'deleteAll', withBookmarks: true, noteIds: [other], bookmarkIds: [third] });
  assert.deepEqual(t.last('allDeleted'), { type: 'allDeleted', notes: 1, bookmarks: 1, withBookmarks: true });
  assert.ok(fs.existsSync(t.file('notes', `${third}.md`)), 'unconfirmed note kept');
  const left = Object.values(JSON.parse(fs.readFileSync(path.join(t.root, '.project', 'bookmarks.json'), 'utf8')).Value).flat();
  assert.deepEqual(left.map((b) => b.Id), [], 'the other bookmarks were already deleted in Studio');
});

test('review fix: wrap-up keeps a note that changed during the export', async () => {
  const t = await setup();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bookmarks-review-archive-'));
  await t.globalState.update('archiveFolder', out);
  const other = 'cb869369-1453-41dc-8a14-a4c93fb9250f';
  await t.send({ type: 'save', bookmarkId: BOOKMARK, noteId: BOOKMARK, body: 'Resolved one', status: 'resolved' });
  await t.send({ type: 'save', bookmarkId: other, noteId: other, body: 'Resolved two', status: 'resolved' });
  // While the report renders, someone changes one note (e.g. git pull).
  t.hooks.beforeRender = async () => {
    const f = t.file('notes', `${BOOKMARK}.md`);
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('Resolved one', 'Reopened with new findings'));
  };
  await t.send({ type: 'exportArchive', remove: 'closed' });
  const done = t.last('archived');
  assert.deepEqual([done.removed, done.changed], [1, 1]);
  assert.match(fs.readFileSync(t.file('notes', `${BOOKMARK}.md`), 'utf8'), /Reopened with new findings/, 'changed note kept');
  assert.ok(!fs.existsSync(t.file('notes', `${other}.md`)), 'unchanged note removed');
  const archived = unzip(fs.readFileSync(done.file))[`.review/notes/${BOOKMARK}.md`].toString();
  assert.match(archived, /Resolved one/, 'the archive holds the version read at export');
});

test('review fix: an autosave in flight does not delete a just-pasted screenshot', async () => {
  const t = await setup();
  await t.send({ type: 'save', bookmarkId: BOOKMARK, noteId: BOOKMARK, body: 'Text', status: 'open' });
  const shot = await pasteImage(t);
  const fileName = shot.split('/').pop();
  const onDisk = () => fs.existsSync(t.file('assets', BOOKMARK, fileName));
  // The autosave that was captured before the link was inserted arrives after the image is written.
  await t.send({ type: 'save', bookmarkId: BOOKMARK, noteId: BOOKMARK, body: 'Text, typing on', status: 'open' });
  assert.ok(onDisk(), 'fresh screenshot survives the stale autosave');
  await t.send({ type: 'save', bookmarkId: BOOKMARK, noteId: BOOKMARK, body: `Text ![s](${shot})`, status: 'open' });
  assert.ok(onDisk());
  // Once a saved text has linked it, removing the link removes the file as before.
  await t.send({ type: 'save', bookmarkId: BOOKMARK, noteId: BOOKMARK, body: 'Text', status: 'open' });
  assert.ok(!onDisk(), 'unlinked after being saved: cleaned up');

  // Discarding a draft still removes a fresh screenshot right away.
  const draftShot = (await pasteImage(t)).split('/').pop();
  await t.send({ type: 'discardDraft', noteId: BOOKMARK });
  assert.ok(!fs.existsSync(t.file('assets', BOOKMARK, draftShot)));
});

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
  const context = { subscriptions: [], extensionUri: vscode.Uri.file(path.join(__dirname, '..')) };
  activate(context);
  const controller = vscode.mock.providers.get('bookmarksReview.view');
  await controller.ready;

  const posted = [];
  let handler;
  const webview = {
    cspSource: 'mock',
    options: {},
    html: '',
    asWebviewUri: (u) => ({ toString: () => `https://wv/${u.fsPath.replace(/\\/g, '/')}` }),
    postMessage: (m) => posted.push(m),
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
  return { root, controller, posted, send, last, file };
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
  vscode.mock.warningAnswer = 'Delete';
  await t.send({ type: 'deleteReply', bookmarkId: BOOKMARK, noteId: BOOKMARK, replyId });
  assert.equal(fs.readFileSync(t.file('replies', BOOKMARK, `${replyId}.md`), 'utf8'), other);
  vscode.mock.warningAnswer = undefined;
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
  vscode.mock.warningAnswer = 'Delete';
  await t.send({ type: 'deleteNote', noteId: BOOKMARK });
  vscode.mock.warningAnswer = undefined;
  for (const p of [t.file('notes', `${BOOKMARK}.md`), t.file('replies', BOOKMARK), t.file('assets', BOOKMARK)]) {
    assert.ok(!fs.existsSync(p), `${p} removed`);
  }
});

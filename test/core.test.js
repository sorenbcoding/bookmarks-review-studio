const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseBookmarks } = require('../src/core/bookmarks');
const { serializeNote, parseNote, isValidId, isValidReplyId, newReplyId, isAssetReferenced, countImages, excerpt } = require('../src/core/noteFile');
const { reconcile } = require('../src/core/reconcile');

const sample = fs.readFileSync(path.join(__dirname, 'fixtures', 'bookmarks.json'), 'utf8');

test('parses the real Studio sample', () => {
  const list = parseBookmarks(sample);
  assert.equal(list.length, 3);
  const api = list.find((b) => b.activityIdRef === 'If_13');
  assert.equal(api.file, 'Orders/API/Get orders from API.xaml');
  assert.equal(api.id, 'c7311c1d-903e-4b37-af5e-f02ec9413a1b');
  assert.match(api.annotation, /bør ændres/);
  const empty = list.find((b) => b.activityIdRef === 'WriteRange_1');
  assert.equal(empty.annotation, null);
  assert.equal(empty.file, 'testSandbox.xaml');
});

test('skips transient bookmarks, tolerates BOM and missing Value', () => {
  const text = '﻿' + JSON.stringify({ Value: { 'a.xaml': [{ Id: 'x', IsTransient: true }, { Id: 'y', ActivityIdRef: 'A_1' }] } });
  assert.deepEqual(parseBookmarks(text).map((b) => b.id), ['y']);
  assert.deepEqual(parseBookmarks('{}'), []);
});

test('note file round-trips meta and body, including Danish text and quotes', () => {
  const meta = {
    bookmarkId: 'c7311c1d-903e-4b37-af5e-f02ec9413a1b',
    workflow: 'Orders/API/Get orders from API.xaml',
    activityIdRef: 'If_13',
    activityName: 'Matcher "antal" – æøå?',
    status: 'open',
    author: 'Søren',
  };
  const body = '**Bør** ændres:\n\n- punkt\n\n![screenshot](../assets/c7311c1d-903e-4b37-af5e-f02ec9413a1b/1.png)';
  const parsed = parseNote(serializeNote(meta, body));
  assert.deepEqual(parsed.meta, meta);
  assert.equal(parsed.body, body);
});

test('note parsing tolerates CRLF and files without front matter', () => {
  const crlf = serializeNote({ status: 'resolved' }, 'line').replace(/\n/g, '\r\n');
  assert.equal(parseNote(crlf).meta.status, 'resolved');
  assert.deepEqual(parseNote('just text'), { meta: {}, body: 'just text' });
});

test('id validation blocks path tricks', () => {
  assert.ok(isValidId('c7311c1d-903e-4b37-af5e-f02ec9413a1b'));
  assert.ok(!isValidId('../../etc'));
  assert.ok(!isValidId('c7311c1d-903e-4b37-af5e-f02ec9413a1b/../x'));
});

test('reply ids are chronological, valid and reject path tricks', () => {
  const a = newReplyId(new Date('2026-11-19T10:15:00.123Z'), () => 0);
  const b = newReplyId(new Date('2026-11-19T10:16:00.000Z'), () => 0.99);
  assert.equal(a, '20261119T101500Z-0000');
  assert.ok(isValidReplyId(a) && isValidReplyId(b));
  assert.ok([b, a].sort()[0] === a);
  assert.ok(!isValidReplyId('../x'));
  assert.ok(!isValidReplyId('20261119T101500Z-0000.md'));
});

test('replies round-trip through the note format', () => {
  const meta = { author: 'Developer', created: '2026-11-19T10:15:00.000Z', updated: '2026-11-19T10:15:00.000Z' };
  const parsed = parseNote(serializeNote(meta, 'Fixed in **abc123**'));
  assert.deepEqual(parsed.meta, meta);
  assert.equal(parsed.body, 'Fixed in **abc123**');
});

test('asset references are found from the note and from replies (different relative depths)', () => {
  const id = 'c7311c1d-903e-4b37-af5e-f02ec9413a1b';
  const note = `![s](../assets/${id}/a.png)`;
  const reply = `![s](../../assets/${id}/b.png)`;
  assert.ok(isAssetReferenced(id, 'a.png', [note, reply]));
  assert.ok(isAssetReferenced(id, 'b.png', [note, reply]));
  assert.ok(!isAssetReferenced(id, 'c.png', [note, reply]));
  assert.ok(!isAssetReferenced(id, 'a.png', [reply]));
});

test('countImages and excerpt', () => {
  assert.equal(countImages('a ![x](1.png) b ![](2.png)'), 2);
  assert.equal(excerpt('# Title\n\n**bold** [link](http://x) ![i](a.png)'), 'Title bold link');
});

const bm = (id, file, ref, name = ref) => ({ id, file, activityIdRef: ref, activityName: name, annotation: null, isEnabled: true });
const note = (noteId, meta) => ({ meta: { noteId, ...meta }, body: 'x' });

test('reconcile: matches by bookmark id and refreshes hints after a workflow rename', () => {
  const bookmarks = [bm('b1', 'testSandbox.xaml', 'WriteRange_1')];
  const notes = [note('b1', { bookmarkId: 'b1', workflow: 'Sandbox.xaml', activityIdRef: 'WriteRange_1', activityName: 'WriteRange_1' })];
  const r = reconcile(bookmarks, notes);
  assert.equal(r.attached.get('b1'), notes[0]);
  assert.deepEqual(r.updates, [{ note: notes[0], changes: { workflow: 'testSandbox.xaml' }, relinked: false }]);
  assert.equal(r.orphans.length, 0);
});

test('reconcile: re-attaches a note when the bookmark was deleted and re-added', () => {
  const bookmarks = [bm('new', 'testSandbox.xaml', 'MultipleAssign_1')];
  const notes = [note('old', { bookmarkId: 'old', workflow: 'testSandbox.xaml', activityIdRef: 'MultipleAssign_1', activityName: 'MultipleAssign_1' })];
  const r = reconcile(bookmarks, notes);
  assert.equal(r.attached.get('new'), notes[0]);
  assert.equal(r.updates[0].relinked, true);
  assert.equal(r.updates[0].changes.bookmarkId, 'new');
});

test('reconcile: same ActivityIdRef in another workflow is not a match', () => {
  const bookmarks = [bm('new', 'Other.xaml', 'MultipleAssign_1')];
  const notes = [note('old', { bookmarkId: 'old', workflow: 'testSandbox.xaml', activityIdRef: 'MultipleAssign_1' })];
  const r = reconcile(bookmarks, notes);
  assert.equal(r.attached.size, 0);
  assert.equal(r.orphans.length, 1);
});

test('reconcile: a bookmark that already has a note does not take an orphan', () => {
  const bookmarks = [bm('b1', 'a.xaml', 'If_1')];
  const notes = [
    note('b1', { bookmarkId: 'b1', workflow: 'a.xaml', activityIdRef: 'If_1', activityName: 'If_1', created: '2026-01-02' }),
    note('old', { bookmarkId: 'gone', workflow: 'a.xaml', activityIdRef: 'If_1', activityName: 'If_1', created: '2026-01-01' }),
  ];
  const r = reconcile(bookmarks, notes);
  assert.equal(r.attached.get('b1').meta.noteId, 'b1');
  assert.deepEqual(r.orphans.map((n) => n.meta.noteId), ['old']);
});

test('removeBookmarks: keeps listed and transient bookmarks, drops empty workflows, Studio format', () => {
  const { removeBookmarks } = require('../src/core/bookmarks');
  const keep = new Set(['cb869369-1453-41dc-8a14-a4c93fb9250f']);
  const { text, removed } = removeBookmarks(sample, keep);
  assert.equal(removed, 2);
  const ids = parseBookmarks(text).map((b) => b.id);
  assert.deepEqual(ids, ['cb869369-1453-41dc-8a14-a4c93fb9250f']);
  assert.equal(Object.keys(JSON.parse(text).Value).length, 1, 'workflow without bookmarks dropped');
  assert.ok(text.includes('\r\n  "Value": {\r\n'), '2-space indent, CRLF');
  assert.ok(!/[^\r]\n/.test(text), 'no bare LF');

  const bom = '﻿' + JSON.stringify({ Value: { 'a.xaml': [{ Id: 'x', IsTransient: true }, { Id: 'y' }] } });
  const out = removeBookmarks(bom, new Set());
  assert.equal(out.removed, 1);
  assert.ok(out.text.startsWith('﻿'), 'BOM kept');
  assert.deepEqual(JSON.parse(out.text.slice(1)).Value['a.xaml'], [{ Id: 'x', IsTransient: true }]);

  const none = removeBookmarks(sample, new Set(parseBookmarks(sample).map((b) => b.id)));
  assert.deepEqual(none, { text: sample, removed: 0 }, 'nothing to remove: file text unchanged');
});

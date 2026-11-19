const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const archive = require('../src/core/archive');
const { createZip, crc32 } = require('../src/core/zip');

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
const C = 'cccccccc-3333-4333-8333-333333333333';

function sample() {
  const note = (noteId, status, body, extra = {}) => ({
    meta: { noteId, status, author: 'Reviewer', created: '2026-11-19T10:00:00Z', updated: '2026-11-19T10:00:00Z', ...extra },
    body,
  });
  const bookmarks = [
    { id: A, file: 'Main.xaml', activityName: 'Assign total', annotation: 'Check <this>' },
    { id: B, file: 'Sub/Read.xaml', activityName: 'Read Range', annotation: null },
  ];
  const attached = new Map([
    [A, note(A, 'open', `Look here\n\n![shot](../assets/${A}/1.png)`)],
    [B, note(B, 'resolved', 'Fixed?')],
  ]);
  const orphans = [note(C, 'wontfix', 'Old point', { workflow: 'Main.xaml', activityName: 'Gone' })];
  const replies = new Map([
    [A, [{ id: '20261119T110000Z-abcd', meta: { author: 'Dev', created: '2026-11-19T11:00:00Z', updated: '2026-11-19T11:05:00Z' }, body: `Done ![r](../../assets/${A}/2.png)` }]],
  ]);
  return archive.collectEntries({ bookmarks, attached, orphans, replies });
}

test('zip: CRC-32 check value and a well-formed archive', () => {
  assert.equal(crc32(Buffer.from('123456789')).toString(16), 'cbf43926');
  const zip = createZip([{ name: 'a.txt', data: 'hello hello hello hello' }, { name: 'dir/ø.bin', data: Buffer.from([1, 2, 3]) }]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  assert.equal(zip.readUInt16LE(end + 10), 2);
  // First entry: deflated, and inflates back to the input.
  const nameLength = zip.readUInt16LE(26);
  const size = zip.readUInt32LE(18);
  assert.equal(zip.readUInt16LE(8), 8);
  const data = zlib.inflateRawSync(zip.subarray(30 + nameLength, 30 + nameLength + size));
  assert.equal(data.toString(), 'hello hello hello hello');
  assert.throws(() => createZip([{ name: '../evil', data: '' }]), /Invalid name/);
});

test('archive: notes grouped by workflow, orphans last in their workflow', () => {
  const groups = sample();
  assert.deepEqual(groups.map((g) => g.workflow), ['Main.xaml', 'Sub/Read.xaml']);
  assert.deepEqual(groups[0].entries.map((e) => [e.note.meta.noteId, e.orphan]), [[A, false], [C, true]]);
  assert.deepEqual(archive.counts(groups), { notes: 3, open: 1, resolved: 1, wontfix: 1, replies: 1 });
});

test('archive: summary.md links screenshots from the archive root', () => {
  const md = archive.buildSummary({ projectName: 'Proj', exportedAt: '2026-11-19T12:00:00Z', author: 'Me', groups: sample() });
  assert.match(md, /^# Review of Proj/);
  assert.match(md, /3 notes: 1 open, 1 resolved, 1 won't fix\. 1 reply\./);
  assert.match(md, /### Assign total — Open/);
  assert.match(md, /> Check <this>/);
  assert.ok(md.includes(`](.review/assets/${A}/1.png)`));
  assert.ok(md.includes(`](.review/assets/${A}/2.png)`), 'reply screenshot links too');
  assert.ok(!md.includes('../assets/'));
  assert.match(md, /The bookmark was deleted in Studio/);
  assert.match(md, /\(edited\)/);
});

test('archive: report.html escapes text, embeds screenshots and falls back to plain text', () => {
  const groups = sample();
  const sections = archive.renderSections(groups);
  assert.deepEqual(sections.map((s) => s.id), [`note:${A}`, `reply:${A}:20261119T110000Z-abcd`, `note:${C}`, `note:${B}`]);
  const rendered = { [`note:${A}`]: `<p>Look here</p><p><img src=".review/assets/${A}/1.png" alt="shot"></p>` };
  const readAsset = (noteId, file) => (noteId === A && file === '1.png' ? Buffer.from('PNG') : null);
  const html = archive.buildReportHtml({ projectName: 'P<x>', exportedAt: '2026-11-19T12:00:00Z', author: 'Me', groups, rendered, css: 'body{}', readAsset });
  assert.match(html, /<title>Review of P&lt;x&gt;<\/title>/);
  assert.match(html, /Check &lt;this&gt;/);
  assert.ok(html.includes(`src="data:image/png;base64,${Buffer.from('PNG').toString('base64')}"`));
  assert.match(html, /<pre class="raw">Fixed\?<\/pre>/, 'unrendered body shown as plain text');
  assert.match(html, /<span class="badge wontfix">Won&#39;t fix<\/span>/);
});

test('archive: embedImages ignores anything outside .review/assets/<noteId>/', () => {
  const read = () => Buffer.from('x');
  for (const src of ['../secret.png', `.review/assets/${A}/../../x.png`, 'https://example.com/a.png', `.review/notes/${A}.md`]) {
    const html = `<img src="${src}">`;
    assert.equal(archive.embedImages(html, read), html);
  }
});

test('archive: removal modes and file names', () => {
  const groups = sample();
  assert.deepEqual(archive.notesToRemove(groups, 'closed').sort(), [B, C].sort());
  assert.equal(archive.notesToRemove(groups, 'all').length, 3);
  assert.deepEqual(archive.notesToRemove(groups, 'none'), []);
  const name = archive.archiveName('My: Project?', new Date(2026, 10, 19, 14, 5));
  assert.equal(name, 'My- Project-review-2026-11-19-1405.zip');
});

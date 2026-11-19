// Review note file format: Markdown with a small front matter block (no vscode dependency, unit-tested).
//
//   ---
//   bookmarkId: "c7311c1d-903e-4b37-af5e-f02ec9413a1b"
//   workflow: "Orders/API/Get orders from API.xaml"
//   activityIdRef: "If_13"
//   activityName: "Matcher antal resultater ikke med antal fra orderIds?"
//   status: "open"
//   author: "Jane Doe"
//   created: "2026-11-17T12:00:00.000Z"
//   updated: "2026-11-17T12:05:00.000Z"
//   ---
//   Markdown body, screenshots as ![screenshot](../assets/<noteId>/<file>.png)
//
// Values are JSON strings, which are also valid YAML, so the files read fine on GitHub/Azure DevOps.
// The note id is the file name (.review/notes/<noteId>.md). It is the bookmark id at creation time
// and never changes, even when the note is re-attached to a re-created bookmark.

const FIELDS = ['bookmarkId', 'workflow', 'activityIdRef', 'activityName', 'status', 'author', 'created', 'updated'];
const STATUSES = ['open', 'resolved', 'wontfix'];
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function serializeNote(meta, body) {
  const lines = ['---'];
  for (const key of FIELDS) {
    if (meta[key] !== undefined && meta[key] !== null) lines.push(`${key}: ${JSON.stringify(String(meta[key]))}`);
  }
  lines.push('---', '');
  const text = String(body ?? '').replace(/\r\n/g, '\n').trim();
  return lines.join('\n') + (text ? `${text}\n` : '');
}

function parseNote(text) {
  const normalized = String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) return { meta: {}, body: normalized.trim() };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.replace(/^"|"$/g, '');
      }
    }
    meta[kv[1]] = value;
  }
  return { meta, body: match[2].trim() };
}

/** Number of images referenced in a note body. */
function countImages(body) {
  return (String(body).match(/!\[[^\]]*\]\(/g) ?? []).length;
}

/** Short plain-text preview of a Markdown body. */
function excerpt(body, length = 90) {
  const plain = String(body)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~\-|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > length ? `${plain.slice(0, length - 1)}…` : plain;
}

module.exports = { FIELDS, STATUSES, isValidId, serializeNote, parseNote, countImages, excerpt };

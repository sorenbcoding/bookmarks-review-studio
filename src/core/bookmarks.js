// Parsing of UiPath Studio's .project/bookmarks.json (no vscode dependency, unit-tested).
//
// Format (confirmed from real Studio samples):
// { "Value": { "<project-relative .xaml path, '/' separated>": [
//     { "IsEnabled": true, "Annotation": "text" | null, "Id": "<guid>",
//       "ActivityIdRef": "If_13", "ActivityId": "1.988", "ActivityName": "…", "IsTransient": false } ] } }
//
// Behaviour observed in Studio:
// - Id survives editing the message, disable/enable, moving the activity and renaming the workflow.
// - Deleting and re-adding a bookmark gives a new Id (same workflow + ActivityIdRef).
// - Renaming a workflow rewrites the path key.
// - ActivityId is positional and is not used.

/**
 * @typedef {object} Bookmark
 * @property {string} id
 * @property {string} file            project-relative workflow path
 * @property {string} activityIdRef
 * @property {string} activityName
 * @property {string|null} annotation  Studio's plain-text message
 * @property {boolean} isEnabled
 */

/** @returns {Bookmark[]} */
function parseBookmarks(text) {
  const json = JSON.parse(String(text).replace(/^﻿/, ''));
  const result = [];
  for (const [file, list] of Object.entries(json?.Value ?? {})) {
    if (!Array.isArray(list)) continue;
    for (const b of list) {
      if (!b || typeof b.Id !== 'string' || b.IsTransient === true) continue;
      result.push({
        id: b.Id,
        file,
        activityIdRef: b.ActivityIdRef ?? '',
        activityName: b.ActivityName ?? '',
        annotation: typeof b.Annotation === 'string' && b.Annotation.trim() !== '' ? b.Annotation : null,
        isEnabled: b.IsEnabled !== false,
      });
    }
  }
  return result;
}

/**
 * Removes bookmarks from bookmarks.json text, for wrapping up a review. Keeps the bookmarks in `keepIds`,
 * transient ones and anything that isn't a bookmark entry. A workflow left without bookmarks is dropped.
 * Output follows Studio's format: 2-space JSON with CRLF line endings, BOM only if the input had one.
 * @returns {{ text: string, removed: number }}
 */
function removeBookmarks(text, keepIds) {
  const raw = String(text);
  const bom = raw.startsWith('﻿') ? '﻿' : '';
  const json = JSON.parse(raw.slice(bom.length));
  if (!json || typeof json.Value !== 'object' || json.Value === null) return { text: raw, removed: 0 };
  let removed = 0;
  for (const [file, list] of Object.entries(json.Value)) {
    if (!Array.isArray(list)) continue;
    const kept = list.filter((b) => !b || typeof b.Id !== 'string' || b.IsTransient === true || keepIds.has(b.Id));
    removed += list.length - kept.length;
    if (kept.length) json.Value[file] = kept;
    else delete json.Value[file];
  }
  if (!removed) return { text: raw, removed: 0 };
  return { text: bom + JSON.stringify(json, null, 2).replace(/\n/g, '\r\n'), removed };
}

module.exports = { parseBookmarks, removeBookmarks };

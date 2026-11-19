// Links review notes to Studio bookmarks (no vscode dependency, unit-tested).
//
// 1. A note belongs to the bookmark whose Id equals note.meta.bookmarkId.
// 2. A note whose bookmark is gone is re-attached to a bookmark on the same workflow + ActivityIdRef
//    that has no note yet (Studio gives a new Id when a bookmark is deleted and re-added).
//    ActivityIdRef alone is not unique across workflows (e.g. MultipleAssign_1), so both must match.
// 3. Anything else is an orphan: kept on disk, shown separately, never deleted automatically.
// The workflow/activity hints in the note are refreshed so step 2 keeps working after renames.

/**
 * @param {import('./bookmarks').Bookmark[]} bookmarks
 * @param {{meta: Record<string,string>, body: string}[]} notes  meta.noteId is set from the file name
 * @returns {{ attached: Map<string, object>, updates: {note: object, changes: object, relinked: boolean}[], orphans: object[] }}
 */
function reconcile(bookmarks, notes) {
  const byId = new Map(bookmarks.map((b) => [b.id, b]));
  const attached = new Map();
  const updates = [];
  const unmatched = [];

  // Oldest notes first, so if two notes point at the same bookmark the original wins.
  const sorted = [...notes].sort((a, b) => String(a.meta.created ?? '').localeCompare(String(b.meta.created ?? '')));

  for (const note of sorted) {
    const bookmark = byId.get(note.meta.bookmarkId);
    if (bookmark && !attached.has(bookmark.id)) {
      attached.set(bookmark.id, note);
      const changes = hintChanges(note, bookmark);
      if (changes) updates.push({ note, changes, relinked: false });
    } else {
      unmatched.push(note);
    }
  }

  const orphans = [];
  for (const note of unmatched) {
    const bookmark = bookmarks.find(
      (b) => !attached.has(b.id) && b.file === note.meta.workflow && b.activityIdRef && b.activityIdRef === note.meta.activityIdRef
    );
    if (bookmark) {
      attached.set(bookmark.id, note);
      updates.push({ note, changes: { bookmarkId: bookmark.id, ...hintChanges(note, bookmark) }, relinked: true });
    } else {
      orphans.push(note);
    }
  }

  return { attached, updates, orphans };
}

function hintChanges(note, bookmark) {
  const changes = {};
  if (note.meta.workflow !== bookmark.file) changes.workflow = bookmark.file;
  if (note.meta.activityIdRef !== bookmark.activityIdRef) changes.activityIdRef = bookmark.activityIdRef;
  if (note.meta.activityName !== bookmark.activityName) changes.activityName = bookmark.activityName;
  return Object.keys(changes).length ? changes : null;
}

module.exports = { reconcile };

// File access for Studio's bookmarks.json (read-only) and the .review/ folder (ours).
const vscode = require('vscode');
const { parseBookmarks, removeBookmarks } = require('./core/bookmarks');
const { parseNote, serializeNote, isValidId, isValidReplyId, isAssetReferenced } = require('./core/noteFile');

const nodeFs = require('fs');

const fs = vscode.workspace.fs;
const decode = (bytes) => Buffer.from(bytes).toString('utf8');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Deletes a file or folder (with its contents). Studio's file API is tried first; if the path still exists
 * afterwards, Node's own delete runs with retries. A path that can't be deleted (for example a screenshot
 * locked by another program) throws, unless `bestEffort` is set. A missing path counts as deleted.
 */
async function remove(uri, { bestEffort = false } = {}) {
  try {
    await fs.delete(uri, { recursive: true, useTrash: false });
  } catch {
    // checked below
  }
  if (!nodeFs.existsSync(uri.fsPath)) return true;
  try {
    await nodeFs.promises.rm(uri.fsPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (err) {
    if (bestEffort) return false;
    throw new Error(`Could not delete ${uri.fsPath} — ${err?.code === 'EBUSY' || err?.code === 'EPERM' ? 'the file is in use by another program' : err?.message ?? err}. Close the program and try again.`);
  }
  return !nodeFs.existsSync(uri.fsPath);
}

class BookmarkStore {
  constructor(root) {
    this.root = root;
    this.uri = vscode.Uri.joinPath(root, '.project', 'bookmarks.json');
    /** @type {import('./core/bookmarks').Bookmark[]} */
    this.last = [];
  }

  /** Reads bookmarks.json. Retries briefly because Studio may be mid-write when the watcher fires. */
  async load() {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        this.last = parseBookmarks(decode(await fs.readFile(this.uri)));
        return this.last;
      } catch (err) {
        if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
          this.last = [];
          return this.last;
        }
        await delay(200);
      }
    }
    return this.last;
  }

  /**
   * Removes every bookmark except `keepIds` from Studio's file. The only write to bookmarks.json,
   * used when a review is wrapped up with removeBookmarksOnWrapUp on. @returns {Promise<number>} removed
   */
  async removeAllExcept(keepIds) {
    let text;
    try {
      text = decode(await fs.readFile(this.uri));
    } catch {
      return 0;
    }
    const result = removeBookmarks(text, keepIds);
    if (result.removed) await fs.writeFile(this.uri, Buffer.from(result.text, 'utf8'));
    return result.removed;
  }

  /** Removes only the bookmarks in `ids` (the ones the user confirmed). @returns {Promise<number>} removed */
  async removeOnly(ids) {
    let text;
    try {
      text = decode(await fs.readFile(this.uri));
    } catch {
      return 0;
    }
    const keep = new Set(parseBookmarks(text).map((b) => b.id).filter((id) => !ids.has(id)));
    const result = removeBookmarks(text, keep);
    if (result.removed) await fs.writeFile(this.uri, Buffer.from(result.text, 'utf8'));
    return result.removed;
  }

  watch(onChange) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.root, '.project/bookmarks.json'));
    let timer;
    const fire = () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, 150);
    };
    watcher.onDidChange(fire);
    watcher.onDidCreate(fire);
    watcher.onDidDelete(fire);
    return watcher;
  }
}

class ReviewStore {
  constructor(root) {
    this.root = root;
    this.reviewDir = vscode.Uri.joinPath(root, '.review');
    this.notesDir = vscode.Uri.joinPath(this.reviewDir, 'notes');
    this.assetsDir = vscode.Uri.joinPath(this.reviewDir, 'assets');
    this.repliesDir = vscode.Uri.joinPath(this.reviewDir, 'replies');
    /** Text we last wrote per note or reply file, to tell our own writes from git pulls. Keyed by fsPath. */
    this.lastWritten = new Map();
  }

  isOwnWrite(uri, text) {
    return this.lastWritten.get(uri.fsPath) === text;
  }

  noteUri(noteId) {
    return vscode.Uri.joinPath(this.notesDir, `${noteId}.md`);
  }

  async loadAll() {
    let entries;
    try {
      entries = await fs.readDirectory(this.notesDir);
    } catch {
      return [];
    }
    const ids = entries
      .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.md'))
      .map(([name]) => name.slice(0, -3))
      .filter(isValidId);
    const notes = await Promise.all(ids.map((id) => this.readNote(id)));
    return notes.filter(Boolean);
  }

  /** Every file under .review/, as project-independent paths ('notes/<id>.md', ...). */
  async listFiles(dir = this.reviewDir, prefix = '') {
    let entries;
    try {
      entries = await fs.readDirectory(dir);
    } catch {
      return [];
    }
    const files = [];
    for (const [name, type] of entries) {
      const uri = vscode.Uri.joinPath(dir, name);
      if (type === vscode.FileType.Directory) files.push(...(await this.listFiles(uri, `${prefix}${name}/`)));
      else if (type === vscode.FileType.File) files.push({ path: `${prefix}${name}`, uri });
    }
    return files;
  }

  async exists(uri) {
    try {
      await fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  async readNote(noteId) {
    if (!isValidId(noteId)) return null;
    try {
      const text = decode(await fs.readFile(this.noteUri(noteId)));
      const { meta, body } = parseNote(text);
      meta.noteId = noteId;
      return { meta, body, text };
    } catch {
      return null;
    }
  }

  async writeNote(meta, body) {
    const text = serializeNote(meta, body);
    const uri = this.noteUri(meta.noteId);
    await fs.createDirectory(this.notesDir);
    this.lastWritten.set(uri.fsPath, text);
    await fs.writeFile(uri, Buffer.from(text, 'utf8'));
  }

  /** Deletes a note with its replies and screenshots. */
  async deleteNote(noteId) {
    if (!isValidId(noteId)) return;
    this.lastWritten.delete(this.noteUri(noteId).fsPath);
    // Screenshots and replies first: if one can't be deleted, the note stays and the user can retry.
    await remove(vscode.Uri.joinPath(this.assetsDir, noteId));
    await remove(vscode.Uri.joinPath(this.repliesDir, noteId));
    await remove(this.noteUri(noteId));
  }

  // ---- replies: .review/replies/<noteId>/<replyId>.md, one file per reply (append-only, merge-friendly)

  replyUri(noteId, replyId) {
    return vscode.Uri.joinPath(this.repliesDir, noteId, `${replyId}.md`);
  }

  /** Replies of a note, oldest first. */
  async loadReplies(noteId) {
    if (!isValidId(noteId)) return [];
    let entries;
    try {
      entries = await fs.readDirectory(vscode.Uri.joinPath(this.repliesDir, noteId));
    } catch {
      return [];
    }
    const ids = entries
      .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.md'))
      .map(([name]) => name.slice(0, -3))
      .filter(isValidReplyId)
      .sort();
    const replies = await Promise.all(ids.map((id) => this.readReply(noteId, id)));
    return replies.filter(Boolean);
  }

  async readReply(noteId, replyId) {
    if (!isValidId(noteId) || !isValidReplyId(replyId)) return null;
    try {
      const text = decode(await fs.readFile(this.replyUri(noteId, replyId)));
      const { meta, body } = parseNote(text);
      return { id: replyId, meta, body };
    } catch {
      return null;
    }
  }

  async writeReply(noteId, replyId, meta, body) {
    const text = serializeNote(meta, body);
    const uri = this.replyUri(noteId, replyId);
    await fs.createDirectory(vscode.Uri.joinPath(this.repliesDir, noteId));
    this.lastWritten.set(uri.fsPath, text);
    await fs.writeFile(uri, Buffer.from(text, 'utf8'));
  }

  async deleteReply(noteId, replyId) {
    if (!isValidId(noteId) || !isValidReplyId(replyId)) return;
    const uri = this.replyUri(noteId, replyId);
    this.lastWritten.delete(uri.fsPath);
    await remove(uri);
    const dir = vscode.Uri.joinPath(this.repliesDir, noteId);
    const left = await fs.readDirectory(dir).then((e) => e.length, () => 0);
    if (left === 0) await remove(dir, { bestEffort: true });
  }

  /** Number of replies per note id, for the list. */
  async countReplies() {
    const counts = new Map();
    let dirs;
    try {
      dirs = await fs.readDirectory(this.repliesDir);
    } catch {
      return counts;
    }
    for (const [noteId, type] of dirs) {
      if (type !== vscode.FileType.Directory || !isValidId(noteId)) continue;
      const files = await fs.readDirectory(vscode.Uri.joinPath(this.repliesDir, noteId)).then(undefined, () => []);
      counts.set(noteId, files.filter(([name]) => isValidReplyId(name.replace(/\.md$/, ''))).length);
    }
    return counts;
  }

  /** Saves a screenshot under .review/assets/<noteId>/ and returns its file URI. */
  async saveImage(noteId, buffer, ext) {
    const dir = vscode.Uri.joinPath(this.assetsDir, noteId);
    await fs.createDirectory(dir);
    const uri = vscode.Uri.joinPath(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`);
    await fs.writeFile(uri, buffer);
    return uri;
  }

  /** Deletes screenshots of a note that neither the note body nor any reply still references. */
  /**
   * Every file that belongs to a note (its note file, replies and screenshots), keyed as in listFiles().
   * @returns {Promise<Map<string, Buffer>>}
   */
  async noteFiles(noteId) {
    const files = new Map();
    const read = async (uri, key) => {
      try {
        files.set(key, Buffer.from(await fs.readFile(uri)));
      } catch {
        // gone
      }
    };
    await read(this.noteUri(noteId), `notes/${noteId}.md`);
    for (const f of await this.listFiles(vscode.Uri.joinPath(this.repliesDir, noteId), `replies/${noteId}/`)) await read(f.uri, f.path);
    for (const f of await this.listFiles(vscode.Uri.joinPath(this.assetsDir, noteId), `assets/${noteId}/`)) await read(f.uri, f.path);
    return files;
  }

  /**
   * Files under assets/ and replies/ that belong to no note: folders whose note file is gone (for example
   * a screenshot pasted into a new note that was never saved) and loose files. Keys as in listFiles().
   */
  async strayFiles() {
    const hasNote = new Set((await this.listFiles(this.notesDir, 'notes/')).map((f) => f.path));
    const strays = [];
    for (const [dir, prefix] of [[this.assetsDir, 'assets/'], [this.repliesDir, 'replies/']]) {
      for (const f of await this.listFiles(dir, prefix)) {
        const parts = f.path.split('/');
        if (parts.length !== 3 || !hasNote.has(`notes/${parts[1]}.md`)) strays.push(f);
      }
    }
    return strays;
  }

  /** Deletes the given stray files, then empty folders under .review/ and .review/ itself if empty. */
  async removeStrays(files) {
    for (const f of files) await remove(f.uri);
    await this.pruneEmptyDirs(this.reviewDir);
  }

  /** Removes empty folders below `dir` (and `dir` itself when it ends up empty). @returns {Promise<boolean>} emptied */
  async pruneEmptyDirs(dir) {
    let entries;
    try {
      entries = await fs.readDirectory(dir);
    } catch {
      return false;
    }
    let left = 0;
    for (const [name, type] of entries) {
      if (type === vscode.FileType.Directory && (await this.pruneEmptyDirs(vscode.Uri.joinPath(dir, name)))) continue;
      left++;
    }
    if (left) return false;
    return remove(dir, { bestEffort: true });
  }

  /** Deletes screenshots of a note that no text references, except the file names in `keep`. */
  async cleanupAssets(noteId, texts, keep = new Set()) {
    const dir = vscode.Uri.joinPath(this.assetsDir, noteId);
    let entries;
    try {
      entries = await fs.readDirectory(dir);
    } catch {
      return;
    }
    let kept = 0;
    for (const [name, type] of entries) {
      if (type === vscode.FileType.File && !keep.has(name) && !isAssetReferenced(noteId, name, texts)) {
        await remove(vscode.Uri.joinPath(dir, name), { bestEffort: true });
      } else {
        kept++;
      }
    }
    if (kept === 0) await remove(dir, { bestEffort: true });
  }

  /** Watches note and reply files; onChange gets the changed file's URI. */
  watch(onChange) {
    const watchers = ['.review/notes/*.md', '.review/replies/*/*.md'].map((glob) => {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.root, glob));
      watcher.onDidChange(onChange);
      watcher.onDidCreate(onChange);
      watcher.onDidDelete(onChange);
      return watcher;
    });
    return vscode.Disposable.from(...watchers);
  }
}

module.exports = { BookmarkStore, ReviewStore };

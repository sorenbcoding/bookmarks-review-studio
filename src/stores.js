// File access for Studio's bookmarks.json (read-only) and the .review/ folder (ours).
const vscode = require('vscode');
const { parseBookmarks } = require('./core/bookmarks');
const { parseNote, serializeNote, isValidId, isValidReplyId, isAssetReferenced } = require('./core/noteFile');

const fs = vscode.workspace.fs;
const decode = (bytes) => Buffer.from(bytes).toString('utf8');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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
    await fs.delete(this.noteUri(noteId)).then(undefined, () => {});
    await fs.delete(vscode.Uri.joinPath(this.repliesDir, noteId), { recursive: true }).then(undefined, () => {});
    await fs.delete(vscode.Uri.joinPath(this.assetsDir, noteId), { recursive: true }).then(undefined, () => {});
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
    await fs.delete(uri).then(undefined, () => {});
    const dir = vscode.Uri.joinPath(this.repliesDir, noteId);
    const left = await fs.readDirectory(dir).then((e) => e.length, () => 0);
    if (left === 0) await fs.delete(dir, { recursive: true }).then(undefined, () => {});
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
  async cleanupAssets(noteId, texts) {
    const dir = vscode.Uri.joinPath(this.assetsDir, noteId);
    let entries;
    try {
      entries = await fs.readDirectory(dir);
    } catch {
      return;
    }
    let kept = 0;
    for (const [name, type] of entries) {
      if (type === vscode.FileType.File && !isAssetReferenced(noteId, name, texts)) {
        await fs.delete(vscode.Uri.joinPath(dir, name)).then(undefined, () => {});
      } else {
        kept++;
      }
    }
    if (kept === 0) await fs.delete(dir, { recursive: true }).then(undefined, () => {});
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

// File access for Studio's bookmarks.json (read-only) and the .review/ folder (ours).
const vscode = require('vscode');
const { parseBookmarks } = require('./core/bookmarks');
const { parseNote, serializeNote, isValidId } = require('./core/noteFile');

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
    /** Text we last wrote per note, to tell our own writes from git pulls. */
    this.lastWritten = new Map();
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
    await fs.createDirectory(this.notesDir);
    this.lastWritten.set(meta.noteId, text);
    await fs.writeFile(this.noteUri(meta.noteId), Buffer.from(text, 'utf8'));
  }

  async deleteNote(noteId) {
    if (!isValidId(noteId)) return;
    this.lastWritten.delete(noteId);
    await fs.delete(this.noteUri(noteId)).then(undefined, () => {});
    await fs.delete(vscode.Uri.joinPath(this.assetsDir, noteId), { recursive: true }).then(undefined, () => {});
  }

  /** Saves a screenshot under .review/assets/<noteId>/ and returns its file URI. */
  async saveImage(noteId, buffer, ext) {
    const dir = vscode.Uri.joinPath(this.assetsDir, noteId);
    await fs.createDirectory(dir);
    const uri = vscode.Uri.joinPath(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`);
    await fs.writeFile(uri, buffer);
    return uri;
  }

  /** Deletes screenshots of a note that its body no longer references. */
  async cleanupAssets(noteId, body) {
    const dir = vscode.Uri.joinPath(this.assetsDir, noteId);
    let entries;
    try {
      entries = await fs.readDirectory(dir);
    } catch {
      return;
    }
    let kept = 0;
    for (const [name, type] of entries) {
      if (type === vscode.FileType.File && !body.includes(`../assets/${noteId}/${name}`)) {
        await fs.delete(vscode.Uri.joinPath(dir, name)).then(undefined, () => {});
      } else {
        kept++;
      }
    }
    if (kept === 0) await fs.delete(dir, { recursive: true }).then(undefined, () => {});
  }

  watch(onChange) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.root, '.review/notes/*.md'));
    watcher.onDidChange(onChange);
    watcher.onDidCreate(onChange);
    watcher.onDidDelete(onChange);
    return watcher;
  }
}

module.exports = { BookmarkStore, ReviewStore };

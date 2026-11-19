// Bookmarks Review: rich review notes (formatting + screenshots) for UiPath Studio bookmarks.
// Studio's .project/bookmarks.json is only read. Notes live in <project>/.review/ and go into Git.
const vscode = require('vscode');
const path = require('path');
const { BookmarkStore, ReviewStore } = require('./stores');
const { reconcile } = require('./core/reconcile');
const { STATUSES, isValidId, isValidReplyId, newReplyId, countImages, excerpt } = require('./core/noteFile');
const { authorName } = require('./git');

const IMAGE_DATA_URL = /^data:image\/(png|jpeg|gif|webp|bmp);base64,([A-Za-z0-9+/=]+)$/;
const IMAGE_FILE = /^[\w.-]+\.(png|jpg|gif|webp|bmp)$/i;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
// Relative path from a file to .review/assets/: notes live one level down, replies two.
const NOTE_ASSETS = '../assets/';
const REPLY_ASSETS = '../../assets/';

/** @type {vscode.OutputChannel} */
let log;

function activate(context) {
  log = vscode.window.createOutputChannel('Bookmarks Review');
  const controller = new ReviewController(context);
  context.subscriptions.push(
    log,
    vscode.window.registerWebviewViewProvider('bookmarksReview.view', controller, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
}

function deactivate() {}

async function findProjectRoot() {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    for (const marker of [['project.json'], ['.project', 'bookmarks.json']]) {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, ...marker));
        return folder.uri;
      } catch {
        // not here
      }
    }
  }
  const hits = await vscode.workspace.findFiles('**/.project/bookmarks.json', '**/node_modules/**', 1);
  return hits.length ? vscode.Uri.file(path.dirname(path.dirname(hits[0].fsPath))) : undefined;
}

class ReviewController {
  constructor(context) {
    this.context = context;
    /** @type {vscode.WebviewView | undefined} */
    this.view = undefined;
    this.bookmarks = [];
    this.attached = new Map();
    this.orphans = [];
    this.notesById = new Map();
    this.queue = Promise.resolve();
    this.ready = this.init().catch((err) => log.appendLine(`Init failed: ${err?.stack ?? err}`));
  }

  async init() {
    this.root = await findProjectRoot();
    if (!this.root) {
      log.appendLine('No UiPath project found in the workspace.');
      return;
    }
    log.appendLine(`Project: ${this.root.fsPath}`);
    this.bookmarkStore = new BookmarkStore(this.root);
    this.reviewStore = new ReviewStore(this.root);
    this.author = await authorName(this.root.fsPath);
    // Studio exposes open workflows as text editors: the active one is the workflow tab in front.
    // It reports workflow switches (incl. Focus on a bookmark in another workflow), but not the selected activity.
    this.activeWorkflow = this.toProjectPath(vscode.window.activeTextEditor?.document.uri);
    this.context.subscriptions.push(
      this.bookmarkStore.watch(() => this.refresh()),
      this.reviewStore.watch((uri) => this.onNoteFileChanged(uri)),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        const file = this.toProjectPath(editor?.document.uri);
        // Ignore "no editor" (e.g. focus moved to a panel in VS Code): keep the last workflow.
        if (!file || file === this.activeWorkflow) return;
        this.activeWorkflow = file;
        this.post({ type: 'activeWorkflow', file });
      })
    );
    await this.refresh();
  }

  /** Project-relative, '/'-separated path of a workflow file, or null if it isn't a .xaml in the project. */
  toProjectPath(uri) {
    if (!uri || uri.scheme !== 'file' || !this.root) return null;
    const relative = path.relative(this.root.fsPath, uri.fsPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !/\.xaml$/i.test(relative)) return null;
    return relative.split(path.sep).join('/');
  }

  /** Brings a workflow to the front in Studio. Studio can't be told to select an activity. */
  async openWorkflow(file) {
    if (typeof file !== 'string' || !/\.xaml$/i.test(file) || file.split('/').includes('..')) return;
    const uri = vscode.Uri.joinPath(this.root, ...file.split('/'));
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      vscode.window.showWarningMessage(`Workflow not found: ${file}`);
      return;
    }
    await vscode.commands.executeCommand('vscode.open', uri);
  }

  /** Runs file-changing work one at a time, so saves, screenshots and refreshes never interleave. */
  enqueue(fn) {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch((err) => {
      log.appendLine(`Error: ${err?.stack ?? err}`);
      vscode.window.showErrorMessage(`Bookmarks Review: ${err?.message ?? err}`);
    });
    return this.queue;
  }

  refresh() {
    return this.enqueue(async () => {
      this.bookmarks = await this.bookmarkStore.load();
      const notes = await this.reviewStore.loadAll();
      const { attached, updates, orphans } = reconcile(this.bookmarks, notes);
      for (const { note, changes, relinked } of updates) {
        Object.assign(note.meta, changes);
        await this.reviewStore.writeNote(note.meta, note.body);
        if (relinked) {
          log.appendLine(`Re-attached note ${note.meta.noteId} to bookmark ${changes.bookmarkId}`);
          vscode.window.showInformationMessage(`Review note re-attached to the re-created bookmark on "${note.meta.activityName}".`);
        }
      }
      this.attached = attached;
      this.orphans = orphans;
      this.notesById = new Map(notes.map((n) => [n.meta.noteId, n]));
      this.replyCounts = await this.reviewStore.countReplies();
      this.postState();
    });
  }

  /** A note or reply file changed. Someone else's change (e.g. git pull) makes an open note reload. */
  async onNoteFileChanged(uri) {
    const parts = uri.fsPath.split(/[\\/]/);
    const noteId = parts.at(-2) === 'notes' ? path.basename(uri.fsPath, '.md') : parts.at(-2);
    let text = null;
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
      // deleted
    }
    const ownWrite = text !== null && this.reviewStore.isOwnWrite(uri, text);
    await this.refresh();
    if (!ownWrite) this.post({ type: 'noteChangedOnDisk', noteId });
  }

  // ---- Webview -------------------------------------------------------------

  async resolveWebviewView(view) {
    this.view = view;
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    await this.ready;
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: this.root ? [dist, this.reviewStore.reviewDir] : [dist],
    };
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    view.webview.html = this.html(view.webview);
  }

  post(msg) {
    this.view?.webview.postMessage(msg);
  }

  /** Webview URL prefix of .review/, used to show screenshots while notes store relative paths. */
  get assetBase() {
    return this.view ? this.view.webview.asWebviewUri(this.reviewStore.reviewDir).toString() : '';
  }

  toWebviewBody(body, prefix = NOTE_ASSETS) {
    return this.assetBase ? body.split(`](${prefix}`).join(`](${this.assetBase}/assets/`) : body;
  }

  fromWebviewBody(body, prefix = NOTE_ASSETS) {
    return this.assetBase ? body.split(`${this.assetBase}/assets/`).join(prefix) : body;
  }

  postState() {
    const summary = (note) =>
      note && {
        noteId: note.meta.noteId,
        status: note.meta.status || 'open',
        author: note.meta.author,
        updated: note.meta.updated,
        imageCount: countImages(note.body),
        replyCount: this.replyCounts?.get(note.meta.noteId) ?? 0,
        excerpt: excerpt(note.body),
      };
    const groups = new Map();
    for (const b of this.bookmarks) {
      if (!groups.has(b.file)) groups.set(b.file, []);
      groups.get(b.file).push({ ...b, note: summary(this.attached.get(b.id)) });
    }
    this.post({
      type: 'state',
      hasProject: Boolean(this.root),
      author: this.author,
      activeWorkflow: this.activeWorkflow ?? null,
      workflows: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([file, bookmarks]) => ({ file, bookmarks })),
      orphans: this.orphans.map((n) => ({
        noteId: n.meta.noteId,
        workflow: n.meta.workflow,
        activityName: n.meta.activityName,
        ...summary(n),
      })),
    });
  }

  async onMessage(msg) {
    await this.ready;
    if (!this.root) return this.postState();
    switch (msg?.type) {
      case 'ready':
        this.postState();
        break;
      case 'open':
        // Queued, so a note opened right after a save shows the saved version.
        await this.enqueue(() => this.postNote(msg.bookmarkId, msg.noteId));
        break;
      case 'save':
        await this.enqueue(() => this.saveNote(msg));
        break;
      case 'setStatus':
        await this.enqueue(() => this.setStatus(msg));
        break;
      case 'saveReply':
        await this.enqueue(() => this.saveReply(msg));
        break;
      case 'deleteReply':
        await this.deleteReply(msg);
        break;
      case 'discardDraft':
        if (isValidId(msg.noteId)) await this.enqueue(() => this.cleanupAssets(msg.noteId));
        break;
      case 'openImage':
        await this.openImage(msg.src);
        break;
      case 'pasteImage':
        await this.enqueue(() => this.saveImage(msg));
        break;
      case 'deleteNote':
        await this.deleteNote(msg.noteId);
        break;
      case 'openWorkflow':
        await this.openWorkflow(msg.file);
        break;
    }
  }

  async postNote(bookmarkId, noteId) {
    const bookmark = this.bookmarks.find((b) => b.id === bookmarkId);
    const known = bookmark ? this.attached.get(bookmark.id) : this.notesById.get(noteId);
    const note = known ? await this.reviewStore.readNote(known.meta.noteId) : null;
    if (!bookmark && !note) return this.postState();
    const replies = note ? await this.reviewStore.loadReplies(note.meta.noteId) : [];
    this.post({
      type: 'note',
      bookmark: bookmark ?? null,
      noteId: note?.meta.noteId ?? bookmark.id,
      meta: note?.meta ?? null,
      body: this.toWebviewBody(note?.body ?? ''),
      orphan: !bookmark,
      me: this.author,
      replies: replies.map((r) => ({
        id: r.id,
        author: r.meta.author,
        created: r.meta.created,
        updated: r.meta.updated,
        body: this.toWebviewBody(r.body, REPLY_ASSETS),
        mine: r.meta.author === this.author,
      })),
    });
  }

  /** Deletes screenshots of a note that neither the note nor its replies reference any more. */
  async cleanupAssets(noteId) {
    const note = await this.reviewStore.readNote(noteId);
    const replies = await this.reviewStore.loadReplies(noteId);
    await this.reviewStore.cleanupAssets(noteId, [note?.body ?? '', ...replies.map((r) => r.body)]);
  }

  async saveNote({ bookmarkId, noteId, body, status }) {
    if (!isValidId(noteId)) return;
    const markdown = this.fromWebviewBody(String(body ?? '')).trim();
    const newStatus = STATUSES.includes(status) ? status : 'open';
    const bookmark = this.bookmarks.find((b) => b.id === bookmarkId);
    const existing = await this.reviewStore.readNote(noteId);
    const hasReplies = existing ? (await this.reviewStore.loadReplies(noteId)).length > 0 : false;

    // An empty, open note on a live bookmark, without replies, is the same as no note.
    if (!markdown && newStatus === 'open' && !hasReplies && (bookmark || !existing)) {
      if (existing) await this.reviewStore.deleteNote(noteId);
      else await this.reviewStore.cleanupAssets(noteId, []);
      this.post({ type: 'saved', noteId, meta: null, removed: Boolean(existing) });
      return this.refreshLater();
    }

    const now = new Date().toISOString();
    const meta = existing ? { ...existing.meta } : { noteId, author: this.author, created: now };
    if (bookmark) {
      Object.assign(meta, {
        bookmarkId: bookmark.id,
        workflow: bookmark.file,
        activityIdRef: bookmark.activityIdRef,
        activityName: bookmark.activityName,
      });
    }
    meta.status = newStatus;
    meta.updated = now;
    await this.reviewStore.writeNote(meta, markdown);
    await this.cleanupAssets(noteId);
    this.post({ type: 'saved', noteId, meta });
    this.refreshLater();
  }

  /** Changes only the status (read view: Mark resolved / Reopen / status list). */
  async setStatus({ noteId, status }) {
    if (!isValidId(noteId) || !STATUSES.includes(status)) return;
    const existing = await this.reviewStore.readNote(noteId);
    if (!existing) return;
    const meta = { ...existing.meta, status, updated: new Date().toISOString() };
    await this.reviewStore.writeNote(meta, existing.body);
    this.post({ type: 'saved', noteId, meta });
    this.refreshLater();
  }

  /** Adds a reply (no replyId) or edits/removes one of your own (empty body removes it). */
  async saveReply({ bookmarkId, noteId, replyId, body }) {
    if (!isValidId(noteId)) return;
    if (!(await this.reviewStore.readNote(noteId))) {
      return this.post({ type: 'replyError', error: 'This note no longer exists — it may have been deleted. Go back to the list and open the bookmark again.' });
    }
    const markdown = this.fromWebviewBody(String(body ?? ''), REPLY_ASSETS).trim();
    const now = new Date().toISOString();
    if (replyId) {
      if (!isValidReplyId(replyId)) return;
      const existing = await this.reviewStore.readReply(noteId, replyId);
      if (!existing) return this.post({ type: 'replyError', error: 'This reply no longer exists.' });
      if (existing.meta.author !== this.author) {
        return this.post({ type: 'replyError', error: `Only ${existing.meta.author} can change this reply. Add your own reply instead.` });
      }
      if (markdown) await this.reviewStore.writeReply(noteId, replyId, { ...existing.meta, updated: now }, markdown);
      else await this.reviewStore.deleteReply(noteId, replyId);
    } else if (markdown) {
      await this.reviewStore.writeReply(noteId, newReplyId(), { author: this.author, created: now, updated: now }, markdown);
    }
    await this.cleanupAssets(noteId);
    await this.postNote(bookmarkId, noteId);
    this.refreshLater();
  }

  async deleteReply({ bookmarkId, noteId, replyId }) {
    if (!isValidId(noteId) || !isValidReplyId(replyId)) return;
    const existing = await this.reviewStore.readReply(noteId, replyId);
    if (!existing || existing.meta.author !== this.author) return;
    const choice = await vscode.window.showWarningMessage('Delete this reply and its screenshots?', { modal: true }, 'Delete');
    if (choice !== 'Delete') return;
    await this.enqueue(async () => {
      await this.reviewStore.deleteReply(noteId, replyId);
      await this.cleanupAssets(noteId);
      await this.postNote(bookmarkId, noteId);
    });
    this.refreshLater();
  }

  /** Opens a screenshot in the Windows default image viewer. Only files under .review/assets/ are allowed. */
  async openImage(src) {
    const base = `${this.assetBase}/assets/`;
    if (typeof src !== 'string' || !this.assetBase || !src.startsWith(base)) return;
    const [noteId, file, ...rest] = decodeURIComponent(src.slice(base.length).split(/[?#]/)[0]).split('/');
    if (rest.length || !isValidId(noteId) || !IMAGE_FILE.test(file ?? '')) return;
    const uri = vscode.Uri.joinPath(this.reviewStore.assetsDir, noteId, file);
    const opened = await vscode.env.openExternal(uri);
    log.appendLine(`Open image ${uri.fsPath}: ${opened ? 'opened' : 'refused by the host'}`);
    if (!opened) {
      vscode.window.showWarningMessage(`Could not open the screenshot in the image viewer — the host refused to open files. The file is at ${uri.fsPath}.`);
    }
  }

  /** Refresh after the current queued job finishes (cannot await inside the queue). */
  refreshLater() {
    setTimeout(() => this.refresh(), 0);
  }

  async saveImage({ requestId, noteId, dataUrl }) {
    const match = IMAGE_DATA_URL.exec(String(dataUrl ?? ''));
    if (!isValidId(noteId) || !match) {
      return this.post({ type: 'imageError', requestId, error: 'Only PNG, JPEG, GIF, WebP or BMP images can be added.' });
    }
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > MAX_IMAGE_BYTES) {
      return this.post({ type: 'imageError', requestId, error: 'The image is larger than 15 MB.' });
    }
    const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
    const uri = await this.reviewStore.saveImage(noteId, buffer, ext);
    log.appendLine(`Saved screenshot ${uri.fsPath}`);
    this.post({ type: 'imageSaved', requestId, src: this.view.webview.asWebviewUri(uri).toString() });
  }

  async deleteNote(noteId) {
    if (!isValidId(noteId)) return;
    const choice = await vscode.window.showWarningMessage('Delete this review note and its screenshots?', { modal: true }, 'Delete');
    if (choice !== 'Delete') return;
    await this.enqueue(() => this.reviewStore.deleteNote(noteId));
    this.post({ type: 'deleted', noteId });
    await this.refresh();
  }

  html(webview) {
    const nonce = [...Array(32)].map(() => Math.random().toString(36)[2]).join('');
    // Webview bundle built by esbuild from webview/ (npm run build).
    const dist = (file) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', file));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${dist('webview.css')}">
  <title>Bookmarks Review</title>
</head>
<body>
  <div id="app"><p class="muted">Loading…</p></div>
  <script nonce="${nonce}" src="${dist('webview.js')}"></script>
</body>
</html>`;
  }
}

module.exports = { activate, deactivate };

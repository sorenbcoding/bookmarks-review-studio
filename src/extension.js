// Bookmarks Review: rich review notes (formatting + screenshots) for UiPath Studio bookmarks.
// Studio's .project/bookmarks.json is only read. Notes live in <project>/.review/ and go into Git.
const vscode = require('vscode');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { BookmarkStore, ReviewStore, remove } = require('./stores');
const { reconcile } = require('./core/reconcile');
const { STATUSES, isValidId, isValidReplyId, newReplyId, isAssetReferenced, countImages, excerpt } = require('./core/noteFile');
const { authorName } = require('./git');
const opener = require('./openFile');
const archive = require('./core/archive');
const { createZip } = require('./core/zip');

const IMAGE_DATA_URL = /^data:image\/(png|jpeg|gif|webp|bmp);base64,([A-Za-z0-9+/=]+)$/;
const IMAGE_FILE = /^[\w.-]+\.(png|jpg|gif|webp|bmp)$/i;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
// Relative path from a file to .review/assets/: notes live one level down, replies two.
const NOTE_ASSETS = '../assets/';
const REPLY_ASSETS = '../../assets/';
const CONFIG = 'bookmarksReview';
const HIDE_ORPHANS = 'hideNotesWithoutBookmark';
const REMOVE_BOOKMARKS = 'removeBookmarksOnWrapUp';
const SETTINGS = [HIDE_ORPHANS, REMOVE_BOOKMARKS];
const ARCHIVE_FOLDER = 'archiveFolder';
const RENDER_TIMEOUT_MS = 30000;
// A pasted screenshot is written before the editor inserts its link; until a saved text links it
// (or this time passes), cleanup leaves it alone, so an autosave already in flight can't delete it.
const FRESH_ASSET_MS = 10 * 60 * 1000;
const PENDING_REMOVALS = 'pendingRemovals';

/** Valid note ids from a webview message, as a Set. */
const idSet = (ids) => new Set(Array.isArray(ids) ? ids.filter(isValidId) : []);

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

/** The archived files of one note, from the export snapshot (keys as in ReviewStore.listFiles). */
function snapshotOf(data, noteId) {
  const files = new Map();
  for (const [key, buffer] of data) {
    if (key === `notes/${noteId}.md` || key.startsWith(`replies/${noteId}/`) || key.startsWith(`assets/${noteId}/`)) files.set(key, buffer);
  }
  return files;
}

/** @param {Map<string, Buffer>} a @param {Map<string, Buffer>} b */
function sameFiles(a, b) {
  if (a.size !== b.size) return false;
  for (const [key, buffer] of a) if (!b.get(key)?.equals(buffer)) return false;
  return true;
}

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
    this.pendingRenders = new Map();
    /** @type {Map<string, number>} '<noteId>/<file>' → time the screenshot was saved, until a saved text links it */
    this.freshAssets = new Map();
    this.renderSeq = 0;
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
    // The panel shows screenshots from copies here, never from .review/: Studio's web view keeps the files
    // it shows open, which stopped screenshots from being deleted.
    const storage = this.context.globalStorageUri?.fsPath ?? path.join(os.tmpdir(), 'sorenb-bookmarks-review');
    const project = crypto.createHash('sha1').update(this.root.fsPath.toLowerCase()).digest('hex').slice(0, 12);
    this.imageCache = vscode.Uri.file(path.join(storage, 'image-cache', project));
    await remove(this.imageCache); // best effort: copies still shown elsewhere stay until the next start
    await fsp.mkdir(path.join(this.imageCache.fsPath, 'assets'), { recursive: true });
    // Files a delete couldn't remove (locked by another program) are retried on every refresh.
    this.pendingRemovals = new Set(this.context.workspaceState?.get(PENDING_REMOVALS, []) ?? []);
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
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${CONFIG}.${HIDE_ORPHANS}`)) this.postState();
        if (e.affectsConfiguration(`${CONFIG}.${REMOVE_BOOKMARKS}`)) this.postWrapUpInfo();
        if (SETTINGS.some((key) => e.affectsConfiguration(`${CONFIG}.${key}`))) this.postSettings();
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
      if (this.pendingRemovals.size) await this.retryPendingRemovals();
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
      localResourceRoots: this.root ? [dist, this.imageCache] : [dist],
    };
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    view.webview.html = this.html(view.webview);
  }

  post(msg) {
    this.view?.webview.postMessage(msg);
  }

  /**
   * Webview URL prefix that stands in for .review/ while notes store relative paths. It points at the image
   * cache, which mirrors .review/assets/, so Studio never holds the project's screenshot files open.
   */
  get assetBase() {
    return this.view ? this.view.webview.asWebviewUri(this.imageCache).toString() : '';
  }

  /** Copies a note's screenshots into the image cache, so the panel can show them. */
  async cacheImages(noteId) {
    const from = path.join(this.reviewStore.assetsDir.fsPath, noteId);
    const to = path.join(this.imageCache.fsPath, 'assets', noteId);
    let names;
    try {
      names = await fsp.readdir(from);
    } catch {
      return;
    }
    await fsp.mkdir(to, { recursive: true });
    for (const name of names) {
      if (!IMAGE_FILE.test(name)) continue;
      const target = path.join(to, name);
      try {
        const [a, b] = await Promise.all([fsp.stat(path.join(from, name)), fsp.stat(target).catch(() => null)]);
        if (!b || a.size !== b.size || a.mtimeMs > b.mtimeMs) await fsp.copyFile(path.join(from, name), target);
      } catch (err) {
        log.appendLine(`Could not cache ${name}: ${err?.message ?? err}`);
      }
    }
  }

  // ---- Deleting: files another program holds open are retried later instead of blocking the delete ----

  /** Deletes a note's files; whatever is locked is retried later. */
  async removeNoteFiles(noteId) {
    this.trackLeftovers(await this.reviewStore.deleteNote(noteId));
  }

  trackLeftovers(paths) {
    if (!paths.length) return;
    for (const p of paths) this.pendingRemovals.add(p);
    this.context.workspaceState?.update(PENDING_REMOVALS, [...this.pendingRemovals]);
    log.appendLine(`Could not delete yet (in use by another program), will retry: ${paths.join(', ')}`);
    if (!this.leftoverNoticeShown) {
      this.leftoverNoticeShown = true;
      setTimeout(() => (this.leftoverNoticeShown = false), 2000);
      vscode.window.showInformationMessage(
        'Bookmarks Review: deleted. Some screenshot files are in use by another program, for example an image viewer. They are removed automatically once released, at the latest the next time the project opens.'
      );
    }
  }

  async retryPendingRemovals() {
    const left = await this.reviewStore.removePaths([...this.pendingRemovals]);
    if (left.length === this.pendingRemovals.size) return;
    log.appendLine(`Removed ${this.pendingRemovals.size - left.length} files that were in use earlier`);
    this.pendingRemovals = new Set(left);
    this.context.workspaceState?.update(PENDING_REMOVALS, left);
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
      hideOrphans: this.setting(HIDE_ORPHANS),
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
        if (isValidId(msg.noteId)) await this.enqueue(() => this.cleanupAssets(msg.noteId, { discard: true }));
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
      case 'deleteOrphans':
        await this.deleteOrphans(idSet(msg.noteIds));
        break;
      case 'wrapUpInfo':
        this.postWrapUpInfo();
        break;
      case 'chooseArchiveFolder':
        await this.chooseArchiveFolder();
        break;
      case 'exportArchive':
        await this.exportArchive(msg.remove);
        break;
      case 'reportRendered': {
        const resolve = this.pendingRenders.get(msg.requestId);
        this.pendingRenders.delete(msg.requestId);
        resolve?.(msg.html && typeof msg.html === 'object' ? msg.html : null);
        break;
      }
      case 'revealArchive':
        if (this.lastArchive) await opener.revealInExplorer(this.lastArchive);
        break;
      case 'setHideOrphans':
        await this.setSetting(HIDE_ORPHANS, msg.value === true);
        this.postState();
        this.postSettings();
        break;
      case 'setRemoveBookmarks':
        await this.setSetting(REMOVE_BOOKMARKS, msg.value === true);
        this.postWrapUpInfo();
        this.postSettings();
        break;
      case 'settingsInfo':
        this.postSettings();
        break;
      case 'deleteAll':
        await this.deleteAll(msg.withBookmarks === true, idSet(msg.noteIds), new Set(Array.isArray(msg.bookmarkIds) ? msg.bookmarkIds.filter(isValidId) : []));
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
    await this.cacheImages(note?.meta.noteId ?? bookmark.id);
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

  /**
   * Deletes screenshots of a note that neither the note nor its replies reference any more. Freshly pasted
   * screenshots are kept until a saved text links them, unless a draft is being discarded.
   */
  async cleanupAssets(noteId, { discard = false } = {}) {
    const note = await this.reviewStore.readNote(noteId);
    const replies = await this.reviewStore.loadReplies(noteId);
    const texts = [note?.body ?? '', ...replies.map((r) => r.body)];
    const keep = new Set();
    const now = Date.now();
    for (const [key, time] of this.freshAssets) {
      const [id, file] = key.split('/');
      if (id !== noteId) continue;
      if (discard || now - time > FRESH_ASSET_MS || isAssetReferenced(noteId, file, texts)) this.freshAssets.delete(key);
      else keep.add(file);
    }
    await this.reviewStore.cleanupAssets(noteId, texts, keep);
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
      if (existing) await this.removeNoteFiles(noteId);
      else await this.cleanupAssets(noteId);
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
    // The panel asks for confirmation; Studio's host dialogs aren't relied on.
    const existing = await this.reviewStore.readReply(noteId, replyId);
    if (!existing || existing.meta.author !== this.author) return;
    await this.enqueue(async () => {
      await this.reviewStore.deleteReply(noteId, replyId);
      await this.cleanupAssets(noteId);
      await this.postNote(bookmarkId, noteId);
    });
    this.refreshLater();
  }

  /**
   * Opens a screenshot in the Windows default image viewer. Only `<noteId>/<image file>` under
   * .review/assets/ is accepted; the file path is built from the assets folder, never from the URL.
   */
  async openImage(src) {
    let decoded = '';
    try {
      decoded = decodeURIComponent(String(src ?? '').split(/[?#]/)[0]);
    } catch {
      // malformed escape: rejected below
    }
    const match = /\/assets\/([^/\\]+)\/([^/\\]+)$/.exec(decoded);
    if (!match || !isValidId(match[1]) || !IMAGE_FILE.test(match[2])) {
      log.appendLine(`Open image refused, not a screenshot under .review/assets/: ${src}`);
      return;
    }
    const uri = vscode.Uri.joinPath(this.reviewStore.assetsDir, match[1], match[2]);
    if (!(await this.reviewStore.exists(uri))) {
      this.post({ type: 'notice', text: 'Screenshot file not found' });
      return;
    }
    const { ok, via } = await opener.openWithDefaultApp(uri);
    log.appendLine(`Open image ${uri.fsPath}: ${ok ? `opened (${via})` : 'failed'}`);
    this.post({ type: 'notice', text: ok ? 'Opened in the image viewer' : 'Could not open the screenshot' });
    if (!ok) {
      vscode.window.showWarningMessage(`Could not open the screenshot in the image viewer — Windows did not start a viewer for the file. Open it from ${uri.fsPath}.`);
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
    const name = path.basename(uri.fsPath);
    this.freshAssets.set(`${noteId}/${name}`, Date.now());
    log.appendLine(`Saved screenshot ${uri.fsPath}`);
    // The panel shows the cached copy; the note links the project file through the relative path.
    const cached = vscode.Uri.joinPath(this.imageCache, 'assets', noteId, name);
    await fsp.mkdir(path.dirname(cached.fsPath), { recursive: true });
    await fsp.writeFile(cached.fsPath, buffer);
    this.post({ type: 'imageSaved', requestId, src: this.view.webview.asWebviewUri(cached).toString() });
  }

  /** Deletes a note with its replies and screenshots. The panel asks for confirmation first. */
  async deleteNote(noteId) {
    if (!isValidId(noteId)) return;
    await this.enqueue(() => this.removeNoteFiles(noteId));
    log.appendLine(`Deleted note ${noteId}`);
    this.post({ type: 'deleted', noteId });
    await this.refresh();
  }

  /** Deletes the confirmed notes (`noteIds`) that are still without a bookmark. */
  async deleteOrphans(noteIds) {
    await this.refresh();
    const ids = this.orphans.map((n) => n.meta.noteId).filter((id) => noteIds.has(id));
    await this.enqueue(async () => {
      for (const id of ids) await this.removeNoteFiles(id);
    });
    log.appendLine(`Deleted ${ids.length} notes without a bookmark`);
    for (const noteId of ids) this.post({ type: 'deleted', noteId });
    await this.refresh();
  }

  /**
   * A boolean user setting (default off). The user setting is the source; extension storage is the
   * fallback, and takes precedence, if the host couldn't save the setting.
   */
  setting(key) {
    if (!SETTINGS.includes(key)) return false;
    const fallback = this.context.globalState?.get(key);
    return fallback ?? vscode.workspace.getConfiguration(CONFIG).get(key, false);
  }

  async setSetting(key, value) {
    if (!SETTINGS.includes(key)) return;
    try {
      await vscode.workspace.getConfiguration(CONFIG).update(key, value, vscode.ConfigurationTarget.Global);
      await this.context.globalState?.update(key, undefined);
    } catch (err) {
      log.appendLine(`Could not save the setting ${CONFIG}.${key}, kept in extension storage: ${err?.message ?? err}`);
      await this.context.globalState?.update(key, value);
    }
  }

  // ---- Settings view ----

  postSettings() {
    this.post({ type: 'settingsInfo', hideOrphans: this.setting(HIDE_ORPHANS), removeBookmarks: this.setting(REMOVE_BOOKMARKS) });
  }

  /**
   * Deletes the confirmed notes (`noteIds`) with their replies and screenshots and, with `withBookmarks`,
   * the confirmed Studio bookmarks (`bookmarkIds`). Anything added after the confirmation stays.
   */
  async deleteAll(withBookmarks, noteIds, bookmarkIds) {
    await this.refresh();
    const ids = [...this.attached.values(), ...this.orphans].map((n) => n.meta.noteId).filter((id) => noteIds.has(id));
    let removedBookmarks = 0;
    let strays = 0;
    await this.enqueue(async () => {
      for (const id of ids) await this.removeNoteFiles(id);
      // Screenshots and replies that belong to no note (e.g. pasted into a note that was never saved).
      const files = await this.reviewStore.strayFiles();
      strays = files.length;
      this.trackLeftovers(await this.reviewStore.removeStrays(files));
      this.freshAssets.clear(); // nothing is being edited while the Settings view is open
      if (withBookmarks && bookmarkIds.size) removedBookmarks = await this.bookmarkStore.removeOnly(bookmarkIds);
    });
    if (strays) log.appendLine(`Removed ${strays} files that belonged to no note`);
    log.appendLine(`Deleted all notes (${ids.length})${withBookmarks ? ` and ${removedBookmarks} bookmarks` : ''}`);
    for (const noteId of ids) this.post({ type: 'deleted', noteId });
    this.post({ type: 'allDeleted', notes: ids.length, bookmarks: removedBookmarks, withBookmarks });
    await this.refresh();
  }

  // ---- Wrap up: export the review to a zip and remove notes from the project ----

  /** Folder for archives: the last one chosen, else Documents. */
  get archiveFolder() {
    const chosen = this.context.globalState?.get(ARCHIVE_FOLDER);
    if (typeof chosen === 'string' && chosen) return chosen;
    const documents = path.join(os.homedir(), 'Documents');
    return fs.existsSync(documents) ? documents : os.homedir();
  }

  postWrapUpInfo() {
    this.post({ type: 'wrapUpInfo', folder: this.archiveFolder, removeBookmarks: this.setting(REMOVE_BOOKMARKS) });
  }

  async chooseArchiveFolder() {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(this.archiveFolder),
      openLabel: 'Save archives here',
    });
    if (picked?.[0]) await this.context.globalState?.update(ARCHIVE_FOLDER, picked[0].fsPath);
    this.postWrapUpInfo();
  }

  /** Asks the panel to render Markdown with its Toast UI viewer. Resolves to { id: html }, or null. */
  renderInPanel(sections) {
    if (!sections.length) return Promise.resolve({});
    if (!this.view) return Promise.resolve(null);
    const requestId = ++this.renderSeq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRenders.delete(requestId);
        log.appendLine('The panel did not render the report in time; report.html shows the notes as plain text.');
        resolve(null);
      }, RENDER_TIMEOUT_MS);
      this.pendingRenders.set(requestId, (html) => {
        clearTimeout(timer);
        resolve(html);
      });
      this.post({ type: 'renderReport', requestId, sections });
    });
  }

  /**
   * Writes <project>-review-<date>.zip (summary.md, report.html, .review/, studio-bookmarks.json) to the
   * archive folder, then removes the chosen notes. Nothing is removed unless the archive was written.
   * @param {'closed' | 'all' | 'none'} remove
   */
  async exportArchive(remove) {
    if (!archive.REMOVE_MODES.includes(remove) || this.exporting) return;
    this.exporting = true;
    try {
      await this.refresh();
      const notes = [...this.attached.values(), ...this.orphans];
      if (!notes.length) {
        this.post({ type: 'archiveError', error: 'There are no review notes to archive.' });
        return;
      }
      const replies = new Map();
      for (const n of notes) replies.set(n.meta.noteId, await this.reviewStore.loadReplies(n.meta.noteId));
      const groups = archive.collectEntries({ bookmarks: this.bookmarks, attached: this.attached, orphans: this.orphans, replies });
      const projectName = path.basename(this.root.fsPath);
      const exportedAt = new Date();
      const info = { projectName, exportedAt: exportedAt.toISOString(), author: this.author, groups };

      const data = new Map();
      for (const f of await this.reviewStore.listFiles()) {
        data.set(f.path, Buffer.from(await vscode.workspace.fs.readFile(f.uri)));
      }
      const entries = [...data].map(([p, buffer]) => ({ name: `.review/${p}`, data: buffer }));
      try {
        const bookmarksFile = vscode.Uri.joinPath(this.root, '.project', 'bookmarks.json');
        entries.push({ name: 'studio-bookmarks.json', data: Buffer.from(await vscode.workspace.fs.readFile(bookmarksFile)) });
      } catch {
        // no bookmarks file
      }

      const rendered = await this.renderInPanel(archive.renderSections(groups));
      let css = '';
      try {
        css = await fsp.readFile(path.join(this.context.extensionUri.fsPath, 'dist', 'report.css'), 'utf8');
      } catch {
        log.appendLine('dist/report.css not found; report.html has no styles.');
      }
      const readAsset = (noteId, file) => data.get(`assets/${noteId}/${file}`) ?? null;
      entries.unshift(
        { name: 'summary.md', data: archive.buildSummary(info) },
        { name: 'report.html', data: archive.buildReportHtml({ ...info, rendered, css, readAsset }) }
      );
      const zip = createZip(entries, exportedAt);

      const folder = this.archiveFolder;
      await fsp.mkdir(folder, { recursive: true });
      const name = archive.archiveName(projectName, exportedAt);
      let target = path.join(folder, name);
      for (let i = 2; fs.existsSync(target); i++) target = path.join(folder, name.replace(/\.zip$/, ` (${i}).zip`));
      await fsp.writeFile(target, zip, { flag: 'wx' });
      if ((await fsp.stat(target)).size !== zip.length) throw new Error(`the archive ${target} was not written completely`);
      this.lastArchive = vscode.Uri.file(target);
      log.appendLine(`Wrote review archive ${target} (${notes.length} notes, ${zip.length} bytes)`);

      // Remove only notes whose files are exactly as archived: a note changed during the export
      // (e.g. by a git pull) is kept, so nothing is removed that the archive doesn't hold.
      const candidates = archive.notesToRemove(groups, remove);
      const ids = [];
      let changed = 0;
      await this.enqueue(async () => {
        for (const id of candidates) {
          if (sameFiles(await this.reviewStore.noteFiles(id), snapshotOf(data, id))) {
            await this.removeNoteFiles(id);
            ids.push(id);
          } else {
            changed++;
            log.appendLine(`Kept note ${id}: it changed during the export, so the archive does not hold its current version`);
          }
        }
        // Files that belong to no note go too, if the archive holds them unchanged and they weren't just pasted.
        const strays = [];
        for (const f of await this.reviewStore.strayFiles()) {
          const fresh = this.freshAssets.has(f.path.replace(/^assets\//, ''));
          const archived = data.get(f.path);
          if (!fresh && archived && archived.equals(Buffer.from(await vscode.workspace.fs.readFile(f.uri)))) strays.push(f);
        }
        this.trackLeftovers(await this.reviewStore.removeStrays(strays));
        if (strays.length) log.appendLine(`Removed ${strays.length} archived files that belonged to no note`);
      });
      if (ids.length) log.appendLine(`Removed ${ids.length} notes after the export`);

      // Optionally clear Studio's bookmarks too, keeping those whose note stays in the project.
      let removedBookmarks = 0;
      if (this.setting(REMOVE_BOOKMARKS)) {
        const removedIds = new Set(ids);
        const keep = new Set([...this.attached].filter(([, note]) => !removedIds.has(note.meta.noteId)).map(([bookmarkId]) => bookmarkId));
        await this.enqueue(async () => {
          removedBookmarks = await this.bookmarkStore.removeAllExcept(keep);
        });
        if (removedBookmarks) log.appendLine(`Removed ${removedBookmarks} bookmarks from .project/bookmarks.json`);
      }
      this.post({ type: 'archived', file: target, removed: ids.length, kept: notes.length - ids.length, changed, removedBookmarks });
      await this.refresh();
    } catch (err) {
      log.appendLine(`Export failed: ${err?.stack ?? err}`);
      this.post({
        type: 'archiveError',
        error: `Could not write the review archive — ${err?.message ?? err}. No notes were removed. Choose another folder and try again.`,
      });
    } finally {
      this.exporting = false;
    }
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

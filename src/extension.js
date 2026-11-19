// Bookmarks Review: rich review notes (formatting + screenshots) for UiPath Studio bookmarks.
// Studio's .project/bookmarks.json is only read. Notes live in <project>/.review/ and go into Git.
const vscode = require('vscode');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { BookmarkStore, ReviewStore } = require('./stores');
const { reconcile } = require('./core/reconcile');
const { STATUSES, isValidId, isValidReplyId, newReplyId, countImages, excerpt } = require('./core/noteFile');
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
    this.pendingRenders = new Map();
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
      case 'deleteOrphans':
        await this.deleteOrphans();
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
        break;
      case 'setRemoveBookmarks':
        await this.setSetting(REMOVE_BOOKMARKS, msg.value === true);
        this.postWrapUpInfo();
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
    log.appendLine(`Saved screenshot ${uri.fsPath}`);
    this.post({ type: 'imageSaved', requestId, src: this.view.webview.asWebviewUri(uri).toString() });
  }

  /** Deletes a note with its replies and screenshots. The panel asks for confirmation first. */
  async deleteNote(noteId) {
    if (!isValidId(noteId)) return;
    await this.enqueue(() => this.reviewStore.deleteNote(noteId));
    log.appendLine(`Deleted note ${noteId}`);
    this.post({ type: 'deleted', noteId });
    await this.refresh();
  }

  /** Deletes every note whose bookmark is gone, as of the last refresh. */
  async deleteOrphans() {
    await this.refresh();
    const ids = this.orphans.map((n) => n.meta.noteId);
    await this.enqueue(async () => {
      for (const id of ids) await this.reviewStore.deleteNote(id);
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

      const ids = archive.notesToRemove(groups, remove);
      await this.enqueue(async () => {
        for (const id of ids) await this.reviewStore.deleteNote(id);
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
      this.post({ type: 'archived', file: target, removed: ids.length, kept: notes.length - ids.length, removedBookmarks });
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

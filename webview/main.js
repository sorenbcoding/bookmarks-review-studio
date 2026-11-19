// Sidebar UI: bookmark list, note read view with reply thread, and WYSIWYG editor (Toast UI Editor, stores Markdown).
import Editor from '@toast-ui/editor';
import '@toast-ui/editor/dist/toastui-editor.css';
import '@toast-ui/editor/dist/theme/toastui-editor-dark.css';
import './sorenb-tokens.css';
import './style.css';

const vscode = acquireVsCodeApi();
const app = document.getElementById('app');

const STATUS_LABELS = { open: 'Open', resolved: 'Resolved', wontfix: "Won't fix" };
const SAVE_DELAY_MS = 800;

let state = null; // last 'state' message
let current = null; // { bookmark, noteId, orphan, meta, body, replies, mode: 'read' | 'edit' }
let editor = null;
let loading = false;
let dirty = false;
let saveTimer;
let requestSeq = 0;
const pendingImages = new Map();

// Per-viewer UI preferences, kept by the webview host between sessions.
const prefs = { onlyCurrent: false, ...(vscode.getState() ?? {}) };
const savePrefs = () => vscode.setState(prefs);

const sameFile = (a, b) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());
const isCurrent = (file) => sameFile(file, state?.activeWorkflow);
const showInStudio = (file) => vscode.postMessage({ type: 'openWorkflow', file });

// ---- helpers ----------------------------------------------------------------

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

function isDark() {
  const cls = document.body.classList;
  if (cls.contains('vscode-dark') || cls.contains('vscode-high-contrast')) return true;
  if (cls.contains('vscode-light')) return false;
  const rgb = getComputedStyle(document.body).backgroundColor.match(/\d+/g)?.map(Number);
  return rgb ? (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 < 0.5 : false;
}

// Brand tokens switch on [data-theme]; follow Studio's theme class, including live theme changes.
function syncTheme() {
  document.documentElement.dataset.theme = isDark() ? 'dark' : 'light';
}
syncTheme();
new MutationObserver(syncTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

const badge = (status) => h('span', { class: `badge ${status}` }, STATUS_LABELS[status] ?? status);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function setSaveState(text) {
  const node = document.getElementById('saveState');
  if (node) node.textContent = text;
}

// ---- list view --------------------------------------------------------------

function renderList() {
  destroyEditors();
  current = null;
  app.replaceChildren();
  if (!state) return app.append(h('p', { class: 'muted' }, 'Loading…'));
  if (!state.hasProject) return app.append(h('p', { class: 'muted' }, 'Open a UiPath project to see its bookmarks.'));

  const all = state.workflows.flatMap((w) => w.bookmarks);
  const withNotes = all.filter((b) => b.note).length;
  const open = all.filter((b) => b.note?.status === 'open').length;
  const toggle = h('input', { type: 'checkbox', id: 'onlyCurrent', checked: prefs.onlyCurrent, onchange: (e) => {
    prefs.onlyCurrent = e.target.checked;
    savePrefs();
    renderList();
  } });
  app.append(
    h('div', { class: 'listbar' },
      h('span', { class: 'muted' }, `${plural(all.length, 'bookmark')} · ${withNotes} with notes · ${open} open`),
      h('label', { class: 'toggle', for: 'onlyCurrent' }, toggle, 'This workflow only'))
  );

  if (all.length === 0) {
    app.append(h('p', { class: 'muted' }, 'No bookmarks yet. In Studio, right-click an activity and choose Toggle Bookmark.'));
  }

  // The workflow open in Studio comes first and is highlighted.
  const workflows = [...state.workflows].sort((a, b) => Number(isCurrent(b.file)) - Number(isCurrent(a.file)));
  const shown = prefs.onlyCurrent ? workflows.filter((w) => isCurrent(w.file)) : workflows;

  if (prefs.onlyCurrent && shown.length === 0 && all.length > 0) {
    const name = state.activeWorkflow ? state.activeWorkflow.split('/').pop() : null;
    app.append(h('p', { class: 'muted' }, name ? `No bookmarks in ${name}.` : 'Open a workflow in Studio to see its bookmarks.'));
  }

  for (const wf of shown) {
    const slash = wf.file.lastIndexOf('/');
    const current = isCurrent(wf.file);
    app.append(
      h('div', { class: `wf-head${current ? ' current' : ''}` },
        h('h3', { class: 'workflow', title: wf.file },
          h('span', {}, wf.file.slice(slash + 1)),
          slash >= 0 ? h('span', { class: 'muted folder' }, wf.file.slice(0, slash)) : null),
        current
          ? h('span', { class: 'current-tag' }, 'Open in Studio')
          : h('button', { class: 'link small', title: 'Bring this workflow to the front in Studio', onclick: () => showInStudio(wf.file) }, 'Show in Studio'))
    );
    app.append(h('ul', { class: `rows${current ? ' current' : ''}` }, wf.bookmarks.map((b) => row(b))));
  }

  if (state.orphans.length && !prefs.onlyCurrent) {
    app.append(
      h('h3', { class: 'workflow' }, 'Notes without a bookmark'),
      h('p', { class: 'muted small' }, 'Their bookmark was deleted in Studio. Re-add a bookmark on the same activity to re-attach a note, or delete it.'),
      h('ul', { class: 'rows' }, state.orphans.map((o) =>
        h('li', {}, h('button', { class: 'row orphan', onclick: () => open({ noteId: o.noteId }) },
          h('span', { class: 'row-main' },
            h('span', { class: 'title' }, o.excerpt || o.activityName || 'Review note'),
            h('span', { class: 'muted sub' }, `${o.activityName ?? ''} · ${o.workflow ?? ''}`)),
          badge(o.status))))
      )
    );
  }
}

function row(b) {
  const sub = [b.activityName];
  if (b.note?.imageCount) sub.push(plural(b.note.imageCount, 'screenshot'));
  if (b.note?.replyCount) sub.push(b.note.replyCount === 1 ? '1 reply' : `${b.note.replyCount} replies`);
  if (!b.isEnabled) sub.push('disabled');
  return h('li', {},
    h('button', { class: `row${b.isEnabled ? '' : ' disabled'}`, title: b.note?.excerpt || '', onclick: () => open({ bookmarkId: b.id }) },
      h('span', { class: 'row-main' },
        h('span', { class: 'title' }, b.annotation || b.activityName || '(no message)'),
        h('span', { class: 'muted sub' }, sub.join(' · '))),
      b.note ? badge(b.note.status) : h('span', { class: 'badge none' }, 'No note')));
}

function open(target) {
  vscode.postMessage({ type: 'open', ...target });
}

// ---- note view: read mode (default for existing notes) and edit mode ------------

let replyEditor = null;
let replyDraft = null; // { replyId } while the reply composer is open
let viewers = [];

function destroyEditors() {
  clearTimeout(saveTimer);
  editor?.destroy();
  editor = null;
  replyEditor?.destroy();
  replyEditor = null;
  replyDraft = null;
  for (const v of viewers) v.destroy?.();
  viewers = [];
}

function renderNote(msg) {
  // Existing notes open in the read view. A bookmark without a note opens straight in the editor.
  // A reload of the note that is already open keeps its mode.
  const mode = !msg.meta ? 'edit' : current?.noteId === msg.noteId ? current.mode : 'read';
  destroyEditors();
  current = {
    bookmark: msg.bookmark,
    noteId: msg.noteId,
    orphan: msg.orphan,
    meta: msg.meta,
    body: msg.body,
    replies: msg.replies ?? [],
    mode,
  };
  dirty = false;
  if (mode === 'edit') renderEdit();
  else renderRead();
}

function reopen() {
  open(current.bookmark ? { bookmarkId: current.bookmark.id } : { noteId: current.noteId });
}

function header(extraTopButton) {
  const b = current.bookmark;
  const m = current.meta;
  const file = b?.file || m?.workflow;
  return [
    h('div', { class: 'topbar' },
      h('button', { class: 'btn back', onclick: goBack }, '← All bookmarks'),
      h('span', { class: 'topbar-right' }, h('span', { id: 'saveState', class: 'muted small' }), extraTopButton)),
    h('h2', {}, b?.activityName || m?.activityName || 'Review note'),
    h('div', { class: 'pathbar' },
      h('span', { class: 'muted small path' }, file || ''),
      file
        ? h('button', { class: 'link small', title: 'Bring this workflow to the front in Studio. Use Focus in the Markers panel to jump to the activity.', onclick: () => showInStudio(file) }, 'Show in Studio')
        : null),
    current.orphan
      ? h('div', { class: 'banner' },
          h('span', {}, 'The bookmark for this note was deleted in Studio.'),
          h('button', { class: 'danger', onclick: () => vscode.postMessage({ type: 'deleteNote', noteId: current.noteId }) }, 'Delete note'))
      : null,
    b ? h('div', { class: 'studio-msg' },
          h('span', { class: 'label' }, 'Studio message'),
          h('div', { id: 'studioMsg' }, b.annotation || h('em', { class: 'muted' }, '(none)'))) : null,
  ];
}

function metaText(meta) {
  if (!meta) return 'New note: start typing below.';
  return `By ${meta.author || 'unknown'} · updated ${formatTime(meta.updated)}`;
}

function statusSelect(value, onchange) {
  return h('select', { id: 'status', 'aria-label': 'Status', onchange },
    Object.entries(STATUS_LABELS).map(([v, label]) => h('option', { value: v, selected: (value || 'open') === v }, label)));
}

function mountViewer(el, markdown) {
  if (isDark()) el.classList.add('toastui-editor-dark');
  viewers.push(Editor.factory({ el, viewer: true, initialValue: markdown, usageStatistics: false }));
}

// ---- read mode ----

function renderRead() {
  app.replaceChildren(
    ...header(),
    h('div', { id: 'statusRow', class: 'fields' }),
    h('div', { id: 'meta', class: 'muted small' }, metaText(current.meta)),
    current.body.trim()
      ? h('div', { id: 'noteView', class: 'note-body' })
      : h('p', { class: 'muted note-empty' }, 'No text in this note.'),
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: startEdit }, 'Edit note')),
    repliesSection()
  );
  renderStatusRow();
  const noteView = document.getElementById('noteView');
  if (noteView) mountViewer(noteView, current.body);
  for (const r of current.replies) mountViewer(document.getElementById(`reply-${r.id}`), r.body);
}

function renderStatusRow() {
  const row = document.getElementById('statusRow');
  if (!row || current.mode !== 'read') return;
  const status = current.meta?.status || 'open';
  row.replaceChildren(
    h('label', { for: 'status' }, 'Status'),
    statusSelect(status, (e) => setStatus(e.target.value)),
    status === 'open'
      ? h('button', { class: 'btn primary', onclick: () => setStatus('resolved') }, 'Mark resolved')
      : h('button', { class: 'btn', onclick: () => setStatus('open') }, 'Reopen')
  );
}

function setStatus(status) {
  setSaveState('Saving…');
  vscode.postMessage({ type: 'setStatus', noteId: current.noteId, status });
}

function startEdit() {
  current.mode = 'edit';
  destroyEditors();
  renderEdit();
}

// ---- replies ----

function repliesSection() {
  const list = current.replies.map((r) =>
    h('article', { class: 'reply' },
      h('div', { class: 'reply-head' },
        h('span', { class: 'reply-author' }, r.author || 'unknown'),
        h('span', { class: 'muted small' }, formatTime(r.created) + (r.updated && r.updated !== r.created ? ' (edited)' : '')),
        r.mine
          ? h('span', { class: 'reply-actions' },
              h('button', { class: 'link small', onclick: () => startReply(r) }, 'Edit'),
              h('button', { class: 'link small', onclick: () => vscode.postMessage({ type: 'deleteReply', bookmarkId: current.bookmark?.id, noteId: current.noteId, replyId: r.id }) }, 'Delete'))
          : null),
      h('div', { id: `reply-${r.id}`, class: 'reply-body' })));
  return h('section', { class: 'replies' },
    h('h3', { class: 'replies-title' }, current.replies.length ? `Replies (${current.replies.length})` : 'Replies'),
    list,
    h('div', { id: 'replyComposer' }, h('button', { class: 'btn', onclick: () => startReply(null) }, 'Add reply')));
}

function startReply(reply) {
  replyEditor?.destroy();
  replyDraft = { replyId: reply?.id ?? null };
  const composer = document.getElementById('replyComposer');
  const el = h('div', { id: 'replyEditor' });
  composer.replaceChildren(
    h('div', { class: 'muted small composer-title' }, reply ? 'Edit your reply' : 'New reply'),
    el,
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: postReply }, reply ? 'Save reply' : 'Post reply'),
      h('button', { class: 'btn', onclick: cancelReply }, 'Cancel'))
  );
  replyEditor = new Editor({
    el,
    height: 'auto',
    minHeight: '140px',
    initialEditType: 'wysiwyg',
    previewStyle: 'tab',
    initialValue: reply?.body ?? '',
    usageStatistics: false,
    theme: isDark() ? 'dark' : undefined,
    placeholder: 'Write a reply. Paste screenshots with Ctrl+V.',
    toolbarItems: [['bold', 'italic', 'code', 'link'], ['ul', 'ol'], ['image']],
    hooks: { addImageBlobHook: onImage },
  });
  composer.scrollIntoView?.({ block: 'nearest' });
}

function postReply() {
  if (!replyEditor || !replyDraft) return;
  const body = replyEditor.getMarkdown();
  if (!body.trim() && !replyDraft.replyId) return setSaveState('Write something first, or press Cancel.');
  setSaveState('Saving reply…');
  vscode.postMessage({ type: 'saveReply', bookmarkId: current.bookmark?.id, noteId: current.noteId, replyId: replyDraft.replyId, body });
}

function cancelReply() {
  replyEditor?.destroy();
  replyEditor = null;
  replyDraft = null;
  // Screenshots pasted into the discarded draft are removed.
  vscode.postMessage({ type: 'discardDraft', noteId: current.noteId });
  document.getElementById('replyComposer')?.replaceChildren(h('button', { class: 'btn', onclick: () => startReply(null) }, 'Add reply'));
}

// ---- edit mode ----

function renderEdit() {
  const m = current.meta;
  const done = m ? h('button', { class: 'btn', onclick: finishEdit }, 'Done') : null;
  app.replaceChildren(
    ...header(done),
    h('div', { class: 'fields' },
      h('label', { for: 'status' }, 'Status'),
      statusSelect(m?.status, () => { dirty = true; scheduleSave(0); }),
      h('span', { id: 'meta', class: 'muted small' }, metaText(m))),
    h('div', { id: 'editor' })
  );

  loading = true;
  editor = new Editor({
    el: document.getElementById('editor'),
    height: 'auto',
    minHeight: '260px',
    initialEditType: 'wysiwyg',
    previewStyle: 'tab',
    initialValue: current.body,
    usageStatistics: false,
    theme: isDark() ? 'dark' : undefined,
    placeholder: 'Write your review. Paste screenshots with Ctrl+V.',
    toolbarItems: [
      ['heading', 'bold', 'italic', 'strike'],
      ['ul', 'ol', 'task', 'quote'],
      ['code', 'codeblock', 'link', 'image', 'hr'],
    ],
    hooks: { addImageBlobHook: onImage },
    events: {
      change: () => {
        if (loading) return;
        dirty = true;
        scheduleSave();
      },
    },
  });
  setTimeout(() => (loading = false), 0);
}

function finishEdit() {
  save();
  current.mode = 'read';
  reopen(); // queued behind the save, so the read view shows the saved text
}

function onImage(blob, callback) {
  if (!current) return;
  setSaveState('Saving screenshot…');
  const reader = new FileReader();
  reader.onload = () => {
    const requestId = ++requestSeq;
    pendingImages.set(requestId, callback);
    vscode.postMessage({ type: 'pasteImage', requestId, noteId: current.noteId, dataUrl: reader.result });
  };
  reader.readAsDataURL(blob);
}

function scheduleSave(delay = SAVE_DELAY_MS) {
  clearTimeout(saveTimer);
  setSaveState('Editing…');
  saveTimer = setTimeout(save, delay);
}

function save() {
  clearTimeout(saveTimer);
  if (!current || !editor || !dirty) return;
  dirty = false;
  setSaveState('Saving…');
  vscode.postMessage({
    type: 'save',
    bookmarkId: current.bookmark?.id,
    noteId: current.noteId,
    body: editor.getMarkdown(),
    status: document.getElementById('status')?.value ?? 'open',
  });
}

function goBack() {
  save();
  if (replyDraft) vscode.postMessage({ type: 'discardDraft', noteId: current.noteId });
  destroyEditors();
  renderList();
}

// Screenshots in the read view open in the Windows image viewer. Capture phase, so the
// Toast UI viewer can't swallow the click.
document.addEventListener('click', (e) => {
  const img = e.target.closest?.('.note-body img, .reply-body img');
  if (!img) return;
  e.preventDefault();
  setSaveState('Opening screenshot…');
  vscode.postMessage({ type: 'openImage', src: img.getAttribute('src') });
}, true);

// ---- messages from the extension ----------------------------------------------

window.addEventListener('message', ({ data: msg }) => {
  switch (msg.type) {
    case 'state':
      state = msg;
      if (!current) {
        renderList();
      } else if (current.bookmark) {
        const live = state.workflows.flatMap((w) => w.bookmarks).find((b) => b.id === current.bookmark.id);
        if (!live) {
          save();
          destroyEditors();
          renderList();
        } else if (live.annotation !== current.bookmark.annotation) {
          current.bookmark = live;
          document.getElementById('studioMsg')?.replaceChildren(live.annotation || h('em', { class: 'muted' }, '(none)'));
        }
      }
      break;
    case 'activeWorkflow':
      if (state) state.activeWorkflow = msg.file;
      if (state && !current) renderList();
      break;
    case 'note':
      renderNote(msg);
      break;
    case 'saved':
      if (current?.noteId === msg.noteId) {
        current.meta = msg.meta;
        document.getElementById('meta')?.replaceChildren(metaText(msg.meta));
        renderStatusRow();
        if (!dirty) setSaveState(msg.removed ? 'Empty note removed' : msg.meta ? 'Saved' : '');
      }
      break;
    case 'replyError':
      setSaveState(msg.error);
      break;
    case 'notice':
      setSaveState(msg.text);
      setTimeout(() => {
        if (document.getElementById('saveState')?.textContent === msg.text) setSaveState('');
      }, 4000);
      break;
    case 'imageSaved': {
      const callback = pendingImages.get(msg.requestId);
      pendingImages.delete(msg.requestId);
      callback?.(msg.src, 'screenshot');
      setSaveState('');
      break;
    }
    case 'imageError':
      pendingImages.delete(msg.requestId);
      setSaveState(msg.error);
      break;
    case 'noteChangedOnDisk':
      // Someone else's change (e.g. git pull). Reload unless the user is typing a note or a reply.
      if (current?.noteId === msg.noteId && !dirty && !replyDraft) reopen();
      break;
    case 'deleted':
      if (current?.noteId === msg.noteId) {
        destroyEditors();
        renderList();
      }
      break;
  }
});

window.addEventListener('pagehide', save);
vscode.postMessage({ type: 'ready' });

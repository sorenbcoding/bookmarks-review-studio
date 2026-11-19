// Sidebar UI: bookmark list + WYSIWYG note editor (Toast UI Editor, stores Markdown).
import Editor from '@toast-ui/editor';
import '@toast-ui/editor/dist/toastui-editor.css';
import '@toast-ui/editor/dist/theme/toastui-editor-dark.css';
import './style.css';

const vscode = acquireVsCodeApi();
const app = document.getElementById('app');

const STATUS_LABELS = { open: 'Open', resolved: 'Resolved', wontfix: "Won't fix" };
const SAVE_DELAY_MS = 800;

let state = null; // last 'state' message
let current = null; // { bookmark, noteId, orphan, meta }
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
  destroyEditor();
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

// ---- note view --------------------------------------------------------------

function renderNote(msg) {
  destroyEditor();
  current = { bookmark: msg.bookmark, noteId: msg.noteId, orphan: msg.orphan, meta: msg.meta };
  dirty = false;
  const b = msg.bookmark;
  const m = msg.meta;

  const status = h('select', { id: 'status', onchange: () => { dirty = true; scheduleSave(0); } },
    Object.entries(STATUS_LABELS).map(([value, label]) => h('option', { value, selected: (m?.status || 'open') === value }, label)));

  app.replaceChildren(
    h('div', { class: 'topbar' },
      h('button', { class: 'back', onclick: goBack }, '← All bookmarks'),
      h('span', { id: 'saveState', class: 'muted small' })),
    h('h2', {}, b?.activityName || m?.activityName || 'Review note'),
    h('div', { class: 'pathbar' },
      h('span', { class: 'muted small path' }, b?.file || m?.workflow || ''),
      (b?.file || m?.workflow)
        ? h('button', { class: 'link small', title: 'Bring this workflow to the front in Studio. Use Focus in the Markers panel to jump to the activity.', onclick: () => showInStudio(b?.file || m?.workflow) }, 'Show in Studio')
        : null),
    msg.orphan
      ? h('div', { class: 'banner' },
          h('span', {}, 'The bookmark for this note was deleted in Studio.'),
          h('button', { class: 'danger', onclick: () => vscode.postMessage({ type: 'deleteNote', noteId: msg.noteId }) }, 'Delete note'))
      : null,
    b ? h('div', { class: 'studio-msg' },
          h('span', { class: 'label' }, 'Studio message'),
          h('div', { id: 'studioMsg' }, b.annotation || h('em', { class: 'muted' }, '(none)'))) : null,
    h('div', { class: 'fields' }, h('label', { for: 'status' }, 'Status'), status, h('span', { id: 'meta', class: 'muted small' }, metaText(m))),
    h('div', { id: 'editor' })
  );

  loading = true;
  editor = new Editor({
    el: document.getElementById('editor'),
    height: 'auto',
    minHeight: '260px',
    initialEditType: 'wysiwyg',
    previewStyle: 'tab',
    initialValue: msg.body,
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

function metaText(meta) {
  if (!meta) return 'New note: start typing below.';
  return `By ${meta.author || 'unknown'} · updated ${formatTime(meta.updated)}`;
}

function destroyEditor() {
  clearTimeout(saveTimer);
  editor?.destroy();
  editor = null;
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
  renderList();
}

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
        if (!dirty) setSaveState(msg.removed ? 'Empty note removed' : msg.meta ? 'Saved' : '');
      }
      break;
    case 'imageSaved': {
      const callback = pendingImages.get(msg.requestId);
      pendingImages.delete(msg.requestId);
      callback?.(msg.src, 'screenshot');
      break;
    }
    case 'imageError':
      pendingImages.delete(msg.requestId);
      setSaveState(msg.error);
      break;
    case 'noteChangedOnDisk':
      // Someone else's change (e.g. git pull). Reload unless the user is typing.
      if (current?.noteId === msg.noteId && !dirty) open(current.bookmark ? { bookmarkId: current.bookmark.id } : { noteId: msg.noteId });
      break;
    case 'deleted':
      if (current?.noteId === msg.noteId) renderList();
      break;
  }
});

window.addEventListener('pagehide', save);
vscode.postMessage({ type: 'ready' });

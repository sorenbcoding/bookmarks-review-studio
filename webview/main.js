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
let wrapUp = null; // { folder, remove, phase: 'form' | 'exporting' | 'done', result, error } while the wrap-up view is shown
let settingsView = null; // { hideOrphans, removeBookmarks, phase: 'form' | 'deleting' | 'done', result } while Settings is shown
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

/**
 * A button that asks "question  [Yes label] [Cancel]" in place before running onConfirm.
 * Confirmation stays in the panel: Studio's host dialogs aren't relied on.
 */
function confirmButton({ label, question, yes, onConfirm, cls = 'link small' }) {
  const wrap = h('span', { class: 'confirm' });
  const idle = () => wrap.replaceChildren(h('button', { class: cls, onclick: ask }, label));
  function ask() {
    wrap.replaceChildren(
      h('span', { class: 'confirm-question small' }, question),
      h('button', { class: 'btn danger-btn small', onclick: () => { wrap.replaceChildren(h('span', { class: 'muted small' }, 'Deleting…')); onConfirm(); } }, yes),
      h('button', { class: 'btn small', onclick: idle }, 'Cancel'));
    wrap.querySelector('.danger-btn')?.focus();
  }
  idle();
  return wrap;
}

function setSaveState(text) {
  const node = document.getElementById('saveState');
  if (node) node.textContent = text;
}

// ---- list view --------------------------------------------------------------

function renderList() {
  destroyEditors();
  current = null;
  wrapUp = null;
  settingsView = null;
  app.replaceChildren();
  if (!state) return app.append(h('p', { class: 'muted' }, 'Loading…'));
  if (!state.hasProject) return app.append(h('p', { class: 'muted' }, 'Open a UiPath project to see its bookmarks.'));

  const all = state.workflows.flatMap((w) => w.bookmarks);
  const withNotes = all.filter((b) => b.note).length;
  const openCount = all.filter((b) => b.note?.status === 'open').length;
  const toggle = h('input', { type: 'checkbox', id: 'onlyCurrent', checked: prefs.onlyCurrent, onchange: (e) => {
    prefs.onlyCurrent = e.target.checked;
    savePrefs();
    renderList();
  } });
  app.append(
    h('div', { class: 'listbar' },
      h('span', { class: 'muted' }, `${plural(all.length, 'bookmark')} · ${withNotes} with notes · ${openCount} open`),
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

  app.append(h('div', { class: 'list-footer' },
    noteSummaries().length
      ? h('button', { class: 'btn', title: 'Export all notes to a zip archive and remove them from the project', onclick: startWrapUp }, 'Wrap up review…')
      : null,
    h('button', { class: 'btn', title: 'Settings, and deleting all notes or bookmarks', onclick: startSettings }, 'Settings…')));

  // Notes whose bookmark was deleted in Studio. With "This workflow only", only that workflow's.
  const orphans = prefs.onlyCurrent ? state.orphans.filter((o) => isCurrent(o.workflow)) : state.orphans;
  const setHidden = (value) => vscode.postMessage({ type: 'setHideOrphans', value });
  if (orphans.length && state.hideOrphans) {
    app.append(
      h('p', { class: 'muted small hidden-orphans' },
        `${orphans.length === 1 ? '1 note' : `${orphans.length} notes`} without a bookmark hidden. `,
        h('button', { class: 'link small', onclick: () => setHidden(false) }, 'Show')));
  } else if (orphans.length) {
    app.append(
      h('div', { class: 'wf-head' },
        h('h3', { class: 'workflow' }, 'Notes without a bookmark'),
        h('span', { class: 'topbar-right' },
          h('button', { class: 'link small', title: 'Hide notes whose bookmark was deleted. The files are kept.', onclick: () => setHidden(true) }, 'Hide'),
          confirmButton({
            label: 'Delete all',
            question: `Delete ${orphans.length === 1 ? 'this note' : `all ${orphans.length} notes`} with replies and screenshots?`,
            yes: 'Delete',
            onConfirm: () => vscode.postMessage({ type: 'deleteOrphans', noteIds: orphans.map((o) => o.noteId) }),
          }))),
      h('p', { class: 'muted small' }, 'Their bookmark was deleted in Studio. Re-add a bookmark on the same activity to re-attach a note, or open a note to delete it.'),
      h('ul', { class: 'rows' }, orphans.map((o) =>
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

// ---- settings: the two switches, and deleting all notes (and bookmarks) ---------

function startSettings() {
  destroyEditors();
  current = null;
  wrapUp = null;
  settingsView = { hideOrphans: Boolean(state?.hideOrphans), removeBookmarks: false, phase: 'form' };
  vscode.postMessage({ type: 'settingsInfo' });
  renderSettings();
}

function settingCheckbox(id, label, hint, checked, onchange) {
  return h('label', { class: 'radio' },
    h('input', { type: 'checkbox', id, checked, disabled: settingsView.phase === 'deleting', onchange: (e) => onchange(e.target.checked) }),
    h('span', {}, label, h('span', { class: 'muted small hint' }, hint)));
}

function renderSettings() {
  const notes = noteSummaries().length;
  const bookmarks = state ? state.workflows.reduce((n, w) => n + w.bookmarks.length, 0) : 0;
  const deleteAll = (withBookmarks) => {
    settingsView.phase = 'deleting';
    // Only what the confirmation counted is deleted; anything added since stays.
    vscode.postMessage({
      type: 'deleteAll',
      withBookmarks,
      noteIds: noteSummaries().map((n) => n.noteId),
      bookmarkIds: withBookmarks && state ? state.workflows.flatMap((w) => w.bookmarks.map((b) => b.id)) : [],
    });
    renderSettings();
  };
  let actions;
  if (settingsView.phase === 'deleting') {
    actions = h('p', { class: 'muted' }, 'Deleting…');
  } else if (settingsView.phase === 'done') {
    const r = settingsView.result;
    actions = h('div', {},
      h('p', {}, `Deleted ${plural(r.notes, 'note')}${r.withBookmarks ? ` and removed ${plural(r.bookmarks, 'bookmark')} from Studio` : ''}. Commit the change to finish it in Git.`),
      h('button', { class: 'btn', onclick: renderList }, 'Done'));
  } else {
    actions = h('div', { class: 'danger-actions' },
      notes
        ? confirmButton({
            label: 'Delete all notes',
            cls: 'btn danger-btn',
            question: `Delete all ${plural(notes, 'note')} with their replies and screenshots?`,
            yes: `Delete ${plural(notes, 'note')}`,
            onConfirm: () => deleteAll(false),
          })
        : h('p', { class: 'muted small' }, 'There are no notes to delete.'),
      notes || bookmarks
        ? confirmButton({
            label: 'Delete all notes and bookmarks',
            cls: 'btn danger-btn',
            question: `Delete all ${plural(notes, 'note')} and remove all ${plural(bookmarks, 'bookmark')} from Studio?`,
            yes: 'Delete everything',
            onConfirm: () => deleteAll(true),
          })
        : null);
  }
  app.replaceChildren(
    h('div', { class: 'topbar' },
      h('button', { class: 'btn back', onclick: renderList, disabled: settingsView.phase === 'deleting' }, '← All bookmarks')),
    h('h2', {}, 'Settings'),
    h('div', { class: 'radios' },
      settingCheckbox('setHideOrphans', 'Hide notes without a bookmark', 'The note files are kept and still re-attach.', settingsView.hideOrphans, (value) => {
        settingsView.hideOrphans = value;
        vscode.postMessage({ type: 'setHideOrphans', value });
      }),
      settingCheckbox('setRemoveBookmarks', "Remove Studio's bookmarks when wrapping up a review", 'Bookmarks of notes that stay in the project are kept.', settingsView.removeBookmarks, (value) => {
        settingsView.removeBookmarks = value;
        vscode.postMessage({ type: 'setRemoveBookmarks', value });
      })),
    h('section', { class: 'danger-zone' },
      h('h3', { class: 'section-title' }, 'Delete'),
      h('p', { class: 'small' },
        `${plural(notes, 'note')} and ${plural(bookmarks, 'bookmark')} in this project. Deleting can't be undone in Studio. Only committed files can be restored from Git. To keep a record, use `,
        h('button', { class: 'link small', onclick: startWrapUp, disabled: !notes || settingsView.phase === 'deleting' }, 'Wrap up review…'),
        ' instead.'),
      actions));
}

// ---- wrap up: export the review to an archive and remove notes ----------------

/** Summaries of every note: on a bookmark or without one. */
function noteSummaries() {
  if (!state) return [];
  return [...state.workflows.flatMap((w) => w.bookmarks).filter((b) => b.note).map((b) => b.note), ...state.orphans];
}

function startWrapUp() {
  destroyEditors();
  current = null;
  settingsView = null;
  wrapUp = { folder: null, remove: 'closed', removeBookmarks: false, phase: 'form' };
  vscode.postMessage({ type: 'wrapUpInfo' });
  renderWrapUp();
}

const REMOVE_OPTIONS = [
  { value: 'closed', label: "Remove resolved and won't fix notes", hint: 'Open notes stay for the next round.' },
  { value: 'all', label: 'Remove all notes', hint: 'The project has no review notes afterwards.' },
  { value: 'none', label: 'Keep all notes', hint: 'Only export the archive.' },
];

function removalCount(notes, mode) {
  if (mode === 'all') return notes.length;
  if (mode === 'closed') return notes.filter((n) => n.status === 'resolved' || n.status === 'wontfix').length;
  return 0;
}

function renderWrapUp() {
  const notes = noteSummaries();
  const by = (st) => notes.filter((n) => (n.status || 'open') === st).length;
  const replies = notes.reduce((n, x) => n + (x.replyCount || 0), 0);
  const shots = notes.reduce((n, x) => n + (x.imageCount || 0), 0);
  const top = h('div', { class: 'topbar' },
    h('button', { class: 'btn back', onclick: renderList, disabled: wrapUp.phase === 'exporting' }, '← All bookmarks'));

  if (wrapUp.phase === 'done') {
    const r = wrapUp.result;
    app.replaceChildren(top,
      h('h2', {}, 'Review archived'),
      h('p', {}, 'Saved ', h('span', { class: 'path' }, r.file), '.'),
      h('p', {}, r.removed
        ? `Removed ${plural(r.removed, 'note')} from the project${r.kept ? `, kept ${r.kept}` : ''}. Commit the change to .review/ to finish the review in Git.`
        : 'No notes were removed.'),
      r.changed
        ? h('p', {}, `Kept ${plural(r.changed, 'note')} that changed during the export, so the archive doesn't hold the current version. Wrap up again to archive and remove them.`)
        : null,
      r.removedBookmarks
        ? h('p', {}, `Removed ${plural(r.removedBookmarks, 'bookmark')} from Studio. The archive has a copy in studio-bookmarks.json.`)
        : null,
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: () => vscode.postMessage({ type: 'revealArchive' }) }, 'Show in Explorer'),
        h('button', { class: 'btn', onclick: renderList }, 'Done')));
    return;
  }

  const toRemove = removalCount(notes, wrapUp.remove);
  const exportLabel = toRemove ? `Export and remove ${plural(toRemove, 'note')}` : 'Export archive';
  const exportNow = () => {
    wrapUp.phase = 'exporting';
    wrapUp.error = null;
    vscode.postMessage({ type: 'exportArchive', remove: wrapUp.remove });
    renderWrapUp();
  };
  app.replaceChildren(top,
    h('h2', {}, 'Wrap up review'),
    h('p', { class: 'muted' },
      `${plural(notes.length, 'note')}: ${by('open')} open, ${by('resolved')} resolved, ${by('wontfix')} won't fix · ${replies === 1 ? '1 reply' : `${replies} replies`} · ${plural(shots, 'screenshot')}`),
    h('p', {}, 'The archive is a zip file with:'),
    h('ul', { class: 'wrapup-list' },
      h('li', {}, h('strong', {}, 'report.html'), ': every note with its replies and screenshots, for any browser.'),
      h('li', {}, h('strong', {}, 'summary.md'), ': the same as Markdown.'),
      h('li', {}, h('strong', {}, '.review/'), ': the note files. Unzip into a project to restore them.'),
      h('li', {}, h('strong', {}, 'studio-bookmarks.json'), ": Studio's bookmarks at the time.")),
    h('h3', { class: 'section-title' }, 'Save to'),
    h('div', { class: 'pathbar' },
      h('span', { class: 'path small', id: 'archiveFolder' }, wrapUp.folder ?? '…'),
      h('button', { class: 'link small', onclick: () => vscode.postMessage({ type: 'chooseArchiveFolder' }), disabled: wrapUp.phase === 'exporting' }, 'Change…')),
    h('h3', { class: 'section-title' }, 'After the export'),
    h('div', { class: 'radios', role: 'radiogroup' }, REMOVE_OPTIONS.map((o) =>
      h('label', { class: 'radio' },
        h('input', { type: 'radio', name: 'remove', value: o.value, checked: wrapUp.remove === o.value, disabled: wrapUp.phase === 'exporting', onchange: () => {
          wrapUp.remove = o.value;
          renderWrapUp();
        } }),
        h('span', {}, o.label, h('span', { class: 'muted small hint' }, `${o.hint} ${removalCount(notes, o.value) ? `(${removalCount(notes, o.value)})` : ''}`.trim()))))),
    h('label', { class: 'radio' },
      h('input', { type: 'checkbox', id: 'removeBookmarks', checked: wrapUp.removeBookmarks, disabled: wrapUp.phase === 'exporting', onchange: (e) => {
        wrapUp.removeBookmarks = e.target.checked;
        vscode.postMessage({ type: 'setRemoveBookmarks', value: e.target.checked });
        renderWrapUp();
      } }),
      h('span', {}, "Also remove Studio's bookmarks",
        h('span', { class: 'muted small hint' }, 'Bookmarks of notes that stay in the project are kept. Saved as a setting.'))),
    h('p', { class: 'muted small' }, wrapUp.removeBookmarks
      ? 'Notes and bookmarks are removed only after the archive is saved.'
      : "Notes are removed only after the archive is saved. Studio's bookmarks are not changed."),
    wrapUp.error ? h('p', { class: 'error' }, wrapUp.error) : null,
    h('div', { class: 'actions' },
      wrapUp.phase === 'exporting'
        ? h('span', { class: 'muted' }, 'Exporting…')
        : toRemove
          ? confirmButton({
              label: exportLabel,
              cls: 'btn primary',
              question: `Remove ${plural(toRemove, 'note')} from the project after the export?`,
              yes: exportLabel,
              onConfirm: exportNow,
            })
          : h('button', { class: 'btn primary', onclick: exportNow, disabled: !notes.length }, exportLabel)));
}

/** Renders Markdown pieces to HTML with the Toast UI viewer, for report.html. */
function renderReport({ requestId, sections }) {
  const html = {};
  const host = h('div', { class: 'render-host', 'aria-hidden': 'true' });
  document.body.append(host);
  try {
    for (const { id, markdown } of sections) {
      const el = h('div');
      host.append(el);
      const viewer = Editor.factory({ el, viewer: true, initialValue: String(markdown ?? ''), usageStatistics: false });
      const contents = el.querySelector('.toastui-editor-contents');
      for (const node of contents?.querySelectorAll('[data-nodeid]') ?? []) node.removeAttribute('data-nodeid');
      html[id] = contents?.innerHTML ?? '';
      viewer.destroy?.();
    }
  } finally {
    host.remove();
  }
  vscode.postMessage({ type: 'reportRendered', requestId, html });
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
          confirmButton({
            label: 'Delete note',
            question: 'Delete this note, its replies and screenshots?',
            yes: 'Delete',
            cls: 'danger',
            onConfirm: () => vscode.postMessage({ type: 'deleteNote', noteId: current.noteId }),
          }))
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
              confirmButton({
                label: 'Delete',
                question: 'Delete this reply?',
                yes: 'Delete',
                onConfirm: () => vscode.postMessage({ type: 'deleteReply', bookmarkId: current.bookmark?.id, noteId: current.noteId, replyId: r.id }),
              }))
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
      if (wrapUp) {
        if (wrapUp.phase === 'form') renderWrapUp();
      } else if (settingsView) {
        if (settingsView.phase === 'form') renderSettings();
      } else if (!current) {
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
      if (state && !current && !wrapUp && !settingsView) renderList();
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
    case 'wrapUpInfo':
      if (wrapUp) {
        const changed = wrapUp.removeBookmarks !== (msg.removeBookmarks === true);
        wrapUp.folder = msg.folder;
        wrapUp.removeBookmarks = msg.removeBookmarks === true;
        if (changed && wrapUp.phase === 'form') renderWrapUp();
        else document.getElementById('archiveFolder')?.replaceChildren(msg.folder);
      }
      break;
    case 'renderReport':
      renderReport(msg);
      break;
    case 'archived':
      if (wrapUp) {
        wrapUp.phase = 'done';
        wrapUp.result = msg;
        renderWrapUp();
      }
      break;
    case 'archiveError':
      if (wrapUp) {
        wrapUp.phase = 'form';
        wrapUp.error = msg.error;
        renderWrapUp();
      }
      break;
    case 'settingsInfo':
      if (settingsView && settingsView.phase === 'form') {
        settingsView.hideOrphans = msg.hideOrphans === true;
        settingsView.removeBookmarks = msg.removeBookmarks === true;
        renderSettings();
      }
      break;
    case 'allDeleted':
      if (settingsView) {
        settingsView.phase = 'done';
        settingsView.result = msg;
        renderSettings();
      }
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

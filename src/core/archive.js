// Review archive ("wrap up"): summary.md, report.html, and which notes to remove afterwards.
// Pure functions; the controller reads the files and writes the zip.

const STATUS_LABELS = { open: 'Open', resolved: 'Resolved', wontfix: "Won't fix" };
const REMOVE_MODES = ['closed', 'all', 'none'];
const ASSET_LINK = /\]\((?:\.\.\/)+assets\//g;
const ARCHIVE_ASSET = /^\.review\/assets\/([0-9a-f-]{36})\/([\w.-]+\.(png|jpg|gif|webp|bmp))$/i;
const MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };

/** Screenshot links relative to a note (../assets/) or reply (../../assets/) → relative to the archive root. */
function toArchiveLinks(body) {
  return String(body ?? '').replace(ASSET_LINK, '](.review/assets/');
}

const statusLabel = (status) => STATUS_LABELS[status] ?? STATUS_LABELS.open;

/** Date as yyyy-mm-dd hh:mm (local time). */
function formatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso ? String(iso) : '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** File name for the archive: <project>-review-<yyyy-mm-dd-hhmm>.zip, safe on Windows. */
function archiveName(projectName, date = new Date()) {
  const safe = String(projectName || 'project').replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-').replace(/[-. ]+$/, '') || 'project';
  return `${safe}-review-${formatDate(date.toISOString()).replace(/[ :]/g, '-').replace(/-(\d\d)-(\d\d)$/, '-$1$2')}.zip`;
}

/**
 * Notes to put in the archive, grouped by workflow in Studio's bookmark order; notes whose
 * bookmark is gone come last in their workflow.
 * @param {{ bookmarks: object[], attached: Map<string, object>, orphans: object[], replies: Map<string, object[]> }} input
 */
function collectEntries({ bookmarks, attached, orphans, replies }) {
  const groups = new Map();
  const add = (workflow, entry) => {
    const key = workflow || '(unknown workflow)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  };
  for (const b of bookmarks) {
    const note = attached.get(b.id);
    if (note) add(b.file, { note, bookmark: b, orphan: false, replies: replies.get(note.meta.noteId) ?? [] });
  }
  for (const note of orphans) {
    add(note.meta.workflow, { note, bookmark: null, orphan: true, replies: replies.get(note.meta.noteId) ?? [] });
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([workflow, entries]) => ({ workflow, entries }));
}

function counts(groups) {
  const all = groups.flatMap((g) => g.entries);
  const by = (s) => all.filter((e) => (e.note.meta.status || 'open') === s).length;
  return {
    notes: all.length,
    open: by('open'),
    resolved: by('resolved'),
    wontfix: by('wontfix'),
    replies: all.reduce((n, e) => n + e.replies.length, 0),
  };
}

function countsText(c) {
  return `${c.notes} ${c.notes === 1 ? 'note' : 'notes'}: ${c.open} open, ${c.resolved} resolved, ${c.wontfix} won't fix. ${c.replies} ${c.replies === 1 ? 'reply' : 'replies'}.`;
}

const activityOf = (e) => e.bookmark?.activityName || e.note.meta.activityName || 'Review note';
const annotationOf = (e) => e.bookmark?.annotation ?? null;
const metaLine = (meta) =>
  `By ${meta.author || 'unknown'} · created ${formatDate(meta.created)}${meta.updated && meta.updated !== meta.created ? ` · updated ${formatDate(meta.updated)}` : ''}`;
const replyTime = (r) => `${formatDate(r.meta.created)}${r.meta.updated && r.meta.updated !== r.meta.created ? ' (edited)' : ''}`;
const replyLine = (r) => `${r.meta.author || 'unknown'} · ${replyTime(r)}`;

/** summary.md: the whole review as one Markdown file, screenshots linked into .review/assets/. */
function buildSummary({ projectName, exportedAt, author, groups }) {
  const out = [`# Review of ${projectName}`, '', `Exported ${formatDate(exportedAt)} by ${author}. ${countsText(counts(groups))}`, ''];
  for (const { workflow, entries } of groups) {
    out.push(`## ${workflow}`, '');
    for (const e of entries) {
      out.push(`### ${activityOf(e)} — ${statusLabel(e.note.meta.status)}`, '');
      out.push(`*${metaLine(e.note.meta)}*`, '');
      if (e.orphan) out.push('*The bookmark was deleted in Studio.*', '');
      const annotation = annotationOf(e);
      if (annotation) out.push(...annotation.split(/\r?\n/).map((l) => `> ${l}`), '');
      out.push(toArchiveLinks(e.note.body).trim() || '*No text.*', '');
      if (e.replies.length) {
        out.push(`#### Replies (${e.replies.length})`, '');
        for (const r of e.replies) out.push(`**${replyLine(r)}**`, '', toArchiveLinks(r.body).trim(), '');
      }
      out.push('---', '');
    }
  }
  return out.join('\n');
}

/** Markdown pieces for the panel to render to HTML: { id, markdown }. */
function renderSections(groups) {
  const sections = [];
  for (const { entries } of groups) {
    for (const e of entries) {
      sections.push({ id: `note:${e.note.meta.noteId}`, markdown: toArchiveLinks(e.note.body) });
      for (const r of e.replies) sections.push({ id: `reply:${e.note.meta.noteId}:${r.id}`, markdown: toArchiveLinks(r.body) });
    }
  }
  return sections;
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Replaces screenshot links (.review/assets/<noteId>/<file>) with embedded data URIs.
 * @param {string} html
 * @param {(noteId: string, file: string) => Buffer | null} readAsset
 */
function embedImages(html, readAsset) {
  return html.replace(/(<img\b[^>]*?\bsrc=")([^"]*)(")/gi, (match, before, src, after) => {
    let path = src.replace(/&amp;/g, '&');
    try {
      path = decodeURIComponent(path);
    } catch {
      return match;
    }
    const m = ARCHIVE_ASSET.exec(path);
    const data = m && readAsset(m[1], m[2]);
    return data ? `${before}data:${MIME[m[3].toLowerCase()]};base64,${data.toString('base64')}${after}` : match;
  });
}

/**
 * report.html: a self-contained page. Note and reply bodies come pre-rendered (and sanitized) by the
 * panel's Toast UI viewer; a body that wasn't rendered is shown as plain text.
 */
function buildReportHtml({ projectName, exportedAt, author, groups, rendered, css, readAsset }) {
  const body = (id, markdown) => {
    const html = rendered?.[id];
    return typeof html === 'string' ? embedImages(html, readAsset) : `<pre class="raw">${escapeHtml(markdown)}</pre>`;
  };
  const parts = [];
  for (const { workflow, entries } of groups) {
    const slash = workflow.lastIndexOf('/');
    parts.push(`<section class="workflow"><h2>${escapeHtml(workflow.slice(slash + 1))}</h2>`);
    if (slash >= 0) parts.push(`<p class="folder">${escapeHtml(workflow.slice(0, slash))}</p>`);
    for (const e of entries) {
      const status = e.note.meta.status in STATUS_LABELS ? e.note.meta.status : 'open';
      const annotation = annotationOf(e);
      parts.push(
        '<article class="note">',
        `<div class="note-head"><h3>${escapeHtml(activityOf(e))}</h3><span class="badge ${status}">${escapeHtml(statusLabel(status))}</span></div>`,
        `<p class="meta">${escapeHtml(metaLine(e.note.meta))}</p>`,
        e.orphan ? '<p class="orphan">The bookmark was deleted in Studio.</p>' : '',
        annotation ? `<div class="studio-msg"><span class="label">Studio message</span>${escapeHtml(annotation)}</div>` : '',
        e.note.body.trim() ? `<div class="body">${body(`note:${e.note.meta.noteId}`, toArchiveLinks(e.note.body))}</div>` : '<p class="muted">No text.</p>'
      );
      if (e.replies.length) {
        parts.push(`<section class="replies"><h4>Replies (${e.replies.length})</h4>`);
        for (const r of e.replies) {
          parts.push(
            '<article class="reply">',
            `<p class="meta"><strong>${escapeHtml(r.meta.author || 'unknown')}</strong> · ${escapeHtml(replyTime(r))}</p>`,
            `<div class="body">${body(`reply:${e.note.meta.noteId}:${r.id}`, toArchiveLinks(r.body))}</div>`,
            '</article>'
          );
        }
        parts.push('</section>');
      }
      parts.push('</article>');
    }
    parts.push('</section>');
  }
  const title = `Review of ${projectName}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${css}
</style>
</head>
<body>
<main>
<header><h1>${escapeHtml(title)}</h1><p class="muted">Exported ${escapeHtml(formatDate(exportedAt))} by ${escapeHtml(author)}. ${escapeHtml(countsText(counts(groups)))}</p></header>
${parts.filter(Boolean).join('\n')}
<footer>Made with Bookmarks Review for UiPath Studio.</footer>
</main>
</body>
</html>
`;
}

/** Note ids to remove after the export. 'closed' = resolved and won't fix; open notes stay. */
function notesToRemove(groups, mode) {
  const all = groups.flatMap((g) => g.entries.map((e) => e.note.meta));
  if (mode === 'all') return all.map((m) => m.noteId);
  if (mode === 'closed') return all.filter((m) => m.status === 'resolved' || m.status === 'wontfix').map((m) => m.noteId);
  return [];
}

module.exports = {
  REMOVE_MODES,
  toArchiveLinks,
  archiveName,
  collectEntries,
  counts,
  buildSummary,
  renderSections,
  embedImages,
  buildReportHtml,
  notesToRemove,
  escapeHtml,
};

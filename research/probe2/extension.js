// Probe 2: navigation between Studio and an extension.
// Q1 (Studio -> extension): does anything fire when a workflow is opened, a bookmark is focused or an activity selected?
// Q2 (extension -> Studio): can rpaCanvas.openCanvas (or another command) open a workflow / activity?
// Q3: do UiPath's built-in extensions export an API to other extensions?
//
// Output: <project>/.review/probe2/probe2-log.txt (live event log) and probe2-report.json.
// Delete the .review/probe2 folder after testing.

const vscode = require('vscode');
const path = require('path');

/** @type {vscode.OutputChannel} */
let out;
/** @type {vscode.ExtensionContext} */
let ctx;
/** @type {vscode.Uri | undefined} */
let root;
/** @type {vscode.WebviewView | undefined} */
let view;
const logLines = [];
let logDirty = false;
const report = { time: new Date().toISOString() };

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function json(value) {
  try {
    const s = JSON.stringify(value);
    return s && s.length > 3000 ? `${s.slice(0, 3000)}…` : s;
  } catch (err) {
    return `[unserializable: ${err}]`;
  }
}

function log(kind, msg, data) {
  const line = `${new Date().toISOString().slice(11, 23)} [${kind}] ${msg}${data !== undefined ? ` ${json(data)}` : ''}`;
  logLines.push(line);
  out?.appendLine(line);
  logDirty = true;
  view?.webview.postMessage({ type: 'log', line });
}

function probeDir() {
  return root ? vscode.Uri.joinPath(root, '.review', 'probe2') : ctx.globalStorageUri;
}

async function flush() {
  if (!logDirty) return;
  logDirty = false;
  try {
    await vscode.workspace.fs.createDirectory(probeDir());
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(probeDir(), 'probe2-log.txt'), Buffer.from(logLines.join('\n') + '\n'));
  } catch (err) {
    out.appendLine(`Could not write log: ${err}`);
  }
}

async function saveReport() {
  try {
    await vscode.workspace.fs.createDirectory(probeDir());
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(probeDir(), 'probe2-report.json'), Buffer.from(JSON.stringify(report, null, 2)));
  } catch (err) {
    out.appendLine(`Could not write report: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Describers
// ---------------------------------------------------------------------------

const rel = (uri) => (uri && root && uri.fsPath.toLowerCase().startsWith(root.fsPath.toLowerCase()) ? path.relative(root.fsPath, uri.fsPath).replace(/\\/g, '/') : uri?.toString());

function describeInput(input) {
  const is = (name) => typeof vscode[name] === 'function' && input instanceof vscode[name];
  if (is('TabInputText')) return { kind: 'text', uri: rel(input.uri) };
  if (is('TabInputTextDiff')) return { kind: 'diff', original: rel(input.original), modified: rel(input.modified) };
  if (is('TabInputCustom')) return { kind: 'custom', viewType: input.viewType, uri: rel(input.uri) };
  if (is('TabInputWebview')) return { kind: 'webview', viewType: input.viewType };
  if (is('TabInputNotebook')) return { kind: 'notebook', uri: rel(input.uri) };
  if (is('TabInputTerminal')) return { kind: 'terminal' };
  return { kind: 'unknown', ctor: input?.constructor?.name, keys: input ? Object.keys(input) : [] };
}

function describeTab(tab) {
  return { label: tab.label, active: tab.isActive, input: describeInput(tab.input) };
}

function tabsSnapshot() {
  if (!vscode.window.tabGroups) return 'tabGroups API not available';
  return vscode.window.tabGroups.all.map((g) => ({ active: g.isActive, tabs: g.tabs.map(describeTab) }));
}

function editorsSnapshot() {
  return {
    active: vscode.window.activeTextEditor ? rel(vscode.window.activeTextEditor.document.uri) : null,
    visible: vscode.window.visibleTextEditors.map((e) => rel(e.document.uri)),
    textDocuments: vscode.workspace.textDocuments.map((d) => `${rel(d.uri)} (${d.languageId})`),
  };
}

/** Shape of an object (keys, function arities), to see what an extension exports. */
function shape(value, depth = 0, seen = new Set()) {
  if (value === null || value === undefined) return String(value);
  const type = typeof value;
  if (type === 'function') return `function(${value.length})`;
  if (type !== 'object') return type;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (depth >= 3) return Array.isArray(value) ? 'array' : 'object';
  const keys = new Set(Object.keys(value));
  for (let proto = Object.getPrototypeOf(value); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const k of Object.getOwnPropertyNames(proto)) if (k !== 'constructor') keys.add(k);
  }
  const result = {};
  for (const k of [...keys].slice(0, 80)) {
    try {
      result[k] = shape(value[k], depth + 1, seen);
    } catch {
      result[k] = '[error reading]';
    }
  }
  return result;
}

async function extensionsReport(activate) {
  const list = [];
  for (const ext of vscode.extensions.all) {
    const pj = ext.packageJSON ?? {};
    const isBuiltinVsCode = ext.id.startsWith('vscode.') || ext.id.startsWith('ms-vscode.');
    const entry = {
      id: ext.id,
      displayName: pj.displayName,
      version: pj.version,
      isActive: ext.isActive,
      path: ext.extensionPath,
      activationEvents: pj.activationEvents,
      contributes: isBuiltinVsCode ? Object.keys(pj.contributes ?? {}) : pj.contributes,
    };
    if (!isBuiltinVsCode && ext.id !== ctx.extension.id) {
      if (!ext.isActive && activate) {
        try {
          await ext.activate();
        } catch (err) {
          entry.activateError = String(err);
        }
      }
      entry.isActive = ext.isActive;
      entry.exports = ext.isActive ? shape(ext.exports) : '(not active)';
    }
    list.push(entry);
  }
  return list;
}

// ---------------------------------------------------------------------------
// Project data for the command tests
// ---------------------------------------------------------------------------

async function readBookmarks() {
  if (!root) return [];
  try {
    const text = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, '.project', 'bookmarks.json'))).toString('utf8').replace(/^﻿/, '');
    const result = [];
    for (const [file, list] of Object.entries(JSON.parse(text)?.Value ?? {})) {
      for (const b of list ?? []) result.push({ file, id: b.Id, activityIdRef: b.ActivityIdRef, activityName: b.ActivityName, annotation: b.Annotation });
    }
    return result;
  } catch {
    return [];
  }
}

async function workflows() {
  const files = await vscode.workspace.findFiles('**/*.xaml', '{**/.local/**,**/.objects/**,**/node_modules/**}', 300);
  return files.map(rel).sort();
}

// Jump test. Run 1 showed that Studio exposes open workflows to extensions as XML text editors
// (the active one changes when switching workflow tabs), so these are the candidate ways to make Studio
// open a workflow and maybe select an activity. (rpaCanvas.openCanvas belongs to the Low-Code Viewer
// for coded .cs workflows, so it is not tested any more.)
const JUMP_METHODS = {
  A: 'vscode.open (workflow)',
  B: 'showTextDocument (workflow)',
  C: 'showTextDocument + select the activity line',
  D: 'select the activity line in the open editor',
};

/** Finds the IdRef attribute of an activity in the XAML text. */
function findIdRef(doc, ref) {
  const needle = `IdRef="${ref}"`;
  for (let i = 0; i < doc.lineCount; i++) {
    const col = doc.lineAt(i).text.indexOf(needle);
    if (col >= 0) return new vscode.Range(i, col, i, col + needle.length);
  }
  return undefined;
}

async function jump({ method, bookmarkKey }) {
  const b = (await readBookmarks()).find((x) => `${x.file}|${x.id}` === bookmarkKey);
  if (!b) return log('jump', 'No bookmark selected');
  const uri = vscode.Uri.joinPath(root, ...b.file.split('/'));
  log('jump', `RUN ${method}: ${JUMP_METHODS[method]} → ${b.file} / ${b.activityIdRef}`);
  try {
    let range;
    if (method === 'C' || method === 'D') {
      const doc = await vscode.workspace.openTextDocument(uri);
      range = findIdRef(doc, b.activityIdRef);
      log('jump', range ? `IdRef found on line ${range.start.line + 1}` : 'IdRef NOT found in the document text', { lineCount: doc.lineCount });
      if (!range) return;
    }
    if (method === 'A') await vscode.commands.executeCommand('vscode.open', uri);
    if (method === 'B') await vscode.window.showTextDocument(uri);
    if (method === 'C') await vscode.window.showTextDocument(uri, { selection: range });
    if (method === 'D') {
      const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString()) ?? (await vscode.window.showTextDocument(uri));
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    }
    log('jump', `OK ${method}. Active editor now: ${rel(vscode.window.activeTextEditor?.document.uri) ?? '(none)'}`);
  } catch (err) {
    log('jump', `ERROR ${method}: ${err?.message ?? err}`);
  }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

async function activate(context) {
  ctx = context;
  out = vscode.window.createOutputChannel('Navigation Probe');
  root = vscode.workspace.workspaceFolders?.[0]?.uri;
  log('init', `Activated. Host "${vscode.env.appName}" API ${vscode.version}. Project ${root?.fsPath ?? '(none)'}`);

  const timer = setInterval(flush, 1000);
  context.subscriptions.push(out, { dispose: () => clearInterval(timer) });

  // Which event APIs exist at all?
  const apis = {
    tabGroups: !!vscode.window.tabGroups,
    onDidChangeActiveTextEditor: typeof vscode.window.onDidChangeActiveTextEditor,
    onDidChangeTextEditorSelection: typeof vscode.window.onDidChangeTextEditorSelection,
    onDidChangeWindowState: typeof vscode.window.onDidChangeWindowState,
    activeColorThemeKind: vscode.window.activeColorTheme?.kind,
  };
  report.host = { appName: vscode.env.appName, apiVersion: vscode.version, appRoot: vscode.env.appRoot, uriScheme: vscode.env.uriScheme };
  report.apis = apis;
  log('init', 'API availability', apis);

  // Initial snapshots
  report.startup = { tabs: tabsSnapshot(), editors: editorsSnapshot() };
  log('init', 'Tabs at startup', report.startup.tabs);
  log('init', 'Editors at startup', report.startup.editors);
  await snapshotCommands('startup');
  report.extensions = await extensionsReport(false);
  log('init', `Extensions: ${report.extensions.length}`, report.extensions.filter((e) => !/^(vscode|ms-vscode)\./.test(e.id)).map((e) => `${e.id} (active: ${e.isActive})`));

  subscribeEvents(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('bookmarksProbe2.view', { resolveWebviewView: (v) => setupView(v) }, { webviewOptions: { retainContextWhenHidden: true } })
  );
  await saveReport();
}

async function snapshotCommands(label) {
  const all = await vscode.commands.getCommands(false);
  const external = await vscode.commands.getCommands(true);
  report.commands ??= {};
  const previous = report.commands.latestAll ?? [];
  report.commands[label] = { totalIncludingInternal: all.length, totalExternal: external.length, external: external.sort() };
  report.commands.latestAll = all.sort();
  const interesting = all.filter((c) => /canvas|focus|reveal|select|bookmark|marker|xaml|workflow|activity|designer|uipath|studio|open|navigate|goto|go\./i.test(c));
  report.commands[label].interesting = interesting;
  log('commands', `${label}: ${all.length} incl. internal, ${external.length} external, ${interesting.length} interesting`);
  if (previous.length) {
    const added = all.filter((c) => !previous.includes(c));
    const removed = previous.filter((c) => !all.includes(c));
    log('commands', `Since last snapshot: +${added.length} -${removed.length}`, { added, removed });
  }
  view?.webview.postMessage({ type: 'commands', commands: interesting, all });
  await saveReport();
}

function subscribeEvents(context) {
  const w = vscode.window;
  const ws = vscode.workspace;
  const sub = (d) => d && context.subscriptions.push(d);

  sub(
    w.onDidChangeActiveTextEditor?.((e) => {
      if (!e) return log('editor', 'Active text editor', null);
      const doc = e.document;
      log('editor', 'Active text editor', {
        file: rel(doc.uri),
        lineCount: doc.lineCount,
        containsIdRefs: doc.getText().includes('WorkflowViewState.IdRef'),
        selection: { line: e.selection.active.line, ch: e.selection.active.character },
      });
    })
  );
  sub(w.onDidChangeVisibleTextEditors?.((list) => log('editor', 'Visible text editors', list.map((e) => rel(e.document.uri)))));
  sub(
    w.onDidChangeTextEditorSelection?.((e) => {
      const doc = e.textEditor.document;
      log('selection', rel(doc.uri), e.selections.map((s) => ({
        line: s.active.line,
        ch: s.active.character,
        text: doc.lineAt(Math.min(s.active.line, doc.lineCount - 1)).text.trim().slice(0, 200),
      })));
    })
  );
  sub(w.onDidChangeWindowState?.((s) => log('window', 'Window state', { focused: s.focused })));
  sub(w.onDidChangeActiveColorTheme?.((t) => log('theme', 'Color theme kind', t.kind)));
  if (w.tabGroups) {
    sub(
      w.tabGroups.onDidChangeTabs((e) =>
        log('tabs', 'Tabs changed', { opened: e.opened.map(describeTab), closed: e.closed.map(describeTab), changed: e.changed.map(describeTab) })
      )
    );
    sub(w.tabGroups.onDidChangeTabGroups(() => log('tabs', 'Tab groups changed', tabsSnapshot())));
  }
  sub(ws.onDidOpenTextDocument((d) => log('document', 'Opened', `${rel(d.uri)} (${d.languageId})`)));
  sub(ws.onDidCloseTextDocument((d) => log('document', 'Closed', rel(d.uri))));
  sub(ws.onDidSaveTextDocument((d) => log('document', 'Saved', rel(d.uri))));
  const lastChange = new Map();
  sub(
    ws.onDidChangeTextDocument((e) => {
      const key = e.document.uri.toString();
      const now = Date.now();
      if (now - (lastChange.get(key) ?? 0) < 1000) return;
      lastChange.set(key, now);
      log('document', 'Changed', { uri: rel(e.document.uri), changes: e.contentChanges.length });
    })
  );

  if (root) {
    const watcher = ws.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
    const onFile = (kind) => (uri) => {
      const p = rel(uri);
      if (p.startsWith('.review/probe2') || p.startsWith('.git/')) return;
      log('file', `${kind} ${p}`);
    };
    watcher.onDidChange(onFile('changed'));
    watcher.onDidCreate(onFile('created'));
    watcher.onDidDelete(onFile('deleted'));
    sub(watcher);
  }
}

// ---------------------------------------------------------------------------
// Sidebar view
// ---------------------------------------------------------------------------

async function setupView(v) {
  view = v;
  log('view', 'Probe view resolved');
  v.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')] };
  v.webview.onDidReceiveMessage(async (msg) => {
    switch (msg.type) {
      case 'ready':
        v.webview.postMessage({
          type: 'init',
          lines: logLines.slice(-300),
          workflows: await workflows(),
          bookmarks: await readBookmarks(),
          methods: JUMP_METHODS,
        });
        break;
      case 'marker':
        log('MARKER', `===== ${msg.text} =====`);
        break;
      case 'snapshot':
        log('snapshot', 'Tabs', tabsSnapshot());
        log('snapshot', 'Editors', editorsSnapshot());
        break;
      case 'relistCommands':
        await snapshotCommands(`manual-${new Date().toISOString().slice(11, 19)}`);
        break;
      case 'inspectExtensions':
        log('extensions', 'Activating and inspecting non-VS Code extensions…');
        report.extensionsActivated = await extensionsReport(true);
        for (const e of report.extensionsActivated.filter((x) => x.exports !== undefined)) {
          log('extensions', `${e.id} exports`, e.exports);
        }
        await saveReport();
        log('extensions', 'Done; details in probe2-report.json');
        break;
      case 'jump':
        await jump(msg);
        break;
      case 'save':
        await flush();
        await saveReport();
        vscode.window.showInformationMessage(`Navigation probe: files saved in ${probeDir().fsPath}`);
        break;
    }
  });
  v.webview.html = html(v.webview);
}

function html(webview) {
  const nonce = [...Array(32)].map(() => Math.random().toString(36)[2]).join('');
  const media = (f) => webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', f));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${media('panel.css')}">
  <title>Navigation probe</title>
</head>
<body>
  <section>
    <h2>1. Marker</h2>
    <p class="muted">Before each action in Studio, describe it here and press Add (or Enter). It makes the log easy to read.</p>
    <div class="row"><input id="marker" type="text" placeholder="e.g. Clicking Focus on bookmark in testSandbox.xaml"><button id="addMarker">Add</button></div>
  </section>
  <section>
    <h2>2. Jump test</h2>
    <label>Bookmark <select id="bookmark"></select></label>
    <p class="muted">For each button: first switch Studio to a <b>different</b> workflow tab, then click the button, then add a marker saying what Studio did (nothing / switched workflow / selected the activity / error).</p>
    <div class="buttons" id="jumpButtons"></div>
  </section>
  <section>
    <h2>3. Other checks</h2>
    <div class="buttons">
      <button id="snapshot">Snapshot tabs/editors</button>
      <button id="relist">Re-list commands</button>
      <button id="inspect">Inspect UiPath extensions</button>
      <button id="save">Save files now</button>
    </div>
  </section>
  <section>
    <h2>Event log</h2>
    <pre id="log"></pre>
  </section>
  <script nonce="${nonce}" src="${media('panel.js')}"></script>
</body>
</html>`;
}

function deactivate() {
  return flush();
}

module.exports = { activate, deactivate };

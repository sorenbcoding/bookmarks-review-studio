// Phase 0 probe for the Bookmarks Review extension.
// Goal: find out what a .vsix can do inside UiPath Studio's extension host.
// Everything it learns goes to the "Bookmarks Probe" output channel and to
// <project>/.review/probe/probe-report.json (delete that folder after testing).

const vscode = require('vscode');
const path = require('path');

const BOOKMARKS_GLOB = '**/.project/bookmarks.json';

/** @type {vscode.OutputChannel} */
let out;
/** @type {vscode.ExtensionContext} */
let ctx;
/** Results reported back from the webviews (paste support etc.). */
const webviewChecks = {};
/** All live webviews, so file changes can refresh them. */
const webviews = new Set();

function log(msg) {
  out.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

async function activate(context) {
  ctx = context;
  out = vscode.window.createOutputChannel('Bookmarks Probe');
  log(`Activated in "${vscode.env.appName}" (API ${vscode.version}, host ${vscode.env.appHost})`);

  context.subscriptions.push(
    out,
    vscode.commands.registerCommand('bookmarksProbe.openPanel', openPanel),
    vscode.commands.registerCommand('bookmarksProbe.runReport', () => runReport(true)),
    vscode.commands.registerCommand('bookmarksProbe.showLog', () => out.show()),
    vscode.window.registerWebviewViewProvider('bookmarksProbe.view', {
      resolveWebviewView(view) {
        log('Sidebar webview view resolved (contributed views work)');
        webviewChecks.sidebarViewResolved = true;
        setupWebview(view.webview, 'sidebar');
        view.onDidDispose(() => webviews.delete(view.webview));
      },
    })
  );

  const watcher = vscode.workspace.createFileSystemWatcher(BOOKMARKS_GLOB);
  const onFsEvent = (kind) => async (uri) => {
    log(`Watcher: bookmarks.json ${kind}: ${uri.fsPath}`);
    webviewChecks.watcherFired = true;
    await refreshAll();
  };
  watcher.onDidChange(onFsEvent('changed'));
  watcher.onDidCreate(onFsEvent('created'));
  watcher.onDidDelete(onFsEvent('deleted'));
  context.subscriptions.push(watcher);

  await runReport(false);
}

function deactivate() {}

// ---------------------------------------------------------------------------
// Project + bookmarks
// ---------------------------------------------------------------------------

/** Finds the UiPath project root (folder that contains .project/bookmarks.json or project.json). */
async function findProjectRoot() {
  try {
    const hits = await vscode.workspace.findFiles(BOOKMARKS_GLOB, '**/node_modules/**', 5);
    if (hits.length > 0) {
      return { root: vscode.Uri.file(path.dirname(path.dirname(hits[0].fsPath))), via: 'bookmarks.json', hits: hits.map((h) => h.fsPath) };
    }
    const projects = await vscode.workspace.findFiles('**/project.json', '**/node_modules/**', 5);
    if (projects.length > 0) {
      return { root: vscode.Uri.file(path.dirname(projects[0].fsPath)), via: 'project.json', hits: projects.map((h) => h.fsPath) };
    }
  } catch (err) {
    log(`findFiles failed: ${err}`);
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? { root: folder.uri, via: 'first workspace folder', hits: [] } : { root: undefined, via: 'none', hits: [] };
}

/**
 * Reads .project/bookmarks.json and flattens it into a list.
 * Format (confirmed from real samples):
 *   { "Value": { "<project-relative xaml path>": [ { IsEnabled, Annotation, Id, ActivityIdRef, ActivityId, ActivityName, IsTransient } ] } }
 */
async function readBookmarks(root) {
  if (!root) return { bookmarks: [], error: 'No project root found' };
  const uri = vscode.Uri.joinPath(root, '.project', 'bookmarks.json');
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString('utf8').replace(/^﻿/, '');
    const json = JSON.parse(text);
    const bookmarks = [];
    for (const [file, list] of Object.entries(json?.Value ?? {})) {
      for (const b of Array.isArray(list) ? list : []) {
        bookmarks.push({
          file,
          id: b.Id,
          activityIdRef: b.ActivityIdRef,
          activityName: b.ActivityName,
          annotation: b.Annotation,
          isEnabled: b.IsEnabled,
          isTransient: b.IsTransient,
        });
      }
    }
    return { bookmarks };
  } catch (err) {
    return { bookmarks: [], error: `${uri.fsPath}: ${err.message ?? err}` };
  }
}

// ---------------------------------------------------------------------------
// Capability report
// ---------------------------------------------------------------------------

async function runReport(showWhenDone) {
  const project = await findProjectRoot();
  const { bookmarks, error } = await readBookmarks(project.root);

  let allCommands = [];
  try {
    allCommands = await vscode.commands.getCommands(true);
  } catch (err) {
    log(`getCommands failed: ${err}`);
  }
  const interesting = allCommands.filter((c) => /uipath|studio|bookmark|marker|xaml|workflow|activity|designer/i.test(c));

  const writeTest = await testWrite(project.root);

  const report = {
    time: new Date().toISOString(),
    host: {
      appName: vscode.env.appName,
      appHost: vscode.env.appHost,
      apiVersion: vscode.version,
      uiKind: vscode.env.uiKind === vscode.UIKind.Web ? 'web' : 'desktop',
      remoteName: vscode.env.remoteName ?? null,
      language: vscode.env.language,
      extensionPath: ctx.extensionUri.fsPath,
      globalStorage: ctx.globalStorageUri.fsPath,
    },
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    project: { root: project.root?.fsPath ?? null, foundVia: project.via, hits: project.hits },
    bookmarks: { count: bookmarks.length, error: error ?? null, items: bookmarks },
    fileWrite: writeTest,
    commands: { total: allCommands.length, possiblyStudioRelated: interesting },
    webviewChecks,
  };

  log(`Workspace folders: ${JSON.stringify(report.workspaceFolders)}`);
  log(`Project root: ${report.project.root} (via ${project.via})`);
  log(`Bookmarks read: ${bookmarks.length}${error ? ` – error: ${error}` : ''}`);
  log(`File write in project: ${writeTest.ok ? 'OK' : `FAILED – ${writeTest.error}`}`);
  log(`Commands: ${allCommands.length} total, ${interesting.length} possibly Studio-related`);
  for (const c of interesting) log(`  ${c}`);

  // Save the report next to the project if we can, otherwise in extension storage.
  const targetDir = project.root && writeTest.ok
    ? vscode.Uri.joinPath(project.root, '.review', 'probe')
    : ctx.globalStorageUri;
  try {
    await vscode.workspace.fs.createDirectory(targetDir);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(targetDir, 'probe-report.json'), Buffer.from(JSON.stringify(report, null, 2)));
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(targetDir, 'all-commands.txt'), Buffer.from(allCommands.sort().join('\n')));
    log(`Report saved to ${targetDir.fsPath}`);
  } catch (err) {
    log(`Could not save report: ${err}`);
  }

  await refreshAll();
  if (showWhenDone) {
    out.show(true);
    vscode.window.showInformationMessage(`Bookmarks probe: ${bookmarks.length} bookmark(s), report in ${targetDir.fsPath}`);
  }
}

async function testWrite(root) {
  if (!root) return { ok: false, error: 'no project root' };
  const uri = vscode.Uri.joinPath(root, '.review', 'probe', '.write-test');
  try {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, '.review', 'probe'));
    await vscode.workspace.fs.writeFile(uri, Buffer.from('ok'));
    await vscode.workspace.fs.delete(uri);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message ?? err) };
  }
}

// ---------------------------------------------------------------------------
// Webviews (editor panel + sidebar view share the same UI)
// ---------------------------------------------------------------------------

function openPanel() {
  const panel = vscode.window.createWebviewPanel('bookmarksProbe.panel', 'Bookmarks Probe', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  log('Editor webview panel created');
  webviewChecks.editorPanelCreated = true;
  setupWebview(panel.webview, 'panel');
  panel.onDidDispose(() => webviews.delete(panel.webview));
}

async function setupWebview(webview, where) {
  const project = await findProjectRoot();
  const roots = [vscode.Uri.joinPath(ctx.extensionUri, 'media')];
  if (project.root) roots.push(vscode.Uri.joinPath(project.root, '.review'));
  webview.options = { enableScripts: true, localResourceRoots: roots };
  webview.html = html(webview);
  webviews.add(webview);

  webview.onDidReceiveMessage(async (msg) => {
    switch (msg.type) {
      case 'ready':
        log(`Webview (${where}) script running`);
        webviewChecks[`${where}ScriptRan`] = true;
        await postBookmarks(webview);
        break;
      case 'check':
        log(`Webview (${where}) check: ${msg.name} = ${JSON.stringify(msg.value)}`);
        webviewChecks[`${where}.${msg.name}`] = msg.value;
        break;
      case 'saveImage':
        await saveImage(webview, msg.dataUrl, where);
        break;
      case 'rerun':
        await runReport(true);
        break;
    }
  });
}

async function postBookmarks(webview) {
  const project = await findProjectRoot();
  const result = await readBookmarks(project.root);
  webview.postMessage({ type: 'bookmarks', root: project.root?.fsPath ?? null, ...result });
}

async function refreshAll() {
  for (const w of webviews) await postBookmarks(w);
}

async function saveImage(webview, dataUrl, where) {
  const project = await findProjectRoot();
  if (!project.root) {
    webview.postMessage({ type: 'imageError', error: 'No project root found' });
    return;
  }
  const match = /^data:image\/(png|jpeg|gif|bmp);base64,(.+)$/.exec(dataUrl ?? '');
  if (!match) {
    webview.postMessage({ type: 'imageError', error: 'Unsupported clipboard data' });
    return;
  }
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const dir = vscode.Uri.joinPath(project.root, '.review', 'probe');
  const file = vscode.Uri.joinPath(dir, `paste-${Date.now()}.${ext}`);
  try {
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(file, Buffer.from(match[2], 'base64'));
    log(`Pasted image (${where}) saved to ${file.fsPath}`);
    webviewChecks[`${where}.imageSaved`] = true;
    webview.postMessage({ type: 'imageSaved', src: webview.asWebviewUri(file).toString(), path: file.fsPath });
  } catch (err) {
    log(`Saving pasted image failed: ${err}`);
    webview.postMessage({ type: 'imageError', error: String(err.message ?? err) });
  }
}

function html(webview) {
  const nonce = [...Array(32)].map(() => Math.random().toString(36)[2]).join('');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', 'panel.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', 'panel.css'));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${style}">
  <title>Bookmarks Probe</title>
</head>
<body>
  <section>
    <h2>Bookmarks</h2>
    <p id="root" class="muted">Loading…</p>
    <div id="bookmarks"></div>
  </section>
  <section>
    <h2>Screenshot paste test</h2>
    <p class="muted">Take a screenshot (Win+Shift+S), click the box below and press Ctrl+V.</p>
    <div id="pasteTarget" tabindex="0" contenteditable="true">Click here and paste…</div>
    <p id="pasteStatus" class="muted"></p>
    <div id="images"></div>
  </section>
  <section>
    <button id="rerun">Run capability report again</button>
  </section>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

module.exports = { activate, deactivate };

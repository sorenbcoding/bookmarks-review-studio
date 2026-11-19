// Probe 3: which Git, issue and pull-request routes can an extension use inside Studio?
// Automatic checks (on startup): git command line, reading .git directly, gh / az command lines,
// the vscode.git extension API, vscode.authentication providers, SecretStorage.
// Manual checks (buttons): opening https URLs (openExternal, webview link, PowerShell), a long pre-filled
// "new issue" URL, the clipboard, and whether Studio's commit dialog lists files under .review/.
//
// Output: <project>/.review/probe3/probe3-log.txt and probe3-report.json. Delete that folder afterwards.
// Privacy: the repo is public, so remote URLs, branch names, commit ids and user paths are redacted.

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fsNode = require('fs');
const { execFile } = require('child_process');

/** @type {vscode.ExtensionContext} */
let ctx;
/** @type {vscode.Uri | undefined} */
let root;
/** @type {vscode.WebviewView | undefined} */
let view;
let out;
const logLines = [];
const report = { time: new Date().toISOString(), checks: {}, manual: [] };
let originUrl; // kept in memory only, never written

// ---------------------------------------------------------------------------
// Redaction and logging
// ---------------------------------------------------------------------------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function redact(text) {
  let s = String(text);
  const swaps = [];
  if (root) swaps.push([root.fsPath, '<project>']);
  swaps.push([os.homedir(), '%USERPROFILE%']);
  try {
    swaps.push([os.userInfo().username, '<user>']);
  } catch {
    // ignore
  }
  for (const [from, to] of swaps) {
    if (!from || from.length < 3) continue;
    for (const variant of new Set([from, from.replace(/\\/g, '/'), from.replace(/\\/g, '\\\\')])) {
      s = s.replace(new RegExp(escapeRe(variant), 'gi'), to);
    }
  }
  if (originUrl) s = s.split(originUrl).join('<origin>');
  return s.replace(/[0-9a-f]{40}/gi, '<sha>');
}

function json(value) {
  try {
    const s = JSON.stringify(value);
    return s && s.length > 3000 ? `${s.slice(0, 3000)}…` : s;
  } catch (err) {
    return `[unserializable: ${err}]`;
  }
}

function log(kind, msg, data) {
  const line = redact(`${new Date().toISOString().slice(11, 23)} [${kind}] ${msg}${data !== undefined ? ` ${json(data)}` : ''}`);
  logLines.push(line);
  out?.appendLine(line);
  view?.webview.postMessage({ type: 'log', line });
}

function probeDir() {
  return root ? vscode.Uri.joinPath(root, '.review', 'probe3') : ctx.globalStorageUri;
}

async function save() {
  try {
    await vscode.workspace.fs.createDirectory(probeDir());
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(probeDir(), 'probe3-log.txt'), Buffer.from(logLines.join('\n') + '\n'));
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(probeDir(), 'probe3-report.json'), Buffer.from(redact(JSON.stringify(report, null, 2))));
  } catch (err) {
    out.appendLine(`Could not write the probe files — ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Runs a program; never throws. `cmd: true` runs it through cmd.exe, needed for .cmd shims such as az. */
function run(file, args, { cwd = root?.fsPath, timeout = 10000, cmd = false } = {}) {
  const started = Date.now();
  const [exe, argv] = cmd ? ['cmd.exe', ['/d', '/c', file, ...args]] : [file, args];
  return new Promise((resolve) => {
    execFile(exe, argv, { cwd, timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (err.code ?? 'error') : 0,
        killed: Boolean(err?.killed),
        ms: Date.now() - started,
        stdout: String(stdout ?? '').trim(),
        stderr: String(stderr ?? '').trim().slice(0, 500),
      });
    });
  });
}

const firstLine = (s) => String(s ?? '').split(/\r?\n/)[0];

function withTimeout(promise, ms, label) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: no answer after ${ms} ms`)), ms))]);
}

/** Host and shape of a remote URL, without owner or repo names. */
function describeRemote(url) {
  if (!url) return null;
  let host;
  let pathPart;
  let scheme;
  let m = /^([a-z+]+):\/\/(?:([^@/]*)@)?([^/:]+)(?::\d+)?\/(.*)$/i.exec(url);
  if (m) {
    [, scheme, , host, pathPart] = m;
  } else if ((m = /^(?:([^@]+)@)?([^:]+):(.*)$/.exec(url))) {
    scheme = 'scp-ssh';
    [, , host, pathPart] = m;
  } else {
    return { parsed: false };
  }
  host = host.toLowerCase();
  const kind = /github/.test(host)
    ? 'github'
    : /gitlab/.test(host)
      ? 'gitlab'
      : /dev\.azure\.com|visualstudio\.com/.test(host)
        ? 'azure-devops'
        : /bitbucket/.test(host)
          ? 'bitbucket'
          : 'other';
  return {
    parsed: true,
    scheme,
    host: kind === 'other' ? '<other host>' : host.replace(/^[^.]+\.visualstudio\.com$/, '<org>.visualstudio.com').replace(/^ssh\./, 'ssh.'),
    kind,
    pathSegments: pathPart.replace(/\.git$/, '').split('/').filter(Boolean).length,
    hasUserInfo: /^[a-z+]+:\/\/[^/]*@/i.test(url) && !/^[a-z+]+:\/\/git@/i.test(url),
    hasPassword: /^[a-z+]+:\/\/[^/@]*:[^/@]*@/i.test(url),
  };
}

/** Web URL of the remote repository, or null (kept in memory only). */
function webBase(url) {
  if (!url) return null;
  let m = /^https?:\/\/(?:[^@/]*@)?([^/]+)\/(.+?)(?:\.git)?\/?$/i.exec(url);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = /^(?:ssh:\/\/)?git@ssh\.dev\.azure\.com(?::v3)?[/:]v3\/([^/]+)\/([^/]+)\/(.+)$/i.exec(url);
  if (m) return `https://dev.azure.com/${m[1]}/${m[2]}/_git/${m[3]}`;
  m = /^(?:ssh:\/\/)?git@([^/:]+)[/:](.+?)(?:\.git)?$/i.exec(url);
  if (m) return `https://${m[1]}/${m[2]}`;
  return null;
}

const SAMPLE_TITLE = 'Probe 3: test issue — æøå & # % "quotes"';
function sampleBody(lines) {
  const parts = [
    '**Bookmarks Review probe 3.** This page was opened to test pre-filled issues. Close it without creating the issue.',
    '',
    '- Workflow: `Main.xaml`',
    '- Activity: `Assign_12`',
    '- Characters: æ ø å, & # % + ? = / \\, "quotes", \'apostrophes\'',
    '',
    '| Column | Value |',
    '|---|---|',
    '| Status | Open |',
    '',
  ];
  for (let i = 1; i <= lines; i++) parts.push(`Line ${i} of filler text, to make the URL long enough to test the length limit.`);
  parts.push('', 'END OF BODY');
  return parts.join('\n');
}

const enc = encodeURIComponent;

function newIssueUrl(base, kind, title, body) {
  if (kind === 'github') return `${base}/issues/new?title=${enc(title)}&body=${enc(body)}`;
  if (kind === 'gitlab') return `${base}/-/issues/new?issue[title]=${enc(title)}&issue[description]=${enc(body)}`;
  if (kind === 'azure-devops') {
    const project = base.replace(/\/_git\/.*$/, '');
    const html = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');
    return `${project}/_workitems/create/Task?[System.Title]=${enc(title)}&[System.Description]=${enc(html)}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Automatic checks
// ---------------------------------------------------------------------------

async function checkGitCli() {
  const r = {};
  r.where = await run('where.exe', ['git']);
  r.version = await run('git', ['--version']);
  r.insideWorkTree = await run('git', ['rev-parse', '--is-inside-work-tree']);
  r.topLevelIsProject = await run('git', ['rev-parse', '--show-toplevel']);
  if (r.topLevelIsProject.ok && root) {
    const top = path.resolve(r.topLevelIsProject.stdout);
    r.topLevelIsProject.relation = top.toLowerCase() === root.fsPath.toLowerCase() ? 'same as project' : root.fsPath.toLowerCase().startsWith(top.toLowerCase()) ? 'project is a subfolder' : 'other';
    r.topLevelIsProject.stdout = '<redacted>';
  }
  const head = await run('git', ['rev-parse', 'HEAD']);
  r.head = { ok: head.ok, isSha: /^[0-9a-f]{40}$/.test(head.stdout), ms: head.ms, stderr: head.stderr };
  const branch = await run('git', ['branch', '--show-current']);
  r.branch = { ok: branch.ok, present: Boolean(branch.stdout), length: branch.stdout.length, ms: branch.ms };
  const origin = await run('git', ['remote', 'get-url', 'origin']);
  if (origin.ok) originUrl = originUrl ?? origin.stdout;
  r.origin = { ok: origin.ok, remote: describeRemote(origin.stdout), ms: origin.ms };
  const remotes = await run('git', ['remote']);
  r.remoteCount = remotes.ok ? remotes.stdout.split(/\r?\n/).filter(Boolean).length : null;
  const status = await run('git', ['status', '--porcelain', '--untracked-files=all', '--', '.review']);
  r.reviewStatus = { ok: status.ok, changedFiles: status.ok ? status.stdout.split(/\r?\n/).filter(Boolean).length : null, ms: status.ms };
  const ignored = await run('git', ['check-ignore', '-q', '.review/probe3/probe3-report.json']);
  r.reviewIgnored = { code: ignored.code, meaning: ignored.code === 0 ? 'ignored by .gitignore' : ignored.code === 1 ? 'not ignored' : 'unknown' };
  const user = await run('git', ['config', 'user.name']);
  r.userNameSet = Boolean(user.stdout);
  if (r.head.isSha) {
    const diff = await run('git', ['diff', '--quiet', 'HEAD~1', 'HEAD', '--', '.']);
    r.diffQuiet = { code: diff.code, ms: diff.ms, note: 'exit 1 = differences, 0 = none, other = error' };
    const logLine = await run('git', ['log', '-1', '--format=%cI']);
    r.lastCommitDate = logLine.ok ? logLine.stdout : logLine.stderr;
  }
  r.pathEntriesWithGit = (process.env.PATH ?? '').split(';').filter((p) => /git/i.test(p));
  r.commonInstall = ['C:\\Program Files\\Git\\cmd\\git.exe', path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Git', 'cmd', 'git.exe')].map((p) => ({
    path: p,
    exists: fsNode.existsSync(p),
  }));
  return r;
}

async function checkDotGit() {
  if (!root) return { found: false, reason: 'no project' };
  let dir = root.fsPath;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, '.git');
    if (fsNode.existsSync(candidate)) {
      const r = { found: true, levelsUp: i, isFile: fsNode.statSync(candidate).isFile() };
      let gitDir = candidate;
      if (r.isFile) {
        const m = /gitdir:\s*(.+)/.exec(fsNode.readFileSync(candidate, 'utf8'));
        gitDir = m ? path.resolve(dir, m[1].trim()) : candidate;
      }
      try {
        const head = fsNode.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
        r.head = head.startsWith('ref: ') ? { kind: 'branch', refLength: head.length } : /^[0-9a-f]{40}$/.test(head) ? { kind: 'detached' } : { kind: 'unknown' };
      } catch (err) {
        r.head = { error: String(err.code ?? err) };
      }
      try {
        const config = fsNode.readFileSync(path.join(r.isFile ? gitDir.replace(/[\\/]worktrees[\\/][^\\/]+$/, '') : gitDir, 'config'), 'utf8');
        const m = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(config);
        if (m) originUrl = originUrl ?? m[1];
        r.originFromConfig = m ? describeRemote(m[1]) : null;
      } catch (err) {
        r.config = { error: String(err.code ?? err) };
      }
      return r;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { found: false };
}

async function checkCli() {
  const r = {};
  r.ghWhere = await run('where.exe', ['gh']);
  if (r.ghWhere.ok) {
    r.ghVersion = firstLine((await run('gh', ['--version'])).stdout);
    const auth = await run('gh', ['auth', 'status'], { timeout: 15000 });
    r.ghAuth = { code: auth.code, loggedIn: /Logged in/i.test(auth.stdout + auth.stderr), ms: auth.ms };
  }
  r.azWhere = await run('where.exe', ['az']);
  if (r.azWhere.ok) {
    const v = await run('az', ['version', '--output', 'json'], { cmd: true, timeout: 45000 });
    try {
      const parsed = JSON.parse(v.stdout);
      r.azVersion = { cli: parsed['azure-cli'], extensions: parsed.extensions, ms: v.ms };
    } catch {
      r.azVersion = { ok: v.ok, code: v.code, ms: v.ms, stderr: v.stderr };
    }
    const acct = await run('az', ['account', 'show', '--query', 'user.type', '--output', 'tsv'], { cmd: true, timeout: 45000 });
    r.azSignedIn = { ok: acct.ok, userType: acct.ok ? acct.stdout : null, ms: acct.ms };
  }
  for (const k of ['ghWhere', 'azWhere']) if (r[k]?.stdout) r[k].stdout = r[k].stdout.split(/\r?\n/).map((x) => x.replace(/^.*\\/, '…\\')).join('; ');
  return r;
}

async function checkGitExtension() {
  const r = { gitLike: vscode.extensions.all.filter((e) => /git|scm|source/i.test(e.id)).map((e) => `${e.id} ${e.packageJSON?.version ?? ''} active=${e.isActive}`) };
  const ext = vscode.extensions.getExtension('vscode.git');
  r.vscodeGit = Boolean(ext);
  if (ext) {
    try {
      const exports = ext.isActive ? ext.exports : await withTimeout(ext.activate(), 15000, 'activate vscode.git');
      const api = exports?.getAPI?.(1);
      r.api = api ? { state: api.state, repositories: api.repositories.length } : 'no getAPI(1)';
      const repo = api?.repositories?.[0];
      if (repo) r.repo = { hasHead: Boolean(repo.state.HEAD), hasBranchName: Boolean(repo.state.HEAD?.name), changes: repo.state.workingTreeChanges.length };
    } catch (err) {
      r.error = String(err?.message ?? err);
    }
  }
  r.scm = typeof vscode.scm?.createSourceControl;
  return r;
}

async function checkAuth() {
  const r = {};
  for (const [provider, scopes] of [['github', ['repo']], ['microsoft', ['499b84ac-1321-427f-aa17-267ca6975798/.default']]]) {
    try {
      const session = await withTimeout(vscode.authentication.getSession(provider, scopes, { silent: true }), 10000, provider);
      r[provider] = { available: true, signedIn: Boolean(session) };
    } catch (err) {
      r[provider] = { available: false, error: String(err?.message ?? err).slice(0, 300) };
    }
  }
  return r;
}

async function checkSecrets() {
  try {
    await ctx.secrets.store('probe3.test', 'value-123');
    const back = await ctx.secrets.get('probe3.test');
    await ctx.secrets.delete('probe3.test');
    return { works: back === 'value-123', after: await ctx.secrets.get('probe3.test') === undefined ? 'deleted' : 'still there' };
  } catch (err) {
    return { works: false, error: String(err?.message ?? err) };
  }
}

async function runAutomatic() {
  const steps = [
    ['gitCli', checkGitCli],
    ['dotGit', checkDotGit],
    ['gitExtension', checkGitExtension],
    ['authentication', checkAuth],
    ['secretStorage', checkSecrets],
    ['ghAndAz', checkCli],
  ];
  for (const [name, fn] of steps) {
    log('auto', `Checking ${name}…`);
    try {
      report.checks[name] = await fn();
    } catch (err) {
      report.checks[name] = { error: String(err?.message ?? err) };
    }
    log('auto', name, report.checks[name]);
    await save();
  }
  view?.webview.postMessage({ type: 'remote', kind: describeRemote(originUrl)?.kind ?? null, hasWeb: Boolean(webBase(originUrl)) });
  log('auto', 'Automatic checks done');
}

// ---------------------------------------------------------------------------
// Manual tests
// ---------------------------------------------------------------------------

const PUBLIC_REPO = 'https://github.com/sorenbcoding/bookmarks-review-studio';

const TESTS = {
  A: 'openExternal: plain https URL (this probe\'s public repo)',
  B: 'openExternal: pre-filled GitHub "new issue", about 3 KB',
  C: 'openExternal: pre-filled GitHub "new issue", about 12 KB',
  D: 'Link in the panel (<a href>) to the public repo',
  E: 'PowerShell Start-Process with the pre-filled 3 KB URL',
  F: 'openExternal: pre-filled "new issue" on THIS project\'s remote',
  G: 'Clipboard: copy a sample review summary, then paste it in Notepad or below',
  H: 'Commit dialog: does Studio list .review/probe3/ files? (Do not commit)',
};

async function openExternal(url, label) {
  try {
    const result = await vscode.env.openExternal(vscode.Uri.parse(url));
    log('manual', `${label}: openExternal returned ${result}`, { urlLength: url.length });
  } catch (err) {
    log('manual', `${label}: openExternal threw ${err?.message ?? err}`);
  }
}

async function runTest(id) {
  log('manual', `RUN ${id}: ${TESTS[id]}`);
  switch (id) {
    case 'A':
      return openExternal(PUBLIC_REPO, id);
    case 'B':
      return openExternal(newIssueUrl(PUBLIC_REPO, 'github', SAMPLE_TITLE, sampleBody(20)), id);
    case 'C':
      return openExternal(newIssueUrl(PUBLIC_REPO, 'github', SAMPLE_TITLE, sampleBody(100)), id);
    case 'E': {
      const url = newIssueUrl(PUBLIC_REPO, 'github', SAMPLE_TITLE, sampleBody(20));
      const r = await new Promise((resolve) =>
        execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process $env:SB_PROBE_URL'],
          { env: { ...process.env, SB_PROBE_URL: url }, windowsHide: true, timeout: 15000 },
          (err, stdout, stderr) => resolve({ ok: !err, code: err?.code ?? 0, stderr: String(stderr).trim().slice(0, 300) })
        )
      );
      return log('manual', `E: PowerShell finished`, { ...r, urlLength: url.length });
    }
    case 'F': {
      const remote = describeRemote(originUrl);
      const base = webBase(originUrl);
      const url = base && newIssueUrl(base, remote?.kind, SAMPLE_TITLE, sampleBody(20));
      if (!url) return log('manual', `F: no supported remote (kind ${remote?.kind ?? 'none'})`);
      return openExternal(url, `F (${remote.kind})`);
    }
    case 'G': {
      const text = `## Review summary (probe 3)\n\n- [ ] Main.xaml / Assign_12: æøå test\n- [x] Process.xaml / If_3: resolved\n\nToken ${Date.now()}`;
      try {
        await vscode.env.clipboard.writeText(text);
        const back = await vscode.env.clipboard.readText();
        log('manual', `G: clipboard written; read back ${back === text ? 'identical' : 'DIFFERENT'}`, { length: back.length });
        view?.webview.postMessage({ type: 'clipboardExpected', text });
      } catch (err) {
        log('manual', `G: clipboard threw ${err?.message ?? err}`);
      }
      return;
    }
    case 'H':
      await save();
      return log('manual', 'H: probe files saved under .review/probe3/. Open Studio\'s commit dialog and check the file list; close it without committing.');
  }
}

// ---------------------------------------------------------------------------
// Activation and view
// ---------------------------------------------------------------------------

async function activate(context) {
  ctx = context;
  out = vscode.window.createOutputChannel('Git Probe');
  root = vscode.workspace.workspaceFolders?.[0]?.uri;
  report.host = { appName: vscode.env.appName, apiVersion: vscode.version, uriScheme: vscode.env.uriScheme, node: process.version, platform: process.platform };
  log('init', `Activated. Host "${vscode.env.appName}" API ${vscode.version}, Node ${process.version}`);
  context.subscriptions.push(out, vscode.window.registerWebviewViewProvider('bookmarksProbe3.view', { resolveWebviewView: (v) => setupView(v) }, { webviewOptions: { retainContextWhenHidden: true } }));
  await runAutomatic();
}

function setupView(v) {
  view = v;
  v.webview.options = { enableScripts: true };
  v.webview.onDidReceiveMessage(async (msg) => {
    switch (msg.type) {
      case 'ready':
        v.webview.postMessage({ type: 'init', lines: logLines.slice(-300), tests: TESTS, publicRepo: PUBLIC_REPO, remoteKind: describeRemote(originUrl)?.kind ?? null });
        break;
      case 'run':
        if (TESTS[msg.id]) await runTest(msg.id);
        break;
      case 'linkClicked':
        log('manual', 'D: the panel saw the link click (the browser may or may not have opened)');
        break;
      case 'result':
        if (!TESTS[msg.id]) break;
        report.manual.push({ id: msg.id, test: TESTS[msg.id], result: String(msg.result).slice(0, 40), note: String(msg.note ?? '').slice(0, 300), time: new Date().toISOString() });
        log('RESULT', `${msg.id} = ${msg.result}${msg.note ? ` (${msg.note})` : ''}`);
        await save();
        break;
      case 'pasteCheck':
        log('manual', `G: paste into the panel ${msg.same ? 'matches' : 'DIFFERS from'} what was copied`, { length: msg.length });
        break;
      case 'rerun':
        await runAutomatic();
        break;
      case 'save':
        await save();
        vscode.window.showInformationMessage(`Git probe: files saved in ${probeDir().fsPath}`);
        break;
    }
  });
  v.webview.html = html();
}

function html() {
  const nonce = [...Array(32)].map(() => Math.random().toString(36)[2]).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 8px 16px; }
  h2 { font-size: 1.05em; margin: 16px 0 4px; }
  .muted { opacity: .75; margin: 4px 0 8px; }
  .test { border: 1px solid var(--vscode-panel-border, #8884); border-radius: 2px; padding: 8px; margin-bottom: 8px; }
  .test b { display: block; margin-bottom: 4px; }
  .row { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid transparent; border-radius: 2px; padding: 2px 8px; cursor: pointer; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.done { outline: 1px solid var(--vscode-focusBorder); }
  input, textarea { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #8884); border-radius: 2px; padding: 2px 4px; }
  textarea { min-height: 60px; }
  a { color: var(--vscode-textLink-foreground); }
  pre { white-space: pre-wrap; word-break: break-all; font-family: var(--vscode-editor-font-family); font-size: 11px; max-height: 320px; overflow: auto; }
</style>
<title>Git probe</title>
</head>
<body>
<h2>Git probe</h2>
<p class="muted">The automatic checks ran when Studio started. Work through the tests below: click <b>Run</b>, look at what happens, then click the result. Add a note when something is partly right, for example "title fine, body cut off".</p>
<div id="tests"></div>
<h2>Paste check (test G)</h2>
<p class="muted">After running G, click in the box and press Ctrl+V.</p>
<textarea id="paste"></textarea>
<div class="row"><button id="checkPaste">Check paste</button></div>
<h2>Finish</h2>
<div class="row"><button id="rerun">Run automatic checks again</button><button id="save" class="primary">Save files now</button></div>
<h2>Log</h2>
<pre id="log"></pre>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const logEl = document.getElementById('log');
  let expected = null;
  const hints = {
    A: 'Expected: the browser opens the public GitHub repo.',
    B: 'Expected: a GitHub "new issue" page with the title and body filled in. Check æøå, & and # in the title. Do NOT submit.',
    C: 'Same as B with a longer body. Does the body end with END OF BODY?',
    D: 'Click the link: ',
    E: 'Expected: the same page as B, opened through PowerShell.',
    F: 'Opens a "new issue" page on your own remote (GitHub, GitLab or Azure DevOps). Are you signed in? Is it filled in? Do NOT submit.',
    G: 'Copies a sample summary. Paste it in Notepad and below; are æøå and line breaks intact?',
    H: 'Click Run, then open Studio\\'s commit dialog. Is .review/probe3/probe3-report.json listed? Close the dialog without committing.',
  };
  function addLine(line) { logEl.textContent += line + '\\n'; logEl.scrollTop = logEl.scrollHeight; }
  function render(tests, publicRepo, remoteKind) {
    const box = document.getElementById('tests');
    box.textContent = '';
    for (const [id, label] of Object.entries(tests)) {
      const div = document.createElement('div');
      div.className = 'test';
      const b = document.createElement('b'); b.textContent = id + '. ' + label; div.append(b);
      const p = document.createElement('div'); p.className = 'muted'; p.textContent = hints[id] ?? '';
      if (id === 'D') {
        const a = document.createElement('a'); a.href = publicRepo; a.textContent = publicRepo;
        a.addEventListener('click', () => vscode.postMessage({ type: 'linkClicked' }));
        p.append(a);
      }
      if (id === 'F') { const k = document.createElement('span'); k.id = 'remoteKind'; k.textContent = ' Remote: ' + (remoteKind ?? 'not found yet'); p.append(k); }
      div.append(p);
      const row = document.createElement('div'); row.className = 'row';
      if (id !== 'D') {
        const run = document.createElement('button'); run.className = 'primary'; run.textContent = 'Run';
        run.addEventListener('click', () => vscode.postMessage({ type: 'run', id }));
        row.append(run);
      }
      const note = document.createElement('input'); note.placeholder = 'Note (optional)';
      for (const result of ['Worked', 'Partly', 'Nothing happened', 'Error']) {
        const btn = document.createElement('button'); btn.textContent = result;
        btn.addEventListener('click', () => {
          row.querySelectorAll('button').forEach((x) => x.classList.remove('done'));
          btn.classList.add('done');
          vscode.postMessage({ type: 'result', id, result, note: note.value });
        });
        row.append(btn);
      }
      div.append(row, note);
      box.append(div);
    }
  }
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'init') { logEl.textContent = ''; m.lines.forEach(addLine); render(m.tests, m.publicRepo, m.remoteKind); }
    if (m.type === 'log') addLine(m.line);
    if (m.type === 'clipboardExpected') expected = m.text;
    if (m.type === 'remote') { const k = document.getElementById('remoteKind'); if (k) k.textContent = ' Remote: ' + (m.kind ?? 'none found'); }
  });
  document.getElementById('checkPaste').addEventListener('click', () => {
    const v = document.getElementById('paste').value;
    vscode.postMessage({ type: 'pasteCheck', same: expected !== null && v.replace(/\\r\\n/g, '\\n') === expected, length: v.length });
  });
  document.getElementById('rerun').addEventListener('click', () => vscode.postMessage({ type: 'rerun' }));
  document.getElementById('save').addEventListener('click', () => vscode.postMessage({ type: 'save' }));
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

function deactivate() {
  return save();
}

module.exports = { activate, deactivate };

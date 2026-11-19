(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const logEl = $('log');

  function option(value, label) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label ?? value;
    return o;
  }

  function appendLine(line) {
    logEl.textContent += line + '\n';
    const lines = logEl.textContent.split('\n');
    if (lines.length > 400) logEl.textContent = lines.slice(-400).join('\n');
    logEl.scrollTop = logEl.scrollHeight;
  }

  const addMarker = () => {
    const text = $('marker').value.trim();
    if (!text) return;
    vscode.postMessage({ type: 'marker', text });
    $('marker').value = '';
  };
  $('addMarker').addEventListener('click', addMarker);
  $('marker').addEventListener('keydown', (e) => e.key === 'Enter' && addMarker());

  $('snapshot').addEventListener('click', () => vscode.postMessage({ type: 'snapshot' }));
  $('relist').addEventListener('click', () => vscode.postMessage({ type: 'relistCommands' }));
  $('inspect').addEventListener('click', () => vscode.postMessage({ type: 'inspectExtensions' }));
  $('save').addEventListener('click', () => vscode.postMessage({ type: 'save' }));

  window.addEventListener('message', ({ data: msg }) => {
    if (msg.type === 'log') appendLine(msg.line);
    if (msg.type === 'init') {
      logEl.textContent = '';
      msg.lines.forEach(appendLine);
      // Pre-select the first bookmark so the test can't run without one.
      $('bookmark').replaceChildren(...msg.bookmarks.map((b) => option(`${b.file}|${b.id}`, `${b.file} › ${b.annotation || b.activityName} (${b.activityIdRef})`)));
      if (msg.bookmarks.length === 0) $('bookmark').replaceChildren(option('', '(no bookmarks in this project)'));
      $('jumpButtons').replaceChildren(
        ...Object.entries(msg.methods).map(([key, label]) => {
          const button = document.createElement('button');
          button.textContent = `${key}: ${label}`;
          button.addEventListener('click', () => vscode.postMessage({ type: 'jump', method: key, bookmarkKey: $('bookmark').value }));
          return button;
        })
      );
    }
  });

  vscode.postMessage({ type: 'ready' });
})();

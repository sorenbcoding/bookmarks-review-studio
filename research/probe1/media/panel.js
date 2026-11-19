// Webview side of the probe. Renders bookmarks and tests clipboard image paste.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const check = (name, value) => vscode.postMessage({ type: 'check', name, value });

  check('clipboardApi', typeof navigator.clipboard !== 'undefined');
  check('clipboardReadApi', typeof navigator.clipboard?.read === 'function');

  function render(msg) {
    $('root').textContent = msg.root ? `Project: ${msg.root}` : 'No UiPath project found in the workspace.';
    const container = $('bookmarks');
    container.replaceChildren();
    if (msg.error) {
      const p = document.createElement('p');
      p.className = 'error';
      p.textContent = msg.error;
      container.append(p);
    }
    const byFile = new Map();
    for (const b of msg.bookmarks) {
      if (!byFile.has(b.file)) byFile.set(b.file, []);
      byFile.get(b.file).push(b);
    }
    for (const [file, list] of byFile) {
      const h = document.createElement('h3');
      h.textContent = file;
      container.append(h);
      const ul = document.createElement('ul');
      for (const b of list) {
        const li = document.createElement('li');
        if (!b.isEnabled) li.classList.add('disabled');
        const title = document.createElement('strong');
        title.textContent = b.annotation || b.activityName || '(no text)';
        const meta = document.createElement('div');
        meta.className = 'muted';
        meta.textContent = `${b.activityName} · ${b.activityIdRef} · ${b.id}${b.isTransient ? ' · transient' : ''}`;
        li.append(title, meta);
        ul.append(li);
      }
      container.append(ul);
    }
    if (msg.bookmarks.length === 0 && !msg.error) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'No bookmarks.';
      container.append(p);
    }
  }

  $('pasteTarget').addEventListener('paste', (e) => {
    e.preventDefault();
    const items = [...(e.clipboardData?.items ?? [])];
    const types = items.map((i) => i.type);
    check('pasteEventTypes', types);
    const img = items.find((i) => i.type.startsWith('image/'));
    if (!img) {
      $('pasteStatus').textContent = `Paste event fired, but no image on the clipboard (types: ${types.join(', ') || 'none'}).`;
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      $('pasteStatus').textContent = 'Image received, saving…';
      vscode.postMessage({ type: 'saveImage', dataUrl: reader.result });
    };
    reader.readAsDataURL(img.getAsFile());
  });

  $('rerun').addEventListener('click', () => vscode.postMessage({ type: 'rerun' }));

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'bookmarks') render(msg);
    if (msg.type === 'imageSaved') {
      $('pasteStatus').textContent = `Saved to ${msg.path}`;
      const image = document.createElement('img');
      image.src = msg.src;
      image.alt = 'Pasted screenshot';
      image.onload = () => check('savedImageDisplayed', true);
      image.onerror = () => check('savedImageDisplayed', false);
      $('images').prepend(image);
    }
    if (msg.type === 'imageError') $('pasteStatus').textContent = `Error: ${msg.error}`;
  });

  vscode.postMessage({ type: 'ready' });
})();

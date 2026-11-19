// Opens a local file in its default Windows app (for screenshots: the image viewer).
// Studio's extension host doesn't open local files through vscode.env.openExternal, so on Windows
// the file is started through the shell. The path goes in an environment variable, so no quoting
// of spaces, commas or & in project paths is needed.
const { execFile } = require('child_process');
const vscode = require('vscode');

/** @returns {Promise<boolean>} true if the file was handed to its default app. */
function startWithShell(fsPath) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Invoke-Item -LiteralPath $env:SB_OPEN_FILE'],
      { env: { ...process.env, SB_OPEN_FILE: fsPath }, windowsHide: true, timeout: 15000 },
      (error) => resolve(!error),
    );
  });
}

const opener = {
  /** @param {vscode.Uri} uri @returns {Promise<{ ok: boolean, via: string }>} */
  async openWithDefaultApp(uri) {
    if (process.platform === 'win32' && (await startWithShell(uri.fsPath))) return { ok: true, via: 'shell' };
    const ok = await vscode.env.openExternal(uri).then(Boolean, () => false);
    return { ok, via: 'openExternal' };
  },
};

module.exports = opener;

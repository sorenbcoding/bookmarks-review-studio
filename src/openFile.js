// Opens a local file in its default Windows app (for screenshots: the image viewer).
// Studio's extension host doesn't open local files through vscode.env.openExternal, so on Windows
// the file is started through the shell. The path goes in an environment variable, so no quoting
// of spaces, commas or & in project paths is needed.
const { execFile } = require('child_process');
const vscode = require('vscode');

/** Runs a PowerShell command with $env:SB_OPEN_FILE set. @returns {Promise<boolean>} true on success. */
function runWithPath(command, fsPath) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { env: { ...process.env, SB_OPEN_FILE: fsPath }, windowsHide: true, timeout: 15000 },
      (error) => resolve(!error),
    );
  });
}

const opener = {
  /** @param {vscode.Uri} uri @returns {Promise<{ ok: boolean, via: string }>} */
  async openWithDefaultApp(uri) {
    if (process.platform === 'win32' && (await runWithPath('Invoke-Item -LiteralPath $env:SB_OPEN_FILE', uri.fsPath))) {
      return { ok: true, via: 'shell' };
    }
    const ok = await vscode.env.openExternal(uri).then(Boolean, () => false);
    return { ok, via: 'openExternal' };
  },

  /** Opens File Explorer with the file selected. @param {vscode.Uri} uri @returns {Promise<boolean>} */
  async revealInExplorer(uri) {
    if (process.platform === 'win32') {
      // explorer.exe returns exit code 1 even on success, so Start-Process reports only launch errors.
      return runWithPath(`Start-Process explorer.exe -ArgumentList ('/select,"' + $env:SB_OPEN_FILE + '"')`, uri.fsPath);
    }
    return vscode.env.openExternal(vscode.Uri.file(require('path').dirname(uri.fsPath))).then(Boolean, () => false);
  },
};

module.exports = opener;

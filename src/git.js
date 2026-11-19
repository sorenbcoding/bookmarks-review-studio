const { execFile } = require('child_process');
const os = require('os');

/** Author name for new notes: git user.name of the project, falling back to the Windows user name. */
function authorName(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['config', 'user.name'], { cwd, windowsHide: true, timeout: 3000 }, (err, stdout) => {
      const name = err ? '' : String(stdout).trim();
      if (name) return resolve(name);
      try {
        resolve(os.userInfo().username);
      } catch {
        resolve('Unknown');
      }
    });
  });
}

module.exports = { authorName };

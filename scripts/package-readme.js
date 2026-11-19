// Writes dist/README.vsix.md, the README packaged in the .vsix.
// vsce would point relative images at the GitHub repo, which is private, so Studio's Details pane
// can't load them, and it rejects data URIs. The packaged README therefore keeps relative paths
// (vsce runs with --no-rewrite-relative-links) to files inside the .vsix. GitHub keeps README.md.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
  // GitHub-only dark variant: the Details pane would show both logos.
  .replace(/^.*<img [^>]*#gh-dark-mode-only[^>]*>\r?\n/m, '')
  .replace(/#gh-light-mode-only"/g, '"');

const shipped = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
for (const [, src] of out.matchAll(/<img src="([^"]+)"/g)) {
  if (!/^https:/.test(src) && !shipped.includes(`!${src}`)) {
    throw new Error(`README image ${src} is not in the .vsix. Add !${src} to .vscodeignore.`);
  }
}
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'README.vsix.md'), out);
console.log('Wrote dist/README.vsix.md');

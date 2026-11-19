# Bookmarks Review for UiPath Studio

Owner: sorenbcoding
Brand: sorenb-brand
Brand category: extension (violet accent, ID pattern `SorenB.Studio.BookmarksReview` → extension name `sorenb-studio-bookmarks-review`)

UiPath Studio 26 extension (VS Code-compatible extension host, API 1.95, JavaScript, packaged as `.vsix`). It adds rich review notes to Studio's built-in bookmarks: formatted text and inline screenshots, stored in the project's Git repo. The repo is private.

## Layout
- `src/`: extension code.
  - `extension.js`: the webview view controller.
  - `stores.js`: file access.
  - `git.js`: the author name.
  - `src/core/`: pure logic with no `vscode` dependency, all unit-tested. `bookmarks.js` parses `bookmarks.json`, `noteFile.js` handles the note format, `reconcile.js` links notes to bookmarks.
- `webview/`: sidebar UI. It uses the Toast UI Editor (WYSIWYG, stores Markdown) and is bundled by esbuild into `dist/webview.js` and `dist/webview.css`. `dist/` is build output: it isn't committed, and the brand check skips it.
  - Styles live in `webview/style.css`, built on the brand tokens in `webview/sorenb-tokens.css`.
  - That token file is a copy from the brand skill: don't edit it here.
  - `main.js` sets `data-theme` from Studio's theme class, so the tokens follow light and dark.
- `media/icon.svg`: the activity bar icon.
- `branding/`: the product logo, generated with the sorenb-brand `make_logo.py`. The glyph is in `branding/glyphs/bookmark-note.svg`.
  - The PNGs were rendered with resvg, because the Cairo DLL that `make_logo.py` uses for PNGs isn't installed.
  - The 128 px light PNG is the package icon, and the 128 px PNGs are also the README logo, since vsce rejects SVGs in a README.
- `test/`: `node:test` unit tests. `test/fixtures/bookmarks.json` is a real Studio sample.
- `docs/design.md`: the design and what Studio allows.
- `research/`: the throwaway probe extensions and their results from Studio. They are evidence for the constraints below. They are not shipped.

## Constraints (verified in Studio, see `research/`)
- **Treat `.project/bookmarks.json` as Studio's file: read only.**
  - Format: `{ "Value": { "<project-relative .xaml path>": [ { IsEnabled, Annotation, Id, ActivityIdRef, ActivityId, ActivityName, IsTransient } ] } }`.
  - `Annotation` is `null` when a bookmark has no message.
  - Studio replaces the file (deletes it, then creates it again) rather than editing it, so watchers must debounce.
- **Linking notes to bookmarks:**
  - The bookmark `Id` survives editing the message, disable/enable, moving the activity and renaming the workflow.
  - Deleting a bookmark and adding it again gives a new `Id`. Notes are then re-linked by workflow + `ActivityIdRef`; the IdRef alone isn't unique across files.
  - `ActivityId` is positional and is not used.
- **Notes live in `.review/`:**
  - Each note is `.review/notes/<noteId>.md`, with JSON-string front matter. `noteId` is the bookmark id at creation and never changes.
  - Screenshots go in `.review/assets/<noteId>/`.
  - There is no shared index file, to avoid merge conflicts.
  - Never delete a note automatically, except one that is empty with status Open.
- **What the Studio extension host can and can't do:**
  - Only sidebar webview views work. There's no command palette, and no commands for bookmarks or the designer.
  - Studio exposes open workflows as XML text editors. `onDidChangeActiveTextEditor` reports workflow tab switches, and `vscode.open` brings a workflow to the front.
  - Studio reports **no** activity selection and ignores editor selections. Focusing an activity stays with Studio's Markers panel.
- Studio fills icon geometry instead of stroking it, so `media/icon.svg` must be built from filled shapes. This is the same constraint as in tenant-switcher-studio.
- **Webview security:** use a nonce CSP. Accept only validated GUID ids and `.xaml` paths from webview messages.
- **Brand colours inside Studio:**
  - The panel chrome takes Studio's theme (`--vscode-*`).
  - The violet `--sb-accent-extension` marks only the current workflow, links and focus.
  - Status badges are outlined, in `--sb-status-*`.
  - Never use orange or raw hex in `webview/style.css`.
- Changes follow the `sorenb-dev-cycle` skill. There is **no CI** yet: rely on local `npm test` plus `npm run build`, and say so in PRs.

## Commands
- `npm test`: unit tests.
- `npm run build`: bundles the webview.
- `npm run package`: test, build and create the `.vsix`.
- Brand check: `python ~/.claude/skills/sorenb-brand/scripts/brand_check.py . --category extension`.

# Bookmarks Review for UiPath Studio

Owner: sorenbcoding
Brand: sorenb-brand
Brand category: extension (violet accent, ID pattern `SorenB.Studio.BookmarksReview` → extension name `sorenb-studio-bookmarks-review`)

UiPath Studio 26 extension (VS Code-compatible extension host, API 1.95, JavaScript, packaged as `.vsix`). It adds rich review notes to Studio's built-in bookmarks: formatted text and inline screenshots, stored in the project's Git repo. The repo is public.

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
  - **There are two exceptions.** Both go through `BookmarkStore.removeAllExcept`, which runs `removeBookmarks` in `src/core/bookmarks.js`, and both happen only on an explicit user action:
    - **Wrapping up a review** with `bookmarksReview.removeBookmarksOnWrapUp` on (default off). It runs after the archive is written, and keeps the bookmarks of notes that stay.
    - **Delete all notes and bookmarks** in the Settings view, after a confirmation in the panel. It keeps nothing.
  - **What the removal does:**
    - It keeps transient bookmarks.
    - It drops workflows left empty.
    - It writes Studio's format: 2-space JSON, CRLF line endings, and a BOM only if the file had one.
    - Verified in Studio: the Markers panel picks up the change while the project is open.
  - Format: `{ "Value": { "<project-relative .xaml path>": [ { IsEnabled, Annotation, Id, ActivityIdRef, ActivityId, ActivityName, IsTransient } ] } }`.
  - `Annotation` is `null` when a bookmark has no message.
  - Studio replaces the file (deletes it, then creates it again) rather than editing it, so watchers must debounce.
- **Linking notes to bookmarks:**
  - The bookmark `Id` survives editing the message, disable/enable, moving the activity and renaming the workflow.
  - Deleting a bookmark and adding it again gives a new `Id`. Notes are then re-linked by workflow + `ActivityIdRef`; the IdRef alone isn't unique across files.
  - `ActivityId` is positional and is not used.
- **Notes live in `.review/`:**
  - Each note is `.review/notes/<noteId>.md`, with JSON-string front matter. `noteId` is the bookmark id at creation and never changes.
  - **Replies** are separate files, `.review/replies/<noteId>/<yyyymmddThhmmssZ>-<rand>.md`, using the same front matter format (`author`, `created`, `updated`).
    - They are append-only, so a note edit and a reply never conflict in Git.
    - Only the author (matched on `git config user.name`) may edit or delete a reply. The controller enforces this, not just the UI.
  - Screenshots of a note and its replies go in `.review/assets/<noteId>/`.
    - Links are relative: `../assets/` from notes, `../../assets/` from replies.
    - A screenshot is deleted only when neither the note nor any reply references it (`isAssetReferenced`).
  - There is no shared index file, to avoid merge conflicts.
  - Never delete a note automatically, except one that is empty, has status Open and has no replies. Deleting a note also deletes its replies and screenshots.
  - Notes without a bookmark (orphans) are deleted only by the user, one at a time or with **Delete all**.
  - `bookmarksReview.hideNotesWithoutBookmark` only hides orphans; the files stay.
  - **Settings** (`SETTINGS` in `src/extension.js`) are boolean user settings, default off, read and written through `setting()` and `setSetting()`. If the host can't save one, `context.globalState` holds the choice and takes precedence.
- **Wrap up** (`exportArchive` in `src/extension.js`, pure logic in `src/core/archive.js`):
  - **The zip:**
    - It is written by `src/core/zip.js`, a small deflate writer with no dependencies, because Studio's Node version is unknown.
    - It contains `summary.md`, `report.html`, `.review/**` and `studio-bookmarks.json`.
    - It is saved in the folder from `globalState.archiveFolder`, default Documents. That folder is chosen through `showOpenDialog`, never through a path from the webview.
  - **`report.html`:**
    - Bodies are rendered by the panel's Toast UI viewer (`renderReport` / `reportRendered`), so they match the read view and are sanitized.
    - Screenshots are embedded as data URIs.
    - If the panel doesn't answer within 30 s, the bodies are shown as plain text.
    - Its styles are `webview/report.css` with the brand tokens, bundled to `dist/report.css`.
  - **Removal:** notes are removed only after the zip is written and its size checked. Modes are `closed` (resolved and won't fix), `all` and `none`.
- **The Settings view** (`renderSettings` in `webview/main.js`) holds:
  - checkboxes for the two settings;
  - a Delete section with **Delete all notes** and **Delete all notes and bookmarks** (`deleteAll` in `src/extension.js`). Each asks for confirmation, with the counts.
- **Delete only what was confirmed or archived:**
  - **Bulk deletes:** `deleteOrphans` and `deleteAll` take the note ids, and bookmark ids, that the panel showed in its confirmation. The controller deletes only those that still qualify.
  - **Wrap-up:** a note is removed only if its files (`ReviewStore.noteFiles`) are byte-identical to the archived snapshot. A note that changed during the export is kept and reported.
  - **Fresh screenshots:** a pasted screenshot is protected from cleanup (`freshAssets`) until a saved text links it, for at most 10 minutes, so an autosave already in flight can't delete it. `discardDraft` ignores the protection.
- **Confirmations are shown in the panel** (`confirmButton` in `webview/main.js`), not through `showWarningMessage({ modal: true })`. Host dialogs are not verified in Studio.
- **Note view:**
  - Existing notes open in the read view (Toast UI viewer). A bookmark without a note opens in the editor.
  - A screenshot click opens the file in its default Windows app (`src/openFile.js`: `Invoke-Item -LiteralPath` through `powershell.exe`, path passed in an environment variable). `vscode.env.openExternal` did not open local files in Studio, so it is only the fallback.
  - `openImage` accepts only `<noteId>/<image file>` under `.review/assets/`, and builds the path from the assets folder, never from the URL.
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
- `npm test`: unit tests for `src/core/`, plus controller tests (`test/controller.test.js`) that run the real controller against a temporary project on disk, with `vscode` replaced by `test/helpers/vscode-mock.js`.
- `npm run build`: bundles the webview, and `webview/report.css` into `dist/report.css` for the archive report.
- `npm run package`: test, build and create the `.vsix`.
- Brand check: `python ~/.claude/skills/sorenb-brand/scripts/brand_check.py . --category extension`.

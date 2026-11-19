# Bookmarks Review

Rich review notes for UiPath Studio bookmarks: formatted text and inline screenshots, stored in the project's Git repo.

Studio's own bookmarks stay unchanged. The extension only **reads** `.project/bookmarks.json`, and keeps its notes in a `.review/` folder next to the project.

## Install
1. Build the package (or use a built `bookmarks-review-0.1.0.vsix`):
   ```
   npm install
   npm run package
   ```
2. In Studio, open the Extensions panel, choose install from file, and pick the `.vsix`.
3. Open a project. The **Bookmarks Review** panel lists every bookmark, grouped by workflow.

## How the team uses it
**Reviewer**
1. Add a bookmark in Studio: right-click an activity and choose Toggle Bookmark. The short Studio message works as the bookmark's title.
2. Click the bookmark in the Bookmarks Review panel and write the note. Use the toolbar for formatting, and paste screenshots with Ctrl+V (for example after Win+Shift+S).
3. Set a status: Open, Resolved or Won't fix. Notes save automatically.
4. Commit and push `.project/bookmarks.json` together with `.review/`.

**Developer**
1. Pull. The panel shows the notes, with screenshots inline.
2. Jump to the activity through Studio's own Markers panel (double-click the bookmark, or right-click and choose Focus).
3. Fix the issue and set the status to Resolved.

**Navigation between Studio and the panel**
- **The panel follows Studio.** The workflow you have open in Studio is listed first and marked "Open in Studio". This also happens when Focus in the Markers panel jumps to another workflow. Tick **This workflow only** to hide the other workflows.
- **"Show in Studio"** (on a workflow in the list, or at the top of a note) brings that workflow to the front in Studio.
- **Limits:** Studio doesn't tell extensions which activity or bookmark is selected, and doesn't let them select an activity. Focusing the exact activity therefore stays with the Markers panel, and opening the note stays with the Bookmarks Review panel. These limits were checked with the probe extensions in `research/` (see `docs/design.md`).

## What is stored
```
<project>/
  .project/bookmarks.json              Studio's file (read only)
  .review/
    notes/<noteId>.md                  one note per bookmark: front matter + Markdown
    assets/<noteId>/<timestamp>.png    screenshots, referenced as ../assets/<noteId>/… in the note
```
- **Readable outside Studio.** Notes are plain Markdown, so they read well on GitHub and Azure DevOps, and diff and merge like code.
- **Author.** New notes take their author from the project's `git config user.name`, falling back to the Windows user name.
- **Bookmark deleted and re-added on the same activity.** The note re-attaches automatically: Studio gives the new bookmark a new id, so it is matched on workflow + activity instead.
- **Bookmark deleted for good.** Its note appears under "Notes without a bookmark", where you can delete it. It is never deleted silently.
- **Empty note.** Clearing a note while its status is Open removes the note file.
- **Screenshot cleanup.** Removing a screenshot from a note deletes its file.

Make sure `.review/` and `.project/bookmarks.json` are **not** listed in the project's `.gitignore`. It's also a good idea to add this line to `.gitattributes`:
```
.review/assets/** binary
```

## Development
- `npm test`: unit tests for bookmark parsing, the note format and note re-linking (`src/core/`)
- `npm run build`: bundles the webview (`webview/`) into `media/main.js` and `media/main.css`
- `npm run package`: test, build and create the `.vsix`

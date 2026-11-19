<p align="center">
  <img src="branding/bookmarks-review-studio-light-128.png#gh-light-mode-only" width="96" alt="Bookmarks Review for UiPath Studio logo">
  <img src="branding/bookmarks-review-studio-dark-128.png#gh-dark-mode-only" width="96" alt="Bookmarks Review for UiPath Studio logo">
</p>

<h1 align="center">Bookmarks Review for UiPath Studio</h1>
<p align="center">By Søren Schytz Birk</p>

Bookmarks Review for UiPath Studio adds review notes to Studio's built-in bookmarks. A note can hold formatted text and inline screenshots. Notes are stored in the project's Git repo, so the developer gets them with a pull.

## Install

- Requires UiPath Studio 2026 with the Extensions panel (VS Code extension API 1.95). It also runs in VS Code 1.95 or later.
- Build `sorenb-studio-bookmarks-review-<version>.vsix` with `npm install` and then `npm run package`.
- In Studio, open the Extensions panel, choose install from file, and pick the `.vsix`.
- Open a project. The **Bookmarks Review** icon in the activity bar opens the panel.

Studio's own bookmarks are not changed. The extension only reads `.project/bookmarks.json`, and keeps its notes in a `.review/` folder in the project.

## Quick example

**Reviewer**
1. In Studio, right-click an activity and choose Toggle Bookmark. The bookmark's short message becomes its title in the panel.
2. In the Bookmarks Review panel, click the bookmark and write the note.
   - Use the toolbar for headings, bold, lists, code and links.
   - Paste screenshots with Ctrl+V, for example after Win+Shift+S.
3. Set the status to Open, Resolved or Won't fix. Notes save automatically.
4. Commit and push `.project/bookmarks.json` together with `.review/`.

**Developer**
1. Pull. Click a bookmark in the panel. The note opens read-only, with screenshots inline. Click a screenshot to open it in the Windows image viewer.
2. To jump to the activity, double-click the bookmark in Studio's Markers panel, or right-click it and choose Focus.
3. Fix the issue. Then click **Mark resolved**, and use **Add reply** to say what you changed.
4. Commit and push `.review/`.

## Reference

### Panel
- **Bookmark list.** Every bookmark appears, grouped by workflow, with its note status: No note, Open, Resolved or Won't fix. Disabled bookmarks are dimmed.
- **Follows Studio.** The workflow in front in Studio is listed first and marked *Open in Studio*. This includes a jump made by Focus in the Markers panel. **This workflow only** hides the other workflows.
- **Show in Studio** (on a workflow, or at the top of a note) brings that workflow to the front in Studio.
- **Notes without a bookmark** lists notes whose bookmark was deleted. Add a bookmark on the same activity again to re-attach the note, or delete the note.

### Note view
- **Read view.** An existing note opens read-only, rendered as formatted text.
  - Click a screenshot to open it in the Windows default image viewer.
  - **Edit note** switches to the editor. **Done** returns to the read view.
  - A bookmark without a note opens straight in the editor.
- **Status.** **Mark resolved** and **Reopen**, or the status list, change the status without opening the editor.
- **Replies.** **Add reply** writes a reply under the note. A reply can hold formatting and screenshots, and shows its author and time.
  - You can edit or delete only your own replies. Ownership is matched on `git config user.name`.
  - The reviewer's note is never changed by a reply.

### Stored files
```
<project>/
  .project/bookmarks.json              Studio's file (read only)
  .review/
    notes/<noteId>.md                  one note per bookmark: front matter + Markdown
    replies/<noteId>/<time>-<id>.md    one file per reply: author, created, updated + Markdown
    assets/<noteId>/<timestamp>.png    screenshots of the note and its replies
```
- **Replies are separate files.** A reviewer editing a note and a developer replying never cause a Git conflict.
- Notes are plain Markdown, so they read well on GitHub and Azure DevOps, and diff and merge like code.
- The author of a new note is the project's `git config user.name`, or the Windows user name if Git has none.
- **A bookmark deleted and added again on the same activity** gets a new id from Studio. The note re-attaches by matching workflow + activity.
- **A note that is cleared while its status is Open, and has no replies,** is removed.
- **Removing a screenshot** deletes its file once neither the note nor a reply links it.
- **Deleting a note** also deletes its replies and screenshots.
- **Required:** `.review/` and `.project/bookmarks.json` must not be listed in the project's `.gitignore`.
- **Recommended:** add `.review/assets/** binary` to `.gitattributes`.

### Limits
Studio doesn't tell extensions which activity or bookmark is selected, and doesn't let them select an activity. So:
- Focusing the exact activity stays with the Markers panel.
- Opening the note stays with the Bookmarks Review panel.

`docs/design.md` describes what was verified in Studio, using the probe extensions in `research/`.

### Development
| Command | What it does |
|---|---|
| `npm test` | Unit tests for `src/core/` (bookmark parsing, note format, re-linking) and controller tests that run the extension against a temporary project with a `vscode` mock (`test/helpers/vscode-mock.js`) |
| `npm run build` | Bundles the webview (`webview/`) into `media/main.js` and `media/main.css` |
| `npm run package` | Tests, builds and creates the `.vsix` |

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT. See [LICENSE](LICENSE).

---

By Søren Schytz Birk · UiPath Community MVP · [github.com/sorenbcoding](https://github.com/sorenbcoding)

Bookmarks Review for UiPath Studio is an independent open-source project by Søren Schytz Birk (github.com/sorenbcoding) and is not affiliated with, endorsed by, or sponsored by UiPath. UiPath and related names are trademarks of UiPath Inc.

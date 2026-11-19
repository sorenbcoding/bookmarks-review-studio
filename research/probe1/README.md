# Bookmarks Review – Phase 0 probe

A throwaway extension that answers one question: **what can a `.vsix` do inside UiPath Studio's Extensions panel?**
It doesn't change Studio's bookmarks. It only reads `.project/bookmarks.json` and writes test files under `.review/probe/`.

## Build the .vsix
```
cd probe
npm run package
```
This creates `bookmarks-review-probe-0.0.1.vsix`. It needs internet access the first time, to download `@vscode/vsce`.

## Test in VS Code first (optional, about 2 min)
1. Open the `probe` folder in VS Code and press F5.
2. In the window that opens, open `probe/test-project`. It contains a copy of your real `bookmarks.json`.
3. Look for the "Review Probe" icon in the activity bar. It should list 3 bookmarks across 2 workflows.

## Test in UiPath Studio (the real test)
1. Studio → Extensions panel → install from file → pick the `.vsix`. Restart Studio if it asks you to.
2. Open a project that has bookmarks.
3. Note what happens for each check below.

| # | Check | How |
|---|---|---|
| 1 | Does the extension activate? | Look for a "Bookmarks Probe" output/log, or the `.review/probe/probe-report.json` file in the project |
| 2 | Does a sidebar view appear? | "Review Probe" icon / "Bookmarks" view |
| 3 | Does an editor panel open? | Command "Bookmarks Probe: Open Test Panel" (if Studio has a command palette) |
| 4 | Are your bookmarks listed? | In the view or panel |
| 5 | Does it notice changes? | Add or edit a bookmark in Studio; the list should update on its own |
| 6 | Does screenshot paste work? | Win+Shift+S, click the paste box, Ctrl+V. The image should appear and be saved in `.review/probe/` |
| 7 | Studio-specific commands? | See `possiblyStudioRelated` in `probe-report.json`, and `all-commands.txt` |

Send back `.review/probe/probe-report.json` and `all-commands.txt` plus notes on checks 2, 3, 5 and 6. Then delete the `.review/probe/` folder.

# Design

## Goal
The team uses Studio bookmarks to mark points found in code review. A Studio bookmark holds one plain-text message. This extension adds a review note to each bookmark, with formatted text and inline screenshots. The notes are stored in the project's Git repo, so the developer gets them with a pull.

## Why a Studio extension (and not something else)
- **The classic Studio SDK can't host this.** `UiPath.Studio.Activities.Api` offers ribbon wizards, settings and the project path. It has no custom panels, no context menus, no selection and no bookmark API, and it only loads in projects that list the package as a dependency.
- **Hooking into Studio's WPF UI was rejected.** It's unsupported and breaks on Studio upgrades.
- **Studio 2026 runs VS Code-style extensions.** Its Extensions panel (VS Code API 1.95) installs `.vsix` files, and these can add sidebar webview views. That is the supported route.
- **Activity annotations can't hold formatting.** `sap2010:Annotation` is plain text only.

## Studio's bookmarks (`.project/bookmarks.json`)
UiPath doesn't document this file. Its format was confirmed from real samples and from diffs after each change:
```json
{ "Value": { "Studie+/API/Hent elever via API (Studie+ B2105).xaml": [ {
    "IsEnabled": true, "Annotation": "…" , "Id": "c7311c1d-…", "ActivityIdRef": "If_13",
    "ActivityId": "1.988", "ActivityName": "…", "IsTransient": false } ] } }
```

| Change in Studio | `Id` | `ActivityIdRef` | Workflow path key |
|---|---|---|---|
| Edit the message | same | same | same |
| Disable, then re-enable | same | same | same |
| Move (drag) the activity | same | same | same |
| Rename the workflow | same | same | updated by Studio |
| Delete and re-add the bookmark | **new** | same | same |

- Paths are relative to the project root and use `/`.
- A bookmark with no message has `Annotation: null`.
- `ActivityId` is positional and is not used.
- Studio replaces the whole file (deletes it, then creates it again) rather than editing it in place.

## Data model
```
<project>/
  .project/bookmarks.json              Studio's file: read only, never extended
  .review/
    notes/<noteId>.md                  front matter (JSON-string values) + Markdown body
    replies/<noteId>/<time>-<id>.md    one file per reply (author, created, updated) + Markdown body
    assets/<noteId>/<timestamp>.png    screenshots, linked as ../assets/<noteId>/…
```
- **Note id:** `noteId` is the bookmark id at the time the note was created, and never changes. The front matter holds the current `bookmarkId` and hints for re-linking (`workflow`, `activityIdRef`, `activityName`), plus `status`, `author`, `created` and `updated`.
- **No shared index file**, so two reviewers editing different notes never conflict.
- **Linking** (`src/core/reconcile.js`) takes three steps:
  1. Match a note by `bookmarkId`.
  2. If that fails, re-attach the note to a bookmark on the same workflow + `ActivityIdRef` that has no note yet. This covers a bookmark deleted and added again.
  3. If that fails too, the note is an orphan. It is shown separately and never deleted automatically.
- **Hints stay current:** each refresh updates the hints, so renaming a workflow doesn't break step 2.
- **Replies** are separate, append-only files, so a developer replying never conflicts in Git with a reviewer editing the note. Only the author can edit or delete a reply.
- **Screenshots:** the editor shows them through webview URLs, and saving rewrites those to relative paths (`../assets/` from notes, `../../assets/` from replies). A screenshot is deleted only when neither the note nor any reply references it.

## What the Studio extension host allows
The probe extensions in `research/` verified this in Studio.

| Capability | Result |
|---|---|
| Sidebar webview view | Works |
| Editor-tab webview panels, command palette | Not available |
| Reading and writing project files, file watchers | Works. The workspace folder is the project root |
| Clipboard image paste in a webview | Works |
| Commands for bookmarks or the designer | None. Studio offers only `rpaCanvas.*` (Low-Code Viewer for `.cs`), `setContext` and extension commands |
| UiPath extension APIs (`exports`) | None |
| Which workflow is in front | `onDidChangeActiveTextEditor` (workflows appear as XML text editors) |
| Bring a workflow to the front | `vscode.open` / `showTextDocument` |
| Which activity or bookmark is selected or focused | Not reported |
| Select an activity from the extension | Not possible. The designer ignores editor selections |

What this means for the UI:
- The panel follows the workflow in front, and offers "Show in Studio" to bring a workflow forward.
- Focusing the exact activity stays with Studio's Markers panel.

## Next ideas
- Export a review summary as Markdown, for the PR description.
- Filter the list by status.
- Find out what `IsTransient` means. Such bookmarks are ignored for now.

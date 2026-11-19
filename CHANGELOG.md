# Changelog

All notable changes to Bookmarks Review for UiPath Studio are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Notes open in a read view.** An existing note opens read-only, rendered as formatted text.
  - **Edit note** switches to the editor, and **Done** returns to the read view. A bookmark without a note still opens in the editor.
  - Click a screenshot to open it in the Windows default image viewer.
  - ([#3](https://github.com/sorenbcoding/bookmarks-review-studio/issues/3))
- **Mark resolved** and **Reopen** buttons, and the status list, work from the read view without opening the editor. ([#3](https://github.com/sorenbcoding/bookmarks-review-studio/issues/3))
- **Replies under a note**, with author, time, formatting and screenshots. ([#3](https://github.com/sorenbcoding/bookmarks-review-studio/issues/3))
  - Each reply is stored as its own file in `.review/replies/<noteId>/`, so replying never conflicts with edits to the note.
  - You can edit or delete only your own replies.
  - The list shows the number of replies.

- **Notes without a bookmark can be deleted.** ([#7](https://github.com/sorenbcoding/bookmarks-review-studio/issues/7))
  - Open one and click **Delete note**, or use **Delete all** in the list.
  - The confirmation is shown in the panel.
- **Notes without a bookmark can be hidden** from the panel with **Hide**, or the setting `bookmarksReview.hideNotesWithoutBookmark`. The files are kept. ([#7](https://github.com/sorenbcoding/bookmarks-review-studio/issues/7))

### Fixed
- **Clicking a note without a bookmark** opens it. Before, nothing happened. ([#7](https://github.com/sorenbcoding/bookmarks-review-studio/issues/7))
- **This workflow only** shows that workflow's notes without a bookmark. Before, they were hidden. ([#7](https://github.com/sorenbcoding/bookmarks-review-studio/issues/7))

### Changed
- The extension is now `sorenbcoding.sorenb-studio-bookmarks-review`, displayed as *Bookmarks Review for UiPath Studio*, with the SorenB product logo. Uninstall the earlier `bookmarks-review.bookmarks-review` before installing it. ([#1](https://github.com/sorenbcoding/bookmarks-review-studio/issues/1))
- The panel uses the SorenB brand tokens. The violet accent marks the current workflow, links and focus. Status badges are outlined in the brand status colours, so they keep their contrast in dark themes. ([#1](https://github.com/sorenbcoding/bookmarks-review-studio/issues/1))
- The activity bar icon is made of filled shapes, because Studio fills icon geometry. ([#1](https://github.com/sorenbcoding/bookmarks-review-studio/issues/1))

## [0.2.0] - 2026-11-19

### Added
- The panel follows the workflow in front in Studio, including a jump made by Focus in the Markers panel. That workflow is listed first and marked *Open in Studio*.
- **This workflow only** hides the other workflows.
- **Show in Studio** on a workflow, or at the top of a note, brings that workflow to the front in Studio.

## [0.1.0] - 2026-11-17

### Added
- A Bookmarks Review panel that lists Studio's bookmarks from `.project/bookmarks.json`, grouped by workflow, and updates live.
- A review note for each bookmark:
  - a WYSIWYG editor that saves Markdown;
  - screenshots pasted inline, saved to `.review/assets/`;
  - a status: Open, Resolved or Won't fix;
  - the author taken from `git config user.name`.
- Notes re-attach automatically when a bookmark is deleted and added again on the same activity. Notes without a bookmark are kept and can be deleted by hand.

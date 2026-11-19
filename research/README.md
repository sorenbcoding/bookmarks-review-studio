# Research probes

These are throwaway extensions that were run inside UiPath Studio to find out what the extension host allows. They are not shipped. The conclusions are in `../docs/design.md`.

| Folder | Question | Result |
|---|---|---|
| `probe1/` | Can a `.vsix` show a panel, read `bookmarks.json`, watch files and paste screenshots? | Yes to all of them. Only a sidebar webview view works, there is no command palette, and there are only 9 commands. |
| `probe2/` | Can an extension see which workflow or activity is focused, and can it make Studio navigate to one? | It can see and open the workflow, but it can't see or select the activity. |
| `results/probe2-run2/` | The probe2 v0.0.3 log from Studio | Buttons A–D all switched the workflow, and none selected the activity. |
| `probe3/` | Which Git, issue and pull-request routes can an extension use: the `git` command line, `.git`, `gh`/`az`, sign-in, the browser, the clipboard and the commit dialog? | Not run in Studio yet (#25). |

To build a probe, run `npm run package` inside its folder. A probe writes its output to `.review/probe*/` in the opened project. Delete that folder afterwards.

# Probe 3: Git and pull-request integration

Issue #25. This probe finds out which routes to Git, issues and pull requests an extension can use inside Studio. Studio's own source control is internal and has no commands, so it isn't one of them.

## What it checks
**Automatically, when Studio starts:**
- **The `git` command line:**
  - where it's installed, and its version;
  - whether the project is a Git repository, and whether its root is the project folder or a parent;
  - whether HEAD, the branch and the `origin` remote can be read;
  - whether `.review/` is ignored or has changes;
  - whether `git diff` works.
- **The `.git` folder read directly**, without the command line: HEAD and the `origin` URL from `config`.
- **The `vscode.git` extension API** and any other Git-related extensions.
- **Sign-in providers:** `vscode.authentication` for `github` and `microsoft`, checked silently.
- **`SecretStorage`:** a store, read and delete round trip.
- **The `gh` and `az` command lines:** installed and signed in.

**By hand, with a button for each test:**

| Test | What it does |
|---|---|
| A | `openExternal` with a plain `https://` URL |
| B, C | `openExternal` with a pre-filled GitHub "new issue" URL, about 3 KB and about 12 KB |
| D | A link in the panel |
| E | PowerShell `Start-Process` with the 3 KB URL |
| F | A pre-filled "new issue" page on the project's own remote: GitHub, GitLab or Azure DevOps |
| G | A clipboard round trip with Markdown and æøå |
| H | Whether Studio's commit dialog lists files under `.review/` |

B, C, E and F only open a page. Nothing is created unless you submit it, so don't.

## Privacy
The results are committed to this public repo, so the probe leaves out:
- remote URLs: only the host type and the number of path parts are kept;
- branch names: only whether there is one and its length;
- commit ids;
- the project path and the user folder;
- the output of `gh auth status`.

## Run it
1. Build it: `npm run package` in this folder, which gives `bookmarks-review-probe3-0.0.1.vsix`.
2. Install the `.vsix` in Studio through the Extensions panel.
3. Open a project that is a Git repository with a remote, ideally on GitHub or Azure DevOps.
4. Open the **Git Probe** view in the activity bar. The automatic checks run at startup, and the log shows when they're done.
5. For each test A to H:
   1. Click **Run**. For D, click the link instead.
   2. Look at what happens.
   3. Click **Worked**, **Partly**, **Nothing happened** or **Error**. Add a note when it's only partly right.
6. Click **Save files now**.
7. Copy `.review/probe3/` from the project into `research/results/probe3/` in this repo.
8. Delete `.review/probe3/` from the project, and uninstall the probe.

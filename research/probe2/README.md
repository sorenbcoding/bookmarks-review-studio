# Probe 2: navigation between Studio and the extension

## Results of run 1 (`result/probe2`)
- **Studio reports which workflow is active.** Extensions see open workflows as XML text editors. "Active text editor" changes when you switch tabs, and when Focus or a double-click jumps to another workflow.
- **Studio does not report which activity is selected.** Clicking activities, or using Focus inside the workflow that's already open, logs nothing. Nothing is written to disk either.
- **The candidate commands don't apply.** No new commands appear once workflows are open, and UiPath's extensions export nothing. `rpaCanvas.*` belongs to the Low-Code Viewer, which handles coded `.cs` workflows, not the XAML designer.
- **Studio replaces `bookmarks.json` instead of editing it**: the file is deleted, then created again.

## Run 2 (v0.0.3): can the extension make Studio jump?
1. Uninstall v0.0.2, install `bookmarks-review-probe2-0.0.3.vsix`, and open a project with bookmarks in two workflows. Open both workflows.
2. In the **Jump test**, pick a bookmark. The first one is already selected.
3. For each button, A to D:
   1. Switch Studio to the *other* workflow tab.
   2. Click the button.
   3. Type in the Marker box what Studio did ("nothing", "switched workflow", "selected the activity" or "error") and press Enter.
4. Click **Save files now**, and copy `.review/probe2` into `result/probe2-run2` in this repo.

# Ticket viewer

Local kanban board for projects that keep tickets as markdown files in `.scratch/<feature>/issues/NN-<slug>.md`. No dependencies; needs Node 20+.

```sh
node ~/tools/ticket-viewer/cli.mjs ~/code/my-project                 # repo root: all features
node ~/tools/ticket-viewer/cli.mjs ~/code/my-project/.scratch/foo    # one feature
node ~/tools/ticket-viewer/cli.mjs . --port 5000 --no-open
```

To get a `ticket-viewer` command on your PATH: `cd ~/tools/ticket-viewer && npm link`. Then run `ticket-viewer <project-folder>` from anywhere.

The folder can be a repo root containing `.scratch/`, a `.scratch` folder, or a single feature folder. The server listens on `127.0.0.1` (default port 4777, next free port if taken) and opens your browser.

## What it shows

- One lane per status, in the order given by `--lanes` (default `needs-triage,needs-info,ready-for-agent,ready-for-human,claimed,resolved,wontfix`). Any other status found in a file gets its own lane; tickets without one go in "no status".
- Cards show number, title, the "What to build" line, acceptance-criteria progress (`- [ ]` / `- [x]`), type and comment count.
- A ticket is **blocked** while any ticket in its `Blocked by:` line isn't `resolved`, `done`, `closed` or `wontfix`.
- Click a card for the full rendered ticket, with links to its blockers and the tickets it blocks.
- The board reloads live when files change on disk.

## Editing

Dragging a card to another lane (or using the status dropdown in the detail panel) rewrites the ticket's `Status:` line in the file, keeping its format (`Status: x` or `**Status:** x`). Nothing else in the file is touched.

## Parsing rules

Metadata lines are read above the first `##` heading, as `Key: value` or `**Key:** value`. Recognised keys: `Status`, `Type`, `Blocked by`, `Owner`, `Assignee`, `Priority`, `Labels`. Status values are lower-cased and spaces become dashes.

## Tests

```sh
cd ~/tools/ticket-viewer && npm test
```

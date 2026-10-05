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

- One lane per status, in the order given by `--lanes` (default `needs-triage,needs-info,ready-for-agent,ready-for-human,claimed,ready-for-review,resolved,wontfix`). Any other status found in a file gets its own lane; tickets without one go in "no status".
- Cards show number, title, the "What to build" line, acceptance-criteria progress (`- [ ]` / `- [x]`), type and comment count.
- A ticket is **blocked** while any ticket in its `Blocked by:` line isn't `resolved`, `done`, `closed` or `wontfix`.
- Click a card for the full rendered ticket, with links to its blockers and the tickets it blocks.
- The board reloads live when files change on disk.

## Background agents

The board can run Claude Code for you, as Claude Code background sessions (`claude --bg`). The project must be a git repository that you have trusted in Claude Code (run `claude` there once), and `claude` must be on your PATH.

1. **Start**: drag a `ready-for-agent` card to **claimed**, or press **▶ Start agent** in its detail panel. You can't start a blocked ticket. The board sets `Status: claimed`, creates the branch `ticket/<feature>/<NN-slug>` with a worktree in `<repo>/.claude/worktrees/`, and starts `/implement <ticket>` there as a background session. The worktree is inside the repo so it inherits the repo's trust, and it's git-ignored through `.git/info/exclude`. Your own checkout isn't touched, and several agents can run at once.
2. **Follow**: the board polls `claude agents --json` and shows the session's state on the card:
   - **● agent running**
   - **⚠ needs you**: the agent is waiting on a permission prompt. The panel shows the command it wants to run.
   - **💬 waiting for a reply**: the agent ended its turn without committing, so it probably asked you something.
   - **■ agent stopped**

   **Copy attach** (also the ⧉ button on a claimed card) copies `claude attach <id>`. Run it in a terminal to watch the session, answer prompts, or reply. The session keeps running when you leave it (← or Ctrl+Z).
3. **Review**: when the agent ends its turn with new commits, the ticket moves to **ready-for-review**. There:
   - **Open diff in meld** runs `git difftool --dir-diff --tool=meld <base>` in the worktree, so you see everything since the branch was created, including uncommitted work. The panel also lists the commits and a diff stat, and shows the agent's last message.
   - **Open structure diff** (only when [codemap](#structure-diff-codemap) is installed) opens codemap's review list of structural changes since the same base.
   - **Approve** sets `resolved`, stops the session (its conversation is kept), stops its [worktree processes](#worktree-processes), and copies `git merge <branch> && git worktree remove <worktree> && git branch -d <branch>`. You do the merge.
   - **Send back to agent** adds your notes to the ticket's `## Comments` and resumes the agent's session with them, so it keeps its full context. The ticket goes back to claimed.

### Worktree processes

Agents start servers and watchers to test their work (`dotnet run`, `dotnet watch`, `npm run dev`, …), and these can still be running after the ticket reaches review. A **worktree process** is any running process whose working folder is inside a ticket's worktree, whoever started it, you or the agent. The agent's own Claude Code session (and anything in its process group, such as its MCP servers) is not one.

- On each poll the board finds them through `/proc/<pid>/cwd`, for every ticket with a worktree, whether or not its agent is running. For each it records the PID, process group, command line and listening TCP ports. Processes it can't read, such as other users', are skipped.
- A card with worktree processes shows **⚙ N processes**, in any lane. The Claude Code panel lists them with their command, ports and PID.
- **Kill** stops the process's whole process group, so `dotnet watch` takes its app down with it: SIGTERM first, then SIGKILL to anything still alive after 5 seconds. **Kill all** does that for every worktree process of the ticket. The board only kills processes that are worktree processes of that ticket at that moment.
- **Approve** and any move to **ready-for-agent** stop the ticket's worktree processes, and the toast says how many. Moving to ready-for-review doesn't, so you can click through the running app while you review. **Stop agent** stops only the session.
- The agent's prompt asks it to stop the servers and background processes it started before ending its turn; this catches the ones it forgets.

This works on Linux only. Without `/proc` (macOS, Windows) the board shows none of it and works as before.

### Structure diff (codemap)

When `codemap` is on your PATH at startup, a ticket in review also gets a structure diff; without it the board works exactly as before and shows none of this. The board only runs codemap's command line and imports none of its code.

- **Open structure diff** runs `codemap view --repo <worktree> --base <base>`, which opens a browser page listing structural changes (new cycles, project references, coupling, injected concrete classes, surface changes, moves). Mark each item OK or Flag there, with a note. If codemap fails, the panel shows why.
- The **Structure diff** section of the review panel runs `codemap diff --repo <worktree> --base <base> --json` and shows the count per group and your flagged items. It refreshes when you come back to the board's tab, or with ↻.
- **Copy flagged notes to Send back** adds the flagged items, in plain words with your notes, to the review notes. **Send back to agent** then works as usual.
- When an agent starts, the board runs `codemap snapshot --repo <worktree> --commit <base>` in the background, so the structure diff opens faster later. Its result is ignored.

**Stop agent** stops the session. **Continue agent** resumes it in the background and tells it to carry on. Sessions belong to Claude Code, not to the board: they keep running if you close the board, and the board picks them up again when it starts. The board's records are in `.git/ticket-viewer/agents.json`.

Sessions start in auto mode (`--permission-mode auto`): Claude Code's classifier approves routine actions, so the agent rarely stops to ask, and it still asks before risky ones. For more control, start the board with `--permission-mode acceptEdits`. Then only file edits are automatic, and anything not in your allowlist waits for you to attach and answer.

Options: `--claude <cmd>`, `--permission-mode <mode>`, `--difftool <tool>` (any `git difftool` tool name).

## Status changes

The board changes a ticket's `Status:` line only for these moves:

- ready-for-agent → claimed (starts an agent)
- claimed → ready-for-review (the agent committed and ended its turn)
- claimed → ready-for-agent (only while no agent is working)
- ready-for-review → resolved, claimed (send back to the agent) or ready-for-agent

Cards can only be dragged to those lanes. Every other change, such as triage decisions, goes through `/triage`, so the skill that owns the transition makes it. For example, `/triage` writes the agent brief when it moves a ticket to ready-for-agent. The board picks up file changes live.

## Copying commands

- The ⧉ button on a card (shows on hover) copies the next step: `/triage <path>` for tickets with no status, `needs-triage` or `needs-info`, and `/implement <path>` for `ready-for-agent`.
- The detail panel has **Copy /implement**, **Copy /triage**, and a **Move via /triage…** menu that copies `/triage move <path> to <state>`.
- Press `c` while a ticket is open to copy its next step (`/implement` when there is none).

Paths in these commands are relative to the repo root (the folder that contains `.scratch/`). Start the agent there.

Under the ticket title, the detail panel has up to three rows: the tickets it's blocked by and blocks, the copy commands above, and the ticket's path. The path is shown relative to the repo root, but clicking it copies the absolute path. When the ticket has an agent, **Copy worktree** next to it copies `cd <absolute worktree path>`, for jumping into the worktree from a terminal. The branch name in the Claude Code section copies the branch.

## Parsing rules

Metadata lines are read above the first `##` heading, as `Key: value` or `**Key:** value`. Recognised keys: `Status`, `Type`, `Blocked by`, `Owner`, `Assignee`, `Priority`, `Labels`. Status values are lower-cased and spaces become dashes.

## Tests

```sh
cd ~/tools/ticket-viewer && npm test
```

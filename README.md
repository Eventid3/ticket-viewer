# Ticket viewer

Local kanban board for projects that keep tickets as markdown files in `.scratch/<feature>/issues/NN-<slug>.md`. No dependencies; needs Node 20+.

```sh
node ~/tools/ticket-viewer/cli.mjs                                   # every remembered project
node ~/tools/ticket-viewer/cli.mjs ~/code/my-project                 # add (or open) a project: repo root
node ~/tools/ticket-viewer/cli.mjs ~/code/my-project/.scratch/foo    # ... or one feature folder, opened on that feature
node ~/tools/ticket-viewer/cli.mjs --port 5000 --no-open
```

To get a `ticket-viewer` command on your PATH: `cd ~/tools/ticket-viewer && npm link`. Then run `ticket-viewer` (or `ticket-viewer <project-folder>`) from anywhere.

The server listens on `127.0.0.1` (default port 4777) and opens your browser.

## Projects

One board shows every **project** you've added, one at a time. A project is one `.scratch` folder and the tickets under it. A repo root, its `.scratch` folder and any of its feature folders all name the same project, so adding any of them twice keeps one entry.

- **Config file**: projects are remembered in `$XDG_CONFIG_HOME/ticket-viewer/projects.json` (by default `~/.config/ticket-viewer/projects.json`), as a list of `{ "id", "path" }` where `path` is the absolute `.scratch` folder. The id is a slug of the repo folder's name, made when the project is added and never changed; a clash gets `-2`, `-3`, …. The id is what the URL, API and events use.
- **Names**: the picker shows the repo folder's name (the folder holding `.scratch/`). When two projects share a name, both show `<parent>/<name>`, and go back to the plain name once the clash is gone.
- **Picker**: top left, pick a project, then a feature in it ("All features" when it has more than one). Completed features (every ticket done) are listed last, greyed out below a `── completed ──` divider; without a feature in the hash the board opens on the first one with work left. The project goes in the URL hash as `project=<id>`, next to `feature` and `ticket`. Without a project in the hash, the board opens the project you picked last, else the first one.
- **Add project**: the last entry in the project picker opens a dialog. Type an absolute path (`~` works): a repo root, a `.scratch` folder or a feature folder. The server checks it the same way as the command line and shows what's wrong under the field. On success the project is saved and selected; a feature folder opens on that feature.
- **Worktrees**: a git worktree of another repo is refused ("This folder is a worktree of <repo>; add the repo instead"). Worktrees share the repo's agent records, so they're never a project of their own; add the repo.
- **Remove**: the same dialog lists every project with **Remove**. It only forgets the project: no files, worktrees or agent sessions are touched. With agents running it first warns that they keep running but their tickets won't move until you add the project again. Agent records stay in `.git/ticket-viewer/agents.json`, so adding the project back picks them up.
- **Unavailable**: a remembered project whose folder is gone or has no ticket folders stays in the list, greyed out and not selectable, with the reason as a tooltip. It never stops the board from starting. The board rechecks it every few seconds and when the project list loads, and picks it up without a restart once the folder is back.
- **Per project**: each project has its own agents, file watching, moves and copy commands (paths relative to that project's repo root). Agents of every project are followed, not just the one on screen, so a ticket still moves to ready-for-review when its agent finishes while you look at another project. Lanes, `--claude`, `--permission-mode` and `--difftool` apply to every project.
- **Project alerts**: next to the picker, a chip for each other project with tickets in ready-for-review or agents that need you (⚠ waiting on a prompt, or ended their turn without committing, outside ready-for-agent and ready-for-review), e.g. `shop 2 to review ⚠ 1`. Clicking it switches to that project, on the feature with those tickets ("All features" when several have some). The counts are the current state, worked out by the server for `GET /api/projects` (`review`, `needsYou`), so they survive a reload and clear themselves once the work moves on. Any project's change refreshes them live; the board itself only reloads for the selected project.

### Starting

- `ticket-viewer` starts with the remembered projects. With none, the page offers **Add project**.
- `ticket-viewer <folder>` checks the folder, adds it if it's new, and opens the board on it. A folder it can't use is an error.
- **Hand-off**: before starting, the command checks the port. If a ticket-viewer is already running there, it hands the folder (if you gave one) to that board, opens the browser on it unless `--no-open` is set, and exits; nothing new starts. The running board's errors (say, a worktree) are printed and the command exits non-zero. `--lanes`, `--claude`, `--permission-mode` and `--difftool` values that differ from the running board's are ignored with a warning; restart the board to change them.
- If something other than a ticket-viewer holds the port, the next free port is used.

## What it shows

- One lane per status, in the order given by `--lanes` (default `needs-triage,needs-info,ready-for-agent,ready-for-human,claimed,ready-for-review,resolved,wontfix`). Any other status found in a file gets its own lane; tickets without one go in "no status".
- Cards show number, title, the "What to build" line, acceptance-criteria progress (`- [ ]` / `- [x]`), type and comment count.
- A ticket is **blocked** while any ticket in its `Blocked by:` line isn't `resolved`, `done`, `closed` or `wontfix`.
- Click a card for the full rendered ticket, with links to its blockers and the tickets it blocks.
- The board reloads live when files change on disk. If the live connection drops, the top bar shows "● offline" until it's back.
- **Top bar**, after the pickers: a search box that matches a ticket's number (`#07` or `07`), title or body text; **Unblocked only**, which hides blocked tickets; **Empty lanes** (Show / Collapse / Hide); and live counts of agents running and tickets to review in the selected feature. Unblocked only and Empty lanes are remembered in `localStorage`.
- The design is dark only, in Geist and Geist Mono from Google Fonts.

## Background agents

The board can run Claude Code for you, as Claude Code background sessions (`claude --bg`). The project must be a git repository that you have trusted in Claude Code (run `claude` there once), and `claude` must be on your PATH.

1. **Start**: drag a `ready-for-agent` card to **claimed**, or press **▶ Start agent** in its detail panel. You can't start a blocked ticket. The board sets `Status: claimed`, creates the branch `ticket/<feature>/<NN-slug>` with a worktree in `<repo>/.claude/worktrees/`, and starts `/implement <ticket>` there as a background session. The worktree is inside the repo so it inherits the repo's trust, and it's git-ignored through `.git/info/exclude`. Your own checkout isn't touched, and several agents can run at once.
2. **Follow**: the board polls `claude agents --json` and shows the session's state on the card:
   - **● agent running**
   - **⚠ needs you**: the agent is waiting on a permission prompt. The panel shows the command it wants to run.
   - **💬 waiting for a reply**: the agent ended its turn without committing, so it probably asked you something.
   - **■ agent stopped**

   **Copy attach command** (also the ⧉ button on a claimed card) copies `claude attach <id>`. Run it in a terminal to watch the session, answer prompts, or reply. The session keeps running when you leave it (← or Ctrl+Z).
3. **Review**: when the agent ends its turn with new commits, the ticket moves to **ready-for-review**. There:
   - **Open diff in meld** runs `git difftool --dir-diff --tool=meld <review base>` in the worktree, so you see everything the ticket changed, including uncommitted work. The review base is `git merge-base <reference branch> HEAD` (see [Merge conflicts](#merge-conflicts)), so merging the reference branch into the ticket's branch doesn't fill the review with other tickets' work. The panel also lists the commits and a diff stat, and shows the agent's last message.
   - **Open structure diff** (only when [codemap](#structure-diff-codemap) is installed) opens codemap's review list of structural changes since the same review base.
   - **Approve** sets `resolved`, stops the session (its conversation is kept), stops its [worktree processes](#worktree-processes), and copies `git merge <branch> && git worktree remove <worktree> && git branch -d <branch>`. You do the merge, on the reference branch its title names. With a [merge conflict](#merge-conflicts) it still works, but the toast warns you.
   - **Send back to agent** adds your notes to the ticket's `## Comments` and resumes the agent's session with them, so it keeps its full context. The ticket goes back to claimed.

### Worktree processes

Agents start servers and watchers to test their work (`dotnet run`, `dotnet watch`, `npm run dev`, …), and these can still be running after the ticket reaches review. A **worktree process** is any running process whose working folder is inside a ticket's worktree, whoever started it, you or the agent. The agent's own Claude Code session (and anything in its process group, such as its MCP servers) is not one.

- On each poll the board finds them through `/proc/<pid>/cwd`, for every ticket with a worktree, whether or not its agent is running. For each it records the PID, process group, command line and listening TCP ports. Processes it can't read, such as other users', are skipped.
- A card with worktree processes shows **⚙ N processes**, in any lane. The Claude Code panel lists them with their command, ports and PID.
- **Kill** stops the process's whole process group, so `dotnet watch` takes its app down with it: SIGTERM first, then SIGKILL to anything still alive after 5 seconds. **Kill all** does that for every worktree process of the ticket. The board only kills processes that are worktree processes of that ticket at that moment.
- **Approve** and any move to **ready-for-agent** stop the ticket's worktree processes, and the toast says how many. Moving to ready-for-review doesn't, so you can click through the running app while you review. **Stop agent** stops only the session.
- The agent's prompt asks it to stop the servers and background processes it started before ending its turn; this catches the ones it forgets.

This works on Linux only. Without `/proc` (macOS, Windows) the board shows none of it and works as before.

### Merge conflicts

Several agents work in parallel, and once you merge one ticket another may no longer merge cleanly. The board tells you before you approve.

- **Reference branch**: when an agent starts, the board records the branch your main checkout is on as the ticket's reference branch, the branch its work will be merged into. Tickets started before the board recorded it use the branch checked out now. Always the local branch, never `origin/…`.
- On each poll, for every ticket in **claimed** or **ready-for-review** with a worktree, the board runs `git merge-tree --write-tree --name-only <reference branch> <ticket branch>` in the repo. It's a test merge that touches no worktree or index. The result is cached by the pair of commits, so it only re-runs when either branch moves. Resolved tickets aren't checked.
- A failing test merge is a **merge conflict**: the card shows **⚔ conflicts (N files)**, and the Claude Code panel lists the files and names the reference branch. Otherwise the panel says which branch the ticket merges into. After you merge one ticket, the others' indicators update on the next poll.
- **⚔ Resolve conflicts** hands the conflict to the agent. It shows on a ticket in **ready-for-review**, or a **claimed** one whose agent isn't working, while there is a merge conflict; it's hidden while the agent is running or waiting on you. It moves the ticket to claimed and resumes the agent's session with a fixed prompt: merge the reference branch into your branch (`git merge`, never rebase), resolve the conflicts in the listed files, run the tests, commit, and end your turn. Without a session to resume, it starts a new one in the same worktree with the same prompt, plus the ticket to read for context. Nothing is added to the ticket's `## Comments`. Once the agent ends its turn with the merge committed, the ticket goes back to ready-for-review and the next poll clears the indicator.
- **⇆ Resolve in meld** is the manual way, for small conflicts (a lock file, two imports). It shows under the same conditions as ⚔ Resolve conflicts, and the ticket stays in its lane.
  - It refuses to run while the worktree has uncommitted changes to tracked files; commit or stash them yourself. Untracked files don't count.
  - It runs `git merge --no-edit <reference branch>` in the worktree. A clean merge (the reference branch moved on since the last poll) is committed and that's it.
  - On conflicts it runs `git mergetool --tool=meld` in the worktree, without waiting for it, like Open diff in meld. `--difftool` picks the mergetool too. meld opens one conflicted file at a time; saving and closing it marks the file resolved. The board turns off mergetool's `.orig` backups.
  - Finish, Abort and a second meld are refused while meld is still open on the merge, and ⚔ Resolve conflicts is refused mid-merge.
  - While the worktree is mid-merge (`MERGE_HEAD` exists), the card shows **⚔ merge in progress (N unresolved)** instead of the conflict, and the panel offers **✓ Finish merge** (`git commit --no-edit`, refused while any file is still unmerged), **✕ Abort merge** (`git merge --abort`, which puts the branch back as it was) and **⇆ Reopen meld** (for files you closed without resolving). This shows in any lane, also for a merge you started yourself in a terminal. The buttons are hidden while the agent is running or waiting on you, since it may be the one merging.
  - A merge commit you make this way doesn't count as the agent's work: an agent that was waiting for a reply stays that way rather than moving the ticket to ready-for-review.
- With a detached HEAD at start, or when the reference branch no longer exists, the check is off and the panel says **no reference branch**; review diffs then start from the commit the ticket's branch was created from.

### Agent hostname

Several agents often test the same app at once, each from its own worktree on its own port. Browsers keep cookies per hostname, not per port, so `localhost:5001` and `localhost:5002` share one cookie store: when one agent logs in, the other's login breaks. Incognito doesn't help, since all incognito tabs share one store too.

So each ticket gets an **agent hostname**, `<feature>-<NN>.dev.localhost`, e.g. `agent-sandboxing-02.dev.localhost`. Chrome and Firefox send every `*.localhost` name to 127.0.0.1 without `/etc/hosts` changes, and keep separate cookies per name. The .NET dev certificate covers `*.dev.localhost`, so HTTPS works too.

- The name is one DNS label, because a wildcard certificate only matches one: lowercase letters, digits and hyphens, at most 63 characters. Accents are dropped, other characters (dots included) become hyphens, and a long feature name is cut short; `-<NN>` is always kept. The same ticket always gets the same name.
- The agent's prompt (on start and on every resume) tells it to keep the app's usual scheme and port but browse at its agent hostname instead of `localhost`. If the app rejects the name, it falls back to `localhost` without touching the app's host configuration, and says so in its final message.
- The Claude Code panel shows the agent hostname next to the branch; click it to copy. Each listening port of a [worktree process](#worktree-processes) gets an **↗ Open app :port** link to `<scheme>://<agent hostname>:<port>`. The board tries a TLS handshake once per port to pick `https` or `http`; until that's done the port shows without a link.

Limits:

- An app that sets `Domain=localhost` on its cookies shares them across all `*.localhost` names, so its logins still collide.
- An app with a strict host allowlist, such as ASP.NET's `AllowedHosts`, rejects the name (often with a 400) until you widen it for development, e.g. `"AllowedHosts": "*"` in `appsettings.Development.json`.

For interactive sessions you start yourself, paste this into the project's `CLAUDE.md`:

```md
When testing the app in a browser from a git worktree, open it at `<feature>-<NN>.dev.localhost` (from the ticket being worked on, e.g. `.scratch/agent-sandboxing/issues/02-x.md` gives `agent-sandboxing-02.dev.localhost`; lowercase, anything other than letters and digits becomes `-`, so no dots) with the app's usual scheme and port instead of `localhost`, so logins in parallel worktrees don't share cookies. If the app rejects that hostname, use `localhost` and don't change its host configuration.
```

### Structure diff (codemap)

When `codemap` is on your PATH at startup, a ticket in review also gets a structure diff; without it the board works exactly as before and shows none of this. The board only runs codemap's command line and imports none of its code.

- **Open structure diff** runs `codemap view --repo <worktree> --base <review base>`, which opens a browser page listing structural changes (new cycles, project references, coupling, injected concrete classes, surface changes, moves). Mark each item OK or Flag there, with a note. If codemap fails, the panel shows why.
- The **Structure diff** section of the review panel runs `codemap diff --repo <worktree> --base <review base> --json` and shows the count per group and your flagged items. It refreshes when you come back to the board's tab, or with ↻.
- **Copy flagged notes to Send back** adds the flagged items, in plain words with your notes, to the review notes. **Send back to agent** then works as usual.
- When an agent starts, the board runs `codemap snapshot --repo <worktree> --commit <base>` in the background, so the structure diff opens faster later. Its result is ignored.

**Stop agent** stops the session. **Continue agent** resumes it in the background and tells it to carry on. Sessions belong to Claude Code, not to the board: they keep running if you close the board, and the board picks them up again when it starts. The board's records are in `.git/ticket-viewer/agents.json`, one file per repo.

Sessions start in auto mode (`--permission-mode auto`): Claude Code's classifier approves routine actions, so the agent rarely stops to ask, and it still asks before risky ones. For more control, start the board with `--permission-mode acceptEdits`. Then only file edits are automatic, and anything not in your allowlist waits for you to attach and answer.

Options: `--claude <cmd>`, `--permission-mode <mode>`, `--difftool <tool>` (any tool name both `git difftool` and `git mergetool` know; it picks both).

## Status changes

The board changes a ticket's `Status:` line only for these moves:

- ready-for-agent → claimed (starts an agent)
- claimed → ready-for-review (the agent committed and ended its turn)
- claimed → ready-for-agent (only while no agent is working)
- ready-for-review → resolved, claimed (send back to the agent) or ready-for-agent
- ready-for-human → resolved (**Mark resolved**, once you've done the work)

Cards can only be dragged to those lanes. Every other change, such as triage decisions, goes through `/triage`, so the skill that owns the transition makes it. For example, `/triage` writes the agent brief when it moves a ticket to ready-for-agent. The board picks up file changes live.

## Copying commands

- The ⧉ button on a card (shows on hover) copies the next step: `/triage <path>` for tickets with no status, `needs-triage` or `needs-info`, and `/implement <path>` for `ready-for-agent`.
- The detail panel's **Commands ▾** menu has **Copy /implement**, **Copy /triage**, **Copy issue path** (the absolute path), **Copy worktree path** (when the ticket has a worktree), and under **Move via /triage** every status: picking one copies `/triage move <path> to <state>`, so the agent makes the move. Escape closes the menu, then the panel.
- Press `c` while a ticket is open to copy its next step (`/implement` when there is none).

Paths in these commands are relative to the project's repo root (the folder that contains `.scratch/`). Start the agent there.

The detail panel's header stays at the top while the panel scrolls. Under the title it shows the tickets this one is blocked by and blocks, then only the actions for the ticket's current state: Approve and Open diff in meld in review, Stop agent and Copy attach command while the agent runs, Continue agent and Back to ready-for-agent once it stopped, Start agent and Copy /implement in ready-for-agent, Copy /triage before that, Mark resolved in ready-for-human, and none once resolved. When the agent needs you, Copy attach command is the primary action. ⚔ Resolve conflicts and ⇆ Resolve in meld join them when they apply. A refused action is disabled, with the reason as its tooltip. The branch name in the Claude Code section copies the branch.

## Parsing rules

Metadata lines are read above the first `##` heading, as `Key: value` or `**Key:** value`. Recognised keys: `Status`, `Type`, `Blocked by`, `Owner`, `Assignee`, `Priority`, `Labels`. Status values are lower-cased and spaces become dashes.

## Tests

```sh
cd ~/tools/ticket-viewer && npm test
```

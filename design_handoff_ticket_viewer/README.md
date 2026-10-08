# Handoff: Ticket viewer UI cleanup

## Overview
This is a redesign of the local ticket viewer used to manage Claude Code agents per ticket. It has three layouts, and the user switches between them with a control at the top right of the top bar. The aims:
- show a lot of information at once, with less clutter
- larger text
- make **what the agent did** the main content of the detail panel

Layouts:
- **Board**: kanban lanes plus a right-hand detail drawer.
- **Strip**: compact lanes in a 280px strip at the top, with the detail panel filling the rest at full width.
- **List**: a grouped list on the left (400px), ordered by what needs attention, with the detail panel on the right.

`before/` holds screenshots of the current UI for comparison.

## About the design files
`Ticket Viewer.dc.html` is a **design reference built in HTML**. It's a working prototype that shows the intended look and behaviour, not production code to copy. Rebuild it in the existing ticket-viewer codebase (`public/app.js`, `public/style.css`, `public/index.html`) using its current patterns. The relevant functions are `renderDrawer()`, `renderAgent()`, `drawerLinks` and the keydown handler.

To view the prototype, open `Ticket Viewer.dc.html` in a browser, with `support.js` next to it. It works offline except for the Google Fonts.

The prototype's ticket data (#01–#10) and the simulated agent run on #08 are **sample data**. Wire everything to the real ticket and agent data.

## Fidelity
**High fidelity.** Colours, type, spacing and behaviour are final. Recreate them closely.

---

## Global structure
```
root: 100vh, flex column, background --bg
├─ Top bar: 54px, flex row, align center, gap 10px, padding 0 16px, bg --surface-1, border-bottom 1px --border
└─ Main: flex 1, min-height 0
     board → flex row:    [Board lanes (flex 1, scroll x)] [Detail drawer]
     strip → flex column: [Lane strip (280px)] [Detail panel (flex 1)]
     list  → flex row:    [Grouped list (400px)] [Detail panel (flex 1)]
```
Persist the layout choice in `localStorage` (e.g. `tv:layout`). Default: `board`.

## Top bar (left → right)
1. "Tickets": 15px / 600, letter-spacing -0.01em.
2. Project `<select>` and feature `<select>`:
   - 32px high, padding 0 8px, radius 6px, 13px
   - bg --surface-2, border 1px --border-strong
   - set `color-scheme: dark` on the root so native controls render dark
3. Search input:
   - placeholder "Filter by number, title, text"
   - flex 0 1 280px, min-width 150px, same box styling as the selects
   - matches number (a leading `#` is ignored), title or body text
   - **No `/` shortcut** (ticket #07).
4. "Unblocked only" toggle button, 32px.
   - Off: bg --surface-2, border --border-strong.
   - On: bg `oklch(0.3 0.05 255)`, border `oklch(0.6 0.12 255)`, text `oklch(0.92 0.04 255)`.
   - Hides tickets whose `blockedBy` ticket isn't resolved.
5. "Empty lanes" segmented control with Show / Collapse / Hide. Default: Collapse. Hidden in the List layout.
6. Spacer (flex 1).
7. Live counts, 13px, --text-2:
   - "● N running" with the pulsing cyan dot
   - "● N to review" with an orange dot
8. Layout segmented control with Board / Strip / List. Tooltips: "Board with detail drawer", "Lanes on top, detail below", "Grouped list with detail".

**Segmented control:**
- Container: padding 2px, radius 7px, bg --surface-2, border 1px `oklch(0.28 0.006 260)`.
- Buttons: 26–28px high, padding 0 9–11px, radius 5px, no border, 12.5–13px.
- Active button: bg `oklch(0.32 0.008 260)`, text `oklch(0.96 0.004 260)`.
- Inactive button: transparent, text `oklch(0.68 0.008 260)`.

## Statuses (order and colours)
| status | dot colour |
|---|---|
| needs-triage | oklch(0.7 0.015 260) |
| needs-info | oklch(0.8 0.13 80) |
| ready-for-agent | oklch(0.72 0.13 255) |
| ready-for-human | oklch(0.72 0.13 305) |
| claimed | oklch(0.76 0.11 205) |
| ready-for-review | oklch(0.74 0.14 50) |
| resolved | oklch(0.75 0.13 150) |
| wontfix | oklch(0.6 0.01 260) |

Status names are shown exactly as above (lowercase, kebab-case).

## Layout 1: Board
- **Container:** padding 16px, flex row, gap 12px, align stretch, scrolls horizontally.
- **Lane:**
  - flex 0 0 276px, column, gap 8px
  - Header (28px): 8px status dot, name (13px/600), count (Geist Mono 12px, muted), and a "Collapse" ghost button that appears only when the lane is empty and was expanded by hand.
  - The card list scrolls vertically inside the lane.
  - An empty lane in "show" mode shows a dashed box (1px dashed `oklch(0.28 0.006 260)`, radius 8px, padding 14px) reading "No tickets".
- **Collapsed empty lane:**
  - a 36px-wide full-height button: radius 8px, bg `oklch(0.18 0.005 260)`, border 1px `oklch(0.24 0.006 260)`
  - 7px dot, then the lane name in `writing-mode: vertical-rl` at 12.5px muted
  - Click expands it. Hover bg: `oklch(0.21 0.006 260)`.
- **Card:**
  - padding 11px 12px 10px, radius 8px, column, gap 7px
  - bg `oklch(0.215 0.006 260)`, border 1px `oklch(0.26 0.006 260)`; hover border `oklch(0.4 0.01 260)`
  - Selected: bg `oklch(0.26 0.035 255)`, border `oklch(0.66 0.13 255)`.
  - Resolved and wontfix cards: opacity 0.66.
  - Row 1 (12px, muted): `#07` in mono, then the type, then "blocked by #08" in amber `oklch(0.8 0.13 80)` if blocked.
  - Row 2: title, 14px / 500 / 1.35 line-height, `text-wrap: pretty`.
  - Row 3 (comfortable density only): one-line excerpt with ellipsis, 12.5px muted. Strip the markdown from it.
  - Row 4 (12px):
    - Agent state, shown **only on active tickets**:
      - running: "● Agent running" with the pulsing dot, text `oklch(0.8 0.1 205)`
      - done: "✓ Agent done", `oklch(0.78 0.13 150)`
      - stopped: "■ Agent stopped", `oklch(0.8 0.12 25)`
    - Comment count ("1 comment"), muted.
    - Spacer.
    - Criteria progress bar: 44×4px, radius 2px, track `oklch(0.3 0.006 260)`, fill `oklch(0.72 0.13 150)`.
    - "4/4" in mono, muted.
- **Detail drawer:** flex `0 0 max(520px, min(660px, 50vw))`, border-left 1px --border. It's only rendered when a ticket is selected.

## Layout 2: Strip
- **Lane strip:** flex 0 0 280px, padding 12px 16px, flex row, gap 10px, scrolls horizontally.
- **Lane:**
  - flex 1 1 0, min-width 200px, padding 8px, radius 9px, bg --surface-1, border 1px `oklch(0.24 0.006 260)`
  - Header: 12.5px/600, plus the count in 11.5px mono.
  - The card list scrolls vertically, gap 4px.
- **Collapsed empty lane:** same as Board, 34px wide.
- **Compact row card:**
  - padding 7px 9px, radius 6px, flex row, gap 8px, 13px
  - number (mono 12px, muted), title (one line, ellipsis), then the running dot or ✓ if relevant, then "n/m" (mono 11.5px)
  - The full title is in the tooltip.
  - Same selected and dim states as Board cards.
- **Detail panel:** flex 1, border-top 1px --border. It's wide enough for the two-column body (see below). With nothing selected it shows "Select a ticket", centred and muted.

## Layout 3: List
- **List column:** flex 0 0 400px, padding 12px 12px 24px, column, gap 10px, scrolls vertically.
- **Group order** (by attention): ready-for-review, needs-info, ready-for-human, claimed, ready-for-agent, needs-triage, resolved, wontfix. Empty groups are hidden.
- **Group panel:**
  - radius 9px, bg --surface-1, border 1px `oklch(0.24 0.006 260)`
  - **2px status-coloured top edge** (`box-shadow: inset 0 2px 0 <status colour>`)
  - overflow hidden
- **Group header button:**
  - full width, padding 11px 12px, 13px/600
  - ▾/▸ chevron (11px, muted, 12px wide), 8px dot, status name, count (mono 12px)
  - hover bg `oklch(0.205 0.006 260)`
  - Click toggles the group. resolved and wontfix start collapsed.
- **Rows:**
  - inside padding 0 6px 6px, gap 2px
  - each row is a grid `34px minmax(0,1fr) auto`, gap 4px 8px, padding 9px 10px, radius 7px
  - Cells: `#07` (mono 12px, muted), title (14px/500, wraps), then the agent mark plus "n/m" (mono 12px).
  - An optional second line spans columns 2–3 (12px, muted), e.g. "blocked by #08 · 2 comments".
  - Hover bg: `oklch(0.215 0.006 260)`.
  - Selected: bg `oklch(0.25 0.03 255)` with a 2px left bar (`box-shadow: inset 2px 0 0 oklch(0.7 0.14 255)`).
- **Detail panel:** flex 1, border-left 1px --border.

---

## Detail panel (shared by all layouts)
The panel scrolls vertically, bg `oklch(0.19 0.005 260)`.

### Sticky header
Position sticky at top 0, z-index 3, same bg, padding 18px 28px 16px, column, gap 10px, border-bottom 1px --border.

1. **Meta row:**
   - flex-wrap, gap 8px 10px, 13px muted. Every item is `white-space: nowrap; flex: none`.
   - `#07` in mono, --text-2.
   - Feature name.
   - **Status pill:** 24px high, padding 0 10px 0 8px, radius 999px, 1px border plus text in the status colour, a 7px dot, 12.5px/500.
   - **Type chip:** 24px high, padding 0 9px, radius 999px, bg `oklch(0.25 0.006 260)`, 12.5px.
   - Spacer.
   - **"Commands ▾" button** (30px) that opens a dropdown:
     - dropdown is 250px wide, radius 9px, bg `oklch(0.23 0.006 260)`, border `oklch(0.32 0.006 260)`, shadow `0 12px 32px rgb(0 0 0 / .45)`
     - Items: Copy /implement, Copy /triage, Copy issue path, Copy worktree path (only when there is a worktree).
     - Then a divider and "Move to" with all statuses, each with a dot. The current status gets bg `oklch(0.27 0.008 260)`.
     - Item hover: `oklch(0.28 0.008 260)`.
   - **× close** (30×30px). Escape also closes it: Escape closes the menu first, then the panel.
2. **Title:** 22px / 600 / 1.3, letter-spacing -0.01em, `text-wrap: pretty`.
3. **Primary actions:** 34px buttons, padding 0 14px, radius 7px, 13.5px/500. **Only the actions for the current state are shown:**

   | state | buttons |
   |---|---|
   | ready-for-review and agent done | **✓ Approve and merge** (green), Open diff in meld |
   | agent running | ■ Stop agent (red text), Copy attach command |
   | agent stopped | **↻ Continue agent** (primary), Back to ready-for-agent |
   | ready-for-agent | **▶ Start agent** (primary), Copy /implement |
   | needs-info / needs-triage | **Copy /triage** (primary) |
   | ready-for-human | **Mark resolved** (primary) |
   | resolved | no buttons, muted text "Merged into main" |

   Button styles:
   - default: bg `oklch(0.245 0.006 260)`, border `oklch(0.32 0.006 260)`, text --text
   - primary: bg and border `oklch(0.7 0.14 255)`, text `oklch(0.16 0.03 255)`
   - green: bg and border `oklch(0.75 0.13 150)`, text `oklch(0.17 0.03 150)`
   - stop: default style with text `oklch(0.8 0.13 25)` and border `oklch(0.36 0.05 25)`

### Body
Padding 24px 28px 48px. It's a **flex-wrap** row with gap 32px 44px, holding two sections:
- Agent: `flex: 1 1 440px`
- Ticket: `flex: 1 1 340px`

Both have min-width 0. In the narrow Board drawer they stack, with the agent section first. In Strip and List they sit side by side automatically. No breakpoints are needed.

#### Agent section (column, gap 18px)
**Heading row:**
- h3 at 16px/600. The text depends on state: "What the agent did" (done), "Agent is working" (running), "Agent stopped", or "Agent" (none).
- A state label in the state colour (✓ done, ● running, ■ stopped).
- Muted meta: "Finished 14:21 · ran 9m" or "for 12m 14s" (live).

**When done:**
1. **Summary paragraph:** 15px / 1.65, --text. Inline `code` and **bold** from the markdown are rendered.
   - Inline code style: Geist Mono 0.86em, padding 1px 5px, radius 4px, bg `oklch(0.26 0.008 260)`, text `oklch(0.88 0.04 250)`, `overflow-wrap: anywhere`.
2. **Report items:**
   - a grid of `112px minmax(0,1fr)`, gap 12px 16px, 14px / 1.6
   - padding 14px 0, top and bottom borders 1px --border
   - Labels on the left (muted, 500): Change, Docs, Tests, Browser check, and Review once sent back. Values on the right in `oklch(0.86 0.005 260)`.
   - Parse these from the agent's final message (the bold `**Label:**` bullet pattern).
3. **Changes block:** border 1px `oklch(0.28 0.006 260)`, radius 9px, bg `oklch(0.175 0.005 260)`.
   - Header:
     - "Changes" (13.5px/600)
     - "1 commit · 1 file" (muted)
     - "+0 −1" in mono: + in `oklch(0.76 0.13 150)`, − in `oklch(0.72 0.14 25)`
     - spacer, then buttons "Open diff in meld" and "Structure diff" (28px, 12.5px)
   - Commit rows: padding 9px 14px. The sha in mono `oklch(0.78 0.11 255)`, then the message wrapping at 13px.
   - File rows: mono 12.5px. The path (ellipsis), +a, −d, and a 50×6px bar split green/red relative to the largest file.
   - Warning row (e.g. the structure diff failed):
     - one line, 12.5px, text `oklch(0.8 0.11 70)`, bg `oklch(0.2 0.02 70 / .35)`, plus a "Retry" button
     - This replaces the large red error block.
4. **Send back with notes** (only for ready-for-review):
   - label 13.5px/600
   - textarea: 3 rows, radius 8px, bg `oklch(0.17 0.005 260)`, border --border-strong, 14px/1.5, placeholder "Notes go to the agent's session and are added to the ticket's ## Comments"
   - "↩ Send back to agent" button plus the muted hint "The agent resumes on the same branch."
   - Sending with empty notes shows the toast "Add review notes first".
5. **"▸ Agent activity · N steps"**: a collapsed toggle that opens the activity feed.

**When running or stopped:** the activity feed is open and shown first.
- Feed box: border 1px, radius 9px, bg `oklch(0.17 0.005 260)`, padding 6px 0.
- Each row is a grid `52px 16px 1fr`, padding 5px 14px:
  - time (mono 12px, `oklch(0.55 0.008 260)`)
  - marker (the pulsing dot on the latest row while running)
  - text (mono 12.5px)
- The latest row's text is --text; earlier rows are `oklch(0.76 0.006 260)`.
- New entries are appended live. Keep the scroll position.

**When there's no agent:**
- A dashed box (1px dashed `oklch(0.3 0.006 260)`, radius 9px, padding 22px) with an explanation and one action.
  - ready-for-agent: "No agent has worked on this ticket yet." with ▶ Start agent.
  - Otherwise: the "needs triage" text with Copy /triage.
- If blocked: "Blocked by #08. You can still start an agent, but it may conflict with #08's changes."

**Workspace** (when a branch exists):
- Heading "Workspace · click to copy".
- A grid `96px 1fr` with border 1px, radius 9px, and rows separated by 1px lines.
- Rows: Branch, Preview (dev host), Worktree, Merges into.
- Values are mono 12.5px with ellipsis, `cursor: copy`, hover bg `oklch(0.22 0.006 260)`. Click copies the value and shows the toast "Copied branch" etc.

This table replaces the scattered path and copy chips under the title.

#### Ticket section (column, gap 20px)
- Heading row: h3 "Ticket", then a "Copy issue path" ghost button (26px, 12px).
- Blocked note if applicable: 13.5px, amber.
- Subsections:
  - each label is 13px/600 muted: "What to build", "Cause", "Fix", "Acceptance criteria", "Out of scope"
  - body text is 14.5px / 1.65 (Cause and Fix in `oklch(0.86 0.005 260)`)
  - inline code is rendered the same way as in the summary
- **Acceptance criteria:**
  - The header row has a mini progress bar (max 80×4px) and "3/4" in mono.
  - Each item is a clickable row: padding 6px 8px, radius 6px, hover bg `oklch(0.215 0.006 260)`.
  - Checkbox is 17px, radius 4px, 1.5px border:
    - unchecked: border `oklch(0.45 0.008 260)`
    - checked: fill and border `oklch(0.75 0.13 150)` with a dark ✓
  - Checked text dims to `oklch(0.8 0.006 260)`.
  - Clicking toggles the item and writes it back to the issue file.
- **Out of scope:** items are prefixed with an en dash, 14px, --text-2-ish `oklch(0.78 0.006 260)`.

### Toast
- Fixed **bottom-left** at 16px, so it no longer covers the drawer.
- Padding 10px 14px, radius 8px, bg `oklch(0.28 0.008 260)`, border `oklch(0.36 0.008 260)`, shadow `0 10px 30px rgb(0 0 0 / .4)`, 13.5px.
- Auto-hides after 2.4s.

### Pulsing running dot
- 8px circle, `oklch(0.78 0.12 205)`, ring `0 0 0 3px oklch(0.78 0.12 205 / .18)`.
- Animation: `tvpulse 1.4s ease-in-out infinite`, where `0%,100% {opacity:1; scale 1}` and `50% {opacity:.4; scale .75}`.

## Interactions and state
- **Selection:** click a card or row to select it. Selecting closes the menu, clears the notes and collapses the activity feed.
- **State to persist:** layout (`localStorage`), empty-lane mode, lanes expanded by hand, collapsed list groups, search query, unblocked toggle, selected ticket.
- **Approve:** status → resolved, then the merge. Toast "#07 approved · merging into main".
- **Send back:** status → claimed, agent → running on the same session. The notes are appended to the ticket's `## Comments` and added as a Review item in the report.
- **Stop / Continue / Back to ready-for-agent:** these map to the existing agent controls.
- **Start agent:** status → claimed, agent running.
- **When the agent finishes:** status → ready-for-review. Toast "#08 is ready for review".
- **Live updates must not reset** scroll position, open sections or textarea contents (ticket #01).
- **Keyboard:** Escape closes the menu, then the panel. There is **no** `/` shortcut.

## Design tokens
**Colours:**
- --bg `oklch(0.165 0.005 260)`
- --surface-1 `oklch(0.185 0.005 260)` (top bar, lanes, groups)
- --panel `oklch(0.19 0.005 260)` (detail)
- --surface-2 `oklch(0.21 0.006 260)` (inputs)
- --card `oklch(0.215 0.006 260)`
- --border `oklch(0.26 0.006 260)`
- --border-strong `oklch(0.3 0.006 260)`
- --text `oklch(0.93 0.004 260)`
- --text-2 `oklch(0.8 0.006 260)`
- --muted `oklch(0.65 0.008 260)`
- --accent `oklch(0.7 0.14 255)`
- Status colours are in the table above.

**Type:** Geist (400/500/600) for UI and Geist Mono (400/500) for numbers, paths, shas and logs, both from Google Fonts. Sizes:
- base 14
- small 12–13
- body copy 14.5–15
- h3 16
- title 22

**Radius:** 4 (code, checkboxes), 5–7 (buttons), 8–9 (cards, panels), 999 (pills).

**Spacing:** 2 / 4 / 6 / 8 / 10 / 12 / 14 / 16 / 18 / 20 / 24 / 28 / 32 / 44.

## Assets
None. The only glyphs are text characters (✓ ■ ▶ ↻ ↩ ▾ ▸ ×).

## Files
- `Ticket Viewer.dc.html`: the interactive prototype with all three layouts (Board / Strip / List switcher top-right). Open it in a browser with `support.js` alongside.
- `support.js`: the runtime the prototype needs. Not part of the implementation.
- `before/`: screenshots of the current UI.

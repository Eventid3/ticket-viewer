import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTicket, parseSections, setStatus, appendComment, loadFeature, resolveFeatures, isFeatureCompleted } from '../lib/tickets.mjs';

const BOLD = `# 06: Build green on Umbraco 17

**What to build:** The whole solution builds.

**Blocked by:** 02, 03

**Status:** ready-for-agent

- [x] One
- [ ] Two

## Comments

- **2026-09-01:** looks good
`;

test('parses bold metadata, title, blockers and checkboxes', () => {
  const t = parseTicket(BOLD, '06-build-green.md');
  assert.equal(t.number, '06');
  assert.equal(t.title, 'Build green on Umbraco 17');
  assert.equal(t.status, 'ready-for-agent');
  assert.deepEqual(t.blockedBy, ['02', '03']);
  assert.equal(t.summary, 'The whole solution builds.');
  assert.deepEqual(t.checks, { done: 1, total: 2 });
  assert.equal(t.comments, 1);
});

test('parses plain metadata lines and "None" blockers', () => {
  const t = parseTicket('# Q\n\nType: research\nStatus: Claimed\nBlocked by: None (can start)\n\nWhy?\n', '01-q.md');
  assert.equal(t.status, 'claimed');
  assert.equal(t.type, 'research');
  assert.deepEqual(t.blockedBy, []);
  assert.equal(t.summary, 'Why?');
});

test('ignores Status lines inside sections below the header', () => {
  const t = parseTicket('# Q\n\n## Answer\n\nStatus: resolved\n', '01-q.md');
  assert.equal(t.status, null);
});

test('setStatus keeps the existing line format', () => {
  assert.match(setStatus(BOLD, 'claimed'), /^\*\*Status:\*\* claimed$/m);
  assert.equal(setStatus('# Q\nStatus: needs-triage\n', 'resolved'), '# Q\nStatus: resolved\n');
  assert.equal(setStatus('# Q\r\nStatus: a\r\n', 'b'), '# Q\r\nStatus: b\r\n');
});

test('setStatus inserts a status line when missing', () => {
  assert.equal(setStatus('# Q\n\nBody\n', 'needs-triage'), '# Q\n\nStatus: needs-triage\n\nBody\n');
});

test('appendComment adds to an existing Comments section', () => {
  const out = appendComment(BOLD, 'please add a test', '2026-09-29');
  assert.match(out, /- \*\*2026-09-01:\*\* looks good\n- \*\*2026-09-29 \(review\):\*\* please add a test\n$/);
});

test('appendComment creates a Comments section when missing', () => {
  assert.equal(appendComment('# Q\n\nBody\n', 'a\nb', '2026-09-29'), '# Q\n\nBody\n\n## Comments\n\n- **2026-09-29 (review):** a b\n');
});

test('loadFeature marks tickets blocked until blockers are done', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-'));
  const issues = path.join(root, '.scratch', 'feat', 'issues');
  fs.mkdirSync(issues, { recursive: true });
  fs.writeFileSync(path.join(issues, '01-a.md'), '# A\n\nStatus: resolved\n');
  fs.writeFileSync(path.join(issues, '02-b.md'), '# B\n\nStatus: ready-for-agent\n');
  fs.writeFileSync(path.join(issues, '03-c.md'), '# C\n\nBlocked by: 01\nStatus: ready-for-agent\n');
  fs.writeFileSync(path.join(issues, '04-d.md'), '# D\n\nBlocked by: 01, 02\nStatus: ready-for-agent\n');

  const { features } = resolveFeatures(root);
  assert.deepEqual(features.map(f => f.name), ['feat']);
  const byNum = Object.fromEntries(loadFeature(features[0]).map(t => [t.number, t]));
  assert.equal(byNum['03'].blocked, false);
  assert.equal(byNum['04'].blocked, true);
  assert.deepEqual(byNum['04'].openBlockers, ['02']);
  assert.deepEqual(byNum['01'].blocks, ['03', '04']);
  assert.equal(byNum['01'].path, '.scratch/feat/issues/01-a.md');
  assert.equal(byNum['01'].absPath, path.join(issues, '01-a.md'));

  // A feature folder can be passed directly, too.
  const single = resolveFeatures(path.join(root, '.scratch', 'feat')).features;
  assert.equal(single.length, 1);
  assert.equal(loadFeature(single[0])[0].path, '.scratch/feat/issues/01-a.md');
  fs.rmSync(root, { recursive: true });
});

test('a feature is completed when it has tickets and every one is in the done set', () => {
  const t = status => ({ status });
  assert.equal(isFeatureCompleted([t('resolved'), t('wontfix'), t('done'), t('closed')]), true);
  assert.equal(isFeatureCompleted([t('resolved'), t('ready-for-agent')]), false);
  assert.equal(isFeatureCompleted([]), false, 'a feature with no tickets is not completed');
});

// ---- parseSections: the Ticket section's labelled subsections ------------------------------------------

const LABELS = `# 04: Two-column body

**Status:** claimed

**Type:** enhancement

**Blocked by:** 03

**What to build:** Lay out the body as two sections.

**Body layout.** Padding 24px, a \`flex-wrap\` row.

- Heading row: h3 "Ticket"

- [ ] The drawer stacks
- [x] Tests cover the parsing
  for both styles

## Out of scope

- Ticking criteria (05)
- The Agent section

## Comments

- **2026-09-01:** looks good
**Fix:** later
`;

const HEADINGS = `# 09: Toast covers the drawer

Status: ready-for-agent
Type: bug

## What to build

Toasts sit on top of the drawer.

## Cause

\`.toast\` is fixed bottom right.

## Fix

Move it bottom left.

## Acceptance criteria

- [x] Toasts never cover drawer controls
- [ ] Toasts stay readable

## Out of scope

- Restyling toasts

## Notes

Anything else.
`;

const BRIEF = `# 02: Hostnames

**Status:** resolved

**What to build:** Give each ticket a hostname.

## Agent Brief

**Category:** enhancement
**Summary:** Per-ticket hostnames.

**Acceptance criteria:**
- [x] Stable hostname
- [ ] Reviewer checks

**Out of scope:**
- Assigning ports

**Key interfaces:**
- \`names()\`
`;

const byKey = sections => Object.fromEntries(sections.map(s => [s.key ?? s.label, s]));

test('sections from **Label:** paragraphs: what to build keeps its paragraphs, a bare checklist is the criteria', () => {
  const s = parseSections(LABELS);
  assert.deepEqual(s.map(x => x.key ?? x.label), ['what', 'criteria', 'outOfScope', 'Comments']);
  const k = byKey(s);
  assert.equal(k.what.label, 'What to build');
  assert.equal(k.what.body, 'Lay out the body as two sections.\n\n**Body layout.** Padding 24px, a `flex-wrap` row.\n\n- Heading row: h3 "Ticket"');
  assert.deepEqual(k.criteria.items, [
    { text: 'The drawer stacks', done: false, line: 14 },
    { text: 'Tests cover the parsing for both styles', done: true, line: 15 },
  ]);
  assert.equal(k.criteria.label, 'Acceptance criteria');
  assert.deepEqual(k.outOfScope.items, ['Ticking criteria (05)', 'The Agent section']);
  assert.equal(k.outOfScope.body, '');
  assert.equal(k.Comments.key, null);
  assert.equal(k.Comments.body, '- **2026-09-01:** looks good\n**Fix:** later', 'labels inside comments stay in the comments');
});

test('sections from ## headings, in the known order, then the others', () => {
  const s = parseSections(HEADINGS);
  assert.deepEqual(s.map(x => x.key ?? x.label), ['what', 'cause', 'fix', 'criteria', 'outOfScope', 'Notes']);
  const k = byKey(s);
  assert.equal(k.what.body, 'Toasts sit on top of the drawer.');
  assert.equal(k.cause.label, 'Cause');
  assert.equal(k.cause.body, '`.toast` is fixed bottom right.');
  assert.equal(k.fix.body, 'Move it bottom left.');
  assert.deepEqual(k.criteria.items.map(i => [i.text, i.done]), [['Toasts never cover drawer controls', true], ['Toasts stay readable', false]]);
  assert.deepEqual(k.outOfScope.items, ['Restyling toasts']);
  assert.equal(k.Notes.body, 'Anything else.');
});

test('known **Label:** paragraphs inside another section are lifted out; the rest of that section stays', () => {
  const s = parseSections(BRIEF);
  assert.deepEqual(s.map(x => x.key ?? x.label), ['what', 'criteria', 'outOfScope', 'Agent Brief']);
  const k = byKey(s);
  assert.deepEqual(k.criteria.items.map(i => [i.text, i.done, i.line]), [['Stable hostname', true, 12], ['Reviewer checks', false, 13]]);
  assert.deepEqual(k.outOfScope.items, ['Assigning ports']);
  assert.equal(k['Agent Brief'].body, '**Category:** enhancement\n**Summary:** Per-ticket hostnames.\n\n**Key interfaces:**\n- `names()`');
});

test('text above the first section is kept as an unlabelled intro; title and metadata are left out', () => {
  const s = parseSections('# Q\n\nType: research\nStatus: claimed\nBlocked by: None\n\nWhy is it slow?\n\n- [ ] Find out\n');
  assert.deepEqual(s.map(x => x.key), ['intro', 'criteria']);
  assert.equal(s[0].label, null);
  assert.equal(s[0].body, 'Why is it slow?');
  assert.deepEqual(s[1].items.map(i => i.text), ['Find out']);
});

test('text after a bare checklist goes back where it was, and other text in known sections is kept', () => {
  const md = '# Q\n\n**What to build:** A.\n\n- [ ] One\n\nMore about A.\n\n## Acceptance criteria\n\nAll of:\n\n- [x] Two\n\n## Out of scope\n\nNone\n';
  const k = byKey(parseSections(md));
  assert.equal(k.what.body, 'A.\n\nMore about A.');
  assert.deepEqual(k.criteria.items.map(i => i.text), ['One', 'Two']);
  assert.equal(k.criteria.body, 'All of:');
  assert.deepEqual(k.outOfScope.items, []);
  assert.equal(k.outOfScope.body, 'None');
});

test('headings and labels inside fenced code are text', () => {
  const md = '# Q\n\n## Notes\n\n```\n## Fix\n**Cause:** x\n- [ ] not a criterion\n```\n';
  const s = parseSections(md);
  assert.deepEqual(s.map(x => x.key ?? x.label), ['Notes']);
  assert.equal(s[0].body, '```\n## Fix\n**Cause:** x\n- [ ] not a criterion\n```');
});

test('headings match without case or a trailing colon, and a label can carry its text on the same line', () => {
  const k = byKey(parseSections('# Q\n\n## acceptance Criteria:\n\n- [ ] A\n\n**Out of scope:** Everything else\n**Cause**: unknown\n'));
  assert.deepEqual(k.criteria.items.map(i => i.text), ['A']);
  assert.equal(k.outOfScope.body, 'Everything else');
  assert.equal(k.cause.body, 'unknown');
});

test('parseTicket sends the sections along', () => {
  assert.deepEqual(parseTicket(HEADINGS, '09-toast.md').sections, parseSections(HEADINGS));
});

test('no ticket text is lost', () => {
  for (const md of [LABELS, HEADINGS, BRIEF]) {
    const kept = parseSections(md).flatMap(s => [s.label, s.body, ...(s.items || []).map(i => i.text ?? i)]).join('\n');
    const words = md.replace(/^# .*$/m, '').replace(/^\W*(Status|Type|Blocked by)\W.*$/gim, '')
      .replace(/^#+ |\*\*|- \[[ x]\]|^- /gm, '').split(/\s+/).filter(Boolean);
    for (const w of words) assert.ok(kept.includes(w.replace(/:$/, '')), `"${w}" is shown`);
  }
});

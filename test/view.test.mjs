import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../public/view.js';

const { matchesQuery, readPrefs, liveCounts, laneView, plainText } = globalThis.TicketView;

const ticket = { number: '07', title: 'Remove the slash shortcut', body: 'The / key jumps to the search box.', type: 'bug', status: 'claimed' };

test('search matches the number with or without a leading #', () => {
  assert.ok(matchesQuery(ticket, '#07'));
  assert.ok(matchesQuery(ticket, '07'));
  assert.ok(matchesQuery(ticket, ' #07 '));
  assert.ok(!matchesQuery(ticket, '#08'));
});

test('search matches title and body words, ignoring case', () => {
  assert.ok(matchesQuery(ticket, 'slash'));
  assert.ok(matchesQuery(ticket, 'SEARCH BOX'));
  assert.ok(!matchesQuery(ticket, 'claimed'), 'the status is not searched');
});

test('an empty query matches everything, including tickets without a number', () => {
  assert.ok(matchesQuery({ number: null, title: 'x', body: '' }, ''));
  assert.ok(matchesQuery({ number: null, title: 'x', body: '' }, '#'));
  assert.ok(!matchesQuery({ number: null, title: 'x', body: '' }, '07'));
});

test('prefs default to collapsed empty lanes', () => {
  assert.deepEqual(readPrefs({}), { emptyLanes: 'collapse', unblockedOnly: false, lastProject: null, expandedLanes: [] });
});

test('prefs keep a valid empty-lanes mode and the other settings', () => {
  assert.deepEqual(readPrefs({ emptyLanes: 'show', unblockedOnly: true, lastProject: 'p1' }), { emptyLanes: 'show', unblockedOnly: true, lastProject: 'p1', expandedLanes: [] });
  assert.equal(readPrefs({ emptyLanes: 'sideways' }).emptyLanes, 'collapse');
});

test('an old hideEmpty: true pref becomes Hide, and false the default', () => {
  assert.equal(readPrefs({ hideEmpty: true }).emptyLanes, 'hide');
  assert.equal(readPrefs({ hideEmpty: false }).emptyLanes, 'collapse');
  assert.equal(readPrefs({ hideEmpty: true, emptyLanes: 'show' }).emptyLanes, 'show', 'a saved mode wins over the old flag');
});

test('live counts: running includes starting agents, to review counts ready-for-review tickets', () => {
  const tickets = [
    { id: 'a', status: 'claimed' }, { id: 'b', status: 'claimed' }, { id: 'c', status: 'ready-for-review' },
    { id: 'd', status: 'ready-for-review' }, { id: 'e', status: 'ready-for-agent' },
  ];
  const agents = { a: { state: 'running' }, b: { state: 'starting' }, c: { state: 'done' }, e: { state: 'stopped' } };
  assert.deepEqual(liveCounts(tickets, agents), { running: 2, review: 2 });
  assert.deepEqual(liveCounts(tickets, undefined), { running: 0, review: 2 });
  assert.deepEqual(liveCounts(tickets, null), { running: 0, review: 2 });
});

test('prefs keep the lanes expanded by hand, as strings only', () => {
  assert.deepEqual(readPrefs({}).expandedLanes, []);
  assert.deepEqual(readPrefs({ expandedLanes: ['claimed', '', 3, 'resolved'] }).expandedLanes, ['claimed', '', 'resolved']);
  assert.deepEqual(readPrefs({ expandedLanes: 'claimed' }).expandedLanes, []);
});

test('a lane with cards is always a full lane', () => {
  for (const mode of ['show', 'collapse', 'hide']) assert.equal(laneView(2, mode, false), 'full');
  assert.equal(laneView(2, 'collapse', true), 'full', 'expanding a lane that has cards changes nothing');
});

test('an empty lane: Show shows it, Hide hides it, Collapse collapses it until it is expanded by hand', () => {
  assert.equal(laneView(0, 'show', false), 'full');
  assert.equal(laneView(0, 'hide', false), 'hidden');
  assert.equal(laneView(0, 'hide', true), 'hidden');
  assert.equal(laneView(0, 'collapse', false), 'collapsed');
  assert.equal(laneView(0, 'collapse', true), 'expanded');
});

test('the excerpt strips inline markdown', () => {
  assert.equal(plainText('Restyle the board (`renderLane()` in **`public/app.js`**) to _the_ *handoff*.'),
    'Restyle the board (renderLane() in public/app.js) to the handoff.');
  assert.equal(plainText('See [the README](docs/README.md) and ~~old~~ <b>new</b> notes'), 'See the README and old new notes');
  assert.equal(plainText('snake_case_name and 2 * 3'), 'snake_case_name and 2 * 3', 'lone underscores and stars are kept');
  assert.equal(plainText(''), '');
  assert.equal(plainText(null), '');
});

test('the excerpt keeps code spans and angle brackets as written', () => {
  assert.equal(plainText('Use `<div>` and `a*b*c` here'), 'Use <div> and a*b*c here');
  assert.equal(plainText('A Vec<String> type, a < b and c > d'), 'A Vec<String> type, a < b and c > d');
  assert.equal(plainText('[a](b(c)) tail'), 'a tail');
  assert.equal(plainText('\\*not em\\* and **bold**'), '*not em* and bold');
});

test('the excerpt drops heading, list and quote markers', () => {
  assert.equal(plainText('## Heading'), 'Heading');
  assert.equal(plainText('- an item'), 'an item');
  assert.equal(plainText('12. an item'), 'an item');
  assert.equal(plainText('> quoted'), 'quoted');
});

// ---- detail header actions ------------------------------------------------------------
const { headerActions } = globalThis.TicketView;
const ok = { ok: true, why: null };
const names = r => r.buttons.map(b => `${b.name}:${b.style || 'default'}`);
const tk = (status, actions = {}, extra = {}) => ({ status, needsYou: false, actions: { moves: {}, ...actions }, ...extra });

test('ready-for-review with an agent: Approve (green) and Open diff in meld, nothing else', () => {
  const t = tk('ready-for-review', { stop: ok, moves: { resolved: ok, claimed: ok, 'ready-for-agent': ok } });
  assert.deepEqual(names(headerActions(t, { state: 'idle', bgId: 'b' })), ['approve:green', 'diff:default']);
});

test('a running agent: Stop agent (stop) and Copy attach command', () => {
  for (const state of ['running', 'starting']) {
    const t = tk('claimed', { stop: ok, moves: { 'ready-for-agent': { ok: false, why: 'Stop the agent first' } } });
    assert.deepEqual(names(headerActions(t, { state, bgId: 'b' })), ['stop:stop', 'attach:default']);
  }
});

test('a stopped or failed agent: Continue agent (primary) and Back to ready-for-agent', () => {
  for (const state of ['stopped', 'failed', 'done']) {
    const t = tk('claimed', { start: { ...ok, resume: true }, moves: { 'ready-for-agent': ok } });
    assert.deepEqual(names(headerActions(t, { state, bgId: 'b' })), ['continue:primary', 'back:default']);
  }
});

test('claimed without an agent only offers going back', () => {
  assert.deepEqual(names(headerActions(tk('claimed', { moves: { 'ready-for-agent': ok } }), null)), ['back:default']);
});

test('ready-for-agent: Start agent (primary) and Copy /implement', () => {
  assert.deepEqual(names(headerActions(tk('ready-for-agent', { start: ok, moves: { claimed: ok } }), null)), ['start:primary', 'implement:default']);
});

test('needs-info, needs-triage and no status: Copy /triage (primary)', () => {
  for (const status of ['needs-info', 'needs-triage', null]) assert.deepEqual(names(headerActions(tk(status), null)), ['triage:primary']);
});

test('ready-for-human: Mark resolved (primary)', () => {
  assert.deepEqual(names(headerActions(tk('ready-for-human', { moves: { resolved: ok } }), null)), ['markResolved:primary']);
});

test('resolved: no buttons, a muted Resolved note', () => {
  const r = headerActions(tk('resolved'), { state: 'stopped', bgId: 'b' });
  assert.deepEqual(r, { buttons: [], note: 'Resolved' });
  assert.equal(headerActions(tk('needs-info'), null).note, null);
});

test('an agent that needs you: Copy attach command is primary', () => {
  const waiting = tk('claimed', { stop: ok, moves: { 'ready-for-agent': { ok: false, why: 'Stop the agent first' } } }, { needsYou: true });
  assert.deepEqual(names(headerActions(waiting, { state: 'waiting', bgId: 'b' })), ['attach:primary', 'stop:stop']);
  const idle = tk('claimed', { stop: ok, start: { ...ok, resume: true }, moves: { 'ready-for-agent': ok } }, { needsYou: true });
  assert.deepEqual(names(headerActions(idle, { state: 'idle', bgId: 'b' })), ['attach:primary', 'continue:default', 'stop:stop']);
});

test('conflict actions follow the state buttons whenever the server shows them', () => {
  const t = tk('ready-for-review', { resolveConflicts: ok, mergeByHand: { ok: false, why: 'stop it first' }, moves: { resolved: ok } });
  assert.deepEqual(names(headerActions(t, { state: 'done', bgId: 'b' })), ['approve:green', 'diff:default', 'resolveConflicts:primary', 'mergeByHand:default']);
  const running = tk('claimed', { stop: ok, mergeByHand: { ok: false, why: 'stop it first' }, moves: {} });
  assert.deepEqual(names(headerActions(running, { state: 'running', bgId: 'b' })), ['stop:stop', 'attach:default', 'mergeByHand:default']);
});

test('buttons for actions the server leaves out are not shown', () => {
  assert.deepEqual(names(headerActions(tk('ready-for-agent', { moves: {} }), null)), ['implement:default']);
  assert.deepEqual(names(headerActions(tk('ready-for-human', { moves: {} }), null)), []);
  assert.deepEqual(names(headerActions(tk('claimed', { moves: {} }), { state: 'running' })), [], 'no attach without a session');
});

test('an agent that needs you outside claimed: Copy attach command leads as the only primary', () => {
  const t = tk('ready-for-human', { stop: ok, moves: { resolved: ok } }, { needsYou: true });
  assert.deepEqual(names(headerActions(t, { state: 'idle', bgId: 'b' })), ['attach:primary', 'markResolved:default']);
});

const { splitReport } = globalThis.TicketView;

test('a final message splits into the prose before its bullets and one report item per **Label:** bullet', () => {
  const md = [
    'Added the `--port` flag and **documented** it.',
    '',
    'It falls back to the next free port.',
    '',
    '- **Change:** `cli.mjs` parses `--port`.',
    '- **Docs:** README updated.',
    '* **Browser check**: opened the board.',
  ].join('\n');
  assert.deepEqual(splitReport(md), {
    summary: 'Added the `--port` flag and **documented** it.\n\nIt falls back to the next free port.',
    items: [
      { label: 'Change', text: '`cli.mjs` parses `--port`.' },
      { label: 'Docs', text: 'README updated.' },
      { label: 'Browser check', text: 'opened the board.' },
    ],
    rest: '',
  });
});

test('report labels are whatever the agent wrote, and indented lines belong to their item', () => {
  const { items } = splitReport('Done.\n\n- **Tests:** 12 pass,\n  1 skipped\n- **Risky bit:** none\n    - really none');
  assert.deepEqual(items, [
    { label: 'Tests', text: '12 pass,\n1 skipped' },
    { label: 'Risky bit', text: 'none\n  - really none' },
  ]);
});

test('a message without **Label:** bullets has no report items and is the summary whole', () => {
  const md = 'Which port should it use?\n\n- 4777\n- 5000';
  assert.deepEqual(splitReport(md), { summary: md, items: [], rest: '' });
  assert.deepEqual(splitReport(''), { summary: '', items: [], rest: '' });
  assert.deepEqual(splitReport(null), { summary: '', items: [], rest: '' });
});

test('text after the report and plain bullets among it are kept as the rest', () => {
  const md = 'Summary.\n\n- **Change:** x\n- a plain bullet\n\nAsk me if anything is unclear.';
  assert.deepEqual(splitReport(md), {
    summary: 'Summary.',
    items: [{ label: 'Change', text: 'x' }],
    rest: '- a plain bullet\n\nAsk me if anything is unclear.',
  });
});

test('bullets inside a code fence are not report items', () => {
  const md = 'See:\n\n```\n- **Change:** not a bullet\n```';
  assert.deepEqual(splitReport(md).items, []);
  assert.equal(splitReport(md).summary, md);
});

const { agentHeading, noAgentBox } = globalThis.TicketView;

test('the Agent section heading follows the agent state; needs you and waiting for a reply have their own', () => {
  assert.equal(agentHeading(null), 'Agent');
  assert.equal(agentHeading({ state: 'done' }), 'What the agent did');
  assert.equal(agentHeading({ state: 'running' }), 'Agent is working');
  assert.equal(agentHeading({ state: 'starting' }), 'Agent is working');
  assert.equal(agentHeading({ state: 'stopped' }), 'Agent stopped');
  assert.equal(agentHeading({ state: 'failed' }), 'Agent stopped');
  assert.equal(agentHeading({ state: 'waiting' }), 'Agent needs you');
  assert.equal(agentHeading({ state: 'idle' }), 'Agent is waiting for a reply');
});

test('no agent: ready-for-agent offers Start agent, triage statuses offer Copy /triage, others show nothing', () => {
  const t = (status, openBlockers = []) => ({ status, openBlockers });
  assert.deepEqual(noAgentBox(t('ready-for-agent')), { text: 'No agent has worked on this ticket yet.', action: 'start', blocked: null });
  for (const s of ['needs-triage', 'needs-info', null]) {
    const box = noAgentBox(t(s));
    assert.equal(box.action, 'triage', String(s));
    assert.match(box.text, /needs triage/);
  }
  for (const s of ['ready-for-human', 'resolved', 'wontfix', 'claimed', 'ready-for-review']) assert.equal(noAgentBox(t(s)), null, s);
});

test('no agent on a blocked ticket warns that an agent may conflict with the blockers', () => {
  assert.equal(noAgentBox({ status: 'ready-for-agent', openBlockers: ['08'] }).blocked,
    "Blocked by #08. You can still start an agent, but it may conflict with #08's changes.");
  assert.equal(noAgentBox({ status: 'needs-triage', openBlockers: ['08', '09'] }).blocked,
    "Blocked by #08, #09. You can still start an agent, but it may conflict with their changes.");
});

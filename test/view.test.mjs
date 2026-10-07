import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../public/view.js';

const { matchesQuery, readPrefs, liveCounts } = globalThis.TicketView;

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
  assert.deepEqual(readPrefs({}), { emptyLanes: 'collapse', unblockedOnly: false, lastProject: null });
});

test('prefs keep a valid empty-lanes mode and the other settings', () => {
  assert.deepEqual(readPrefs({ emptyLanes: 'show', unblockedOnly: true, lastProject: 'p1' }), { emptyLanes: 'show', unblockedOnly: true, lastProject: 'p1' });
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

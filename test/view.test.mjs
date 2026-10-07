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
});

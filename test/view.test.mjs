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

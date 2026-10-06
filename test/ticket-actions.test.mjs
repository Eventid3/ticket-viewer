import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ticketActions, refusal, isBusy } from '../lib/ticket-actions.mjs';

const git = { agents: true };
const ticket = (status, extra = {}) => ({ status, blocked: false, openBlockers: [], ...extra });
const agent = (state, extra = {}) => ({ state, bgId: 'bg1', sessionId: 's1', conflict: null, merging: null, ...extra });
const conflict = { files: ['shared.txt'] };
const merging = (unresolved, toolOpen = false) => ({ unresolved, toolOpen });

// [case, ticket, agent record, project, action, expected why (null: allowed)]
const cases = [
  ['a fresh ticket can start', ticket('ready-for-agent'), null, git, 'start', null],
  ['…and be dragged to claimed', ticket('ready-for-agent'), null, git, 'moves.claimed', null],
  ['not in a git repository', ticket('ready-for-agent'), null, { agents: false }, 'start', /git repository/],
  ['blocked', ticket('ready-for-agent', { blocked: true, openBlockers: ['01'] }), null, git, 'start', /Blocked by 01/],
  ['blocked tickets can\'t be dragged to claimed', ticket('ready-for-agent', { blocked: true, openBlockers: ['01'] }), null, git, 'moves.claimed', /Blocked by 01/],
  ['a starting agent is busy', ticket('claimed'), agent('starting'), git, 'start', /already working/],
  ['a running agent is busy', ticket('claimed'), agent('running'), git, 'start', /already working/],
  ['an agent waiting on you is busy', ticket('claimed'), agent('waiting'), git, 'start', /already working/],
  ['an idle agent can continue', ticket('claimed'), agent('idle'), git, 'start', null],
  ['claimed back to ready-for-agent while starting', ticket('claimed'), agent('starting'), git, 'moves.ready-for-agent', /Stop the agent first/],
  ['claimed back to ready-for-agent once stopped', ticket('claimed'), agent('stopped'), git, 'moves.ready-for-agent', null],
  ['start doesn\'t apply in review', ticket('ready-for-review'), agent('done'), git, 'start', /not ready-for-agent/],
  ['send back from review', ticket('ready-for-review'), agent('done'), git, 'moves.claimed', null],
  ['approve', ticket('ready-for-review'), agent('done'), git, 'moves.resolved', null],
  ['a move the board doesn\'t make', ticket('ready-for-review'), agent('done'), git, 'moves.wontfix', /use \/triage/],
  ['stop a running agent', ticket('claimed'), agent('running'), git, 'stop', null],
  ['nothing to stop', ticket('claimed'), agent('stopped'), git, 'stop', /No agent session/],

  ['resolve a conflict', ticket('ready-for-review'), agent('done', { conflict }), git, 'resolveConflicts', null],
  ['merge a conflict by hand', ticket('claimed'), agent('idle', { conflict }), git, 'mergeByHand', null],
  ['no conflict to resolve', ticket('ready-for-review'), agent('done'), git, 'resolveConflicts', /No merge conflict/],
  ['resolving while the agent works', ticket('claimed'), agent('running', { conflict }), git, 'resolveConflicts', /already working/],
  ['merging by hand while the agent works', ticket('claimed'), agent('starting', { conflict }), git, 'mergeByHand', /stop it first/],
  ['resolving outside claimed and review', ticket('resolved'), agent('stopped', { conflict }), git, 'resolveConflicts', /not claimed or ready-for-review/],
  ['resolving mid-merge', ticket('claimed'), agent('idle', { conflict, merging: merging(1) }), git, 'resolveConflicts', /merge is in progress/],

  ['finish with files unmerged', ticket('claimed'), agent('idle', { merging: merging(2) }), git, 'finishMerge', /2 files still unmerged/],
  ['finish once resolved', ticket('claimed'), agent('idle', { merging: merging(0) }), git, 'finishMerge', null],
  ['finish while meld is open', ticket('claimed'), agent('idle', { merging: merging(0, true) }), git, 'finishMerge', /meld is still open/],
  ['abort while meld is open', ticket('claimed'), agent('idle', { merging: merging(1, true) }), git, 'abortMerge', /meld is still open/],
  ['abort', ticket('claimed'), agent('idle', { merging: merging(1) }), git, 'abortMerge', null],
  ['reopen meld while it is open', ticket('claimed'), agent('idle', { merging: merging(1, true) }), git, 'reopenMeld', /already open/],
  ['reopen meld with nothing unmerged', ticket('claimed'), agent('idle', { merging: merging(0) }), git, 'reopenMeld', /Every file is resolved/],
  ['finish while the agent works in the worktree', ticket('claimed'), agent('running', { merging: merging(0) }), git, 'finishMerge', /agent is working/],
  ['finish without a merge', ticket('claimed'), agent('idle'), git, 'finishMerge', /No merge in progress/],

  // A worktree mid-merge is yours: no agent gets it and the ticket isn't closed until you finish or abort.
  ['approve mid-merge', ticket('ready-for-review'), agent('done', { merging: merging(0) }), git, 'moves.resolved', /Finish or abort the merge first/],
  ['send back mid-merge', ticket('ready-for-review'), agent('done', { merging: merging(0) }), git, 'moves.claimed', /Finish or abort the merge first/],
  ['hand back from review mid-merge', ticket('ready-for-review'), agent('done', { merging: merging(0) }), git, 'moves.ready-for-agent', /Finish or abort the merge first/],
  ['hand back from claimed mid-merge', ticket('claimed'), agent('idle', { merging: merging(0) }), git, 'moves.ready-for-agent', /Finish or abort the merge first/],
  ['continue mid-merge', ticket('claimed'), agent('idle', { merging: merging(0) }), git, 'start', /Finish or abort the merge first/],
];

for (const [name, t, a, project, action, expected] of cases) {
  test(`${action}: ${name}`, () => {
    const why = refusal(t, a, project, action);
    if (expected === null) assert.equal(why, null);
    else assert.match(why ?? '', expected);
  });
}

test('the page gets {ok, why} for actions that apply, and none for those that don\'t', () => {
  const actions = ticketActions(ticket('claimed'), agent('running', { conflict }), git);
  assert.deepEqual(Object.keys(actions).sort(), ['mergeByHand', 'moves', 'resolveConflicts', 'start', 'stop']);
  assert.deepEqual(actions.resolveConflicts, { ok: false, why: 'An agent is already working on this ticket' });
  assert.deepEqual(actions.stop, { ok: true, why: null });
  assert.deepEqual(actions.moves, { 'ready-for-agent': { ok: false, why: 'Stop the agent first' } });
});

test('mid-merge, the merge panel\'s actions replace resolving', () => {
  const actions = ticketActions(ticket('claimed'), agent('idle', { conflict, merging: merging(1, true) }), git);
  assert.equal(actions.resolveConflicts, undefined);
  assert.equal(actions.mergeByHand, undefined);
  assert.deepEqual(Object.keys(actions).filter(k => k.endsWith('Merge') || k === 'reopenMeld').sort(), ['abortMerge', 'finishMerge', 'reopenMeld']);
});

test('start says whether it continues the agent\'s session', () => {
  assert.equal(ticketActions(ticket('claimed'), agent('idle'), git).start.resume, true);
  assert.equal(ticketActions(ticket('claimed'), agent('idle', { bgId: undefined }), git).start.resume, false, 'records from before background sessions start over');
  assert.equal(ticketActions(ticket('ready-for-agent'), null, git).start.resume, false);
});

test('a ticket without an agent in claimed has nothing to start', () => {
  assert.equal(ticketActions(ticket('claimed'), null, git).start, undefined);
});

test('busy: starting, running and waiting on you', () => {
  assert.deepEqual(['starting', 'running', 'waiting', 'idle', 'done', 'stopped', 'failed'].map(state => isBusy({ state })),
    [true, true, true, false, false, false, false]);
  assert.equal(isBusy(null), false);
});

test('an unknown action is a programming error', () => {
  assert.throws(() => refusal(ticket('claimed'), null, git, 'fly'), /Unknown ticket action/);
});

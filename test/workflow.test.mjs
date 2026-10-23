import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TICKET_WORKFLOW as wf, TASK_WORKFLOW as taskWf, workflowFor } from '../lib/workflow.mjs';

test('every ticket has the ticket workflow', () => {
  assert.equal(workflowFor({ id: 'f/01-a.md' }), wf);
});

test('lanes and moves', () => {
  assert.deepEqual(wf.lanes, ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'claimed', 'ready-for-review', 'resolved', 'wontfix']);
  assert.deepEqual(wf.moves['ready-for-agent'], ['claimed']);
  assert.deepEqual(wf.moves.claimed, ['ready-for-review', 'ready-for-agent']);
  assert.deepEqual(wf.moves['ready-for-review'], ['resolved', 'claimed', 'ready-for-agent']);
  assert.deepEqual(wf.moves['ready-for-human'], ['resolved']);
  assert.equal(wf.moves['needs-triage'], undefined, 'triage lanes move through /triage');
  for (const [from, tos] of Object.entries(wf.moves)) for (const to of [from, ...tos]) assert.ok(wf.lanes.includes(to), to);
});

test('turn end moves claimed to ready-for-review only', () => {
  assert.equal(wf.turnEnd.claimed, 'ready-for-review');
  assert.equal(wf.turnEnd['ready-for-review'], undefined);
  assert.equal(wf.turnEnd['ready-for-agent'], undefined);
});

test('conflict, review and needs-you lanes', () => {
  assert.deepEqual(wf.conflictLanes, ['claimed', 'ready-for-review']);
  assert.deepEqual(wf.reviewLanes, ['ready-for-review']);
  assert.deepEqual(wf.quietLanes, ['ready-for-agent', 'ready-for-review']);
});

test('naming and start prompt', () => {
  const id = 'task-workflow/01-workflow-seam.md';
  assert.equal(wf.startPrompt('/x/y.md'), '/implement /x/y.md');
  assert.equal(wf.branch(id), 'ticket/task-workflow/01-workflow-seam');
  assert.equal(wf.worktreeName(id), 'ticket-task-workflow--01-workflow-seam');
  assert.equal(wf.sessionName('/x/issues/01-workflow-seam.md'), 'ticket 01-workflow-seam');
  assert.equal(wf.hostname(id), 'task-workflow-01.dev.localhost');
  assert.equal(wf.branch('My Feat/02-a b.md'), 'ticket/My-Feat/02-a-b');
});

test('tasks have the task workflow: own lanes, no moves, never an agent start', () => {
  assert.equal(workflowFor({ id: 'tasks/01-a.md' }), taskWf);
  assert.deepEqual(taskWf.lanes, ['drafting', 'plan-review', 'implementing', 'ready-for-review', 'resolved', 'wontfix']);
  assert.deepEqual(taskWf.moves, { 'plan-review': ['implementing', 'drafting'] });
  assert.deepEqual(taskWf.planEnd, { drafting: 'plan-review' });
  assert.equal(taskWf.startLane, null);
  assert.deepEqual(taskWf.reviewLanes, ['plan-review', 'ready-for-review']);
});

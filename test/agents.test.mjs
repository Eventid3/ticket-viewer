import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createAgents } from '../lib/agents.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const commit = (cwd, msg) => {
  fs.appendFileSync(path.join(cwd, 'work.txt'), `${msg}\n`);
  git(cwd, 'add', 'work.txt');
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg);
};

// Stands in for the `claude` CLI: records calls, and reports whatever sessions the test sets.
function fakeCli() {
  const cli = {
    calls: [], sessions: [], next: 1,
    async background(args, cwd) {
      const id = `bg${cli.next++}`;
      cli.calls.push({ args, cwd, id });
      cli.sessions.push({ id, sessionId: `session-${id}`, cwd, kind: 'background', status: 'busy' });
      return id;
    },
    async list() { return cli.sessions; },
    async stop(id) { cli.set(id, { status: undefined, state: 'stopped' }); },
    set(id, fields) { Object.assign(cli.sessions.find(s => s.id === id), fields); },
  };
  return cli;
}

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agents-')));
  const repo = path.join(root, 'repo');
  const issues = path.join(repo, '.scratch', 'feat', 'issues');
  fs.mkdirSync(issues, { recursive: true });
  fs.writeFileSync(path.join(issues, '01-a.md'), '# 01: A\n\nStatus: claimed\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const cli = fakeCli();
  const changes = [];
  const claudeHome = path.join(root, 'claude-home');
  const agents = createAgents({ scratchRoot: path.join(repo, '.scratch'), cli, claudeHome, onChange: (id, r, prev) => changes.push(`${prev}→${r.state}`) });
  return { root, repo, cli, agents, changes, claudeHome, ticket: path.join(issues, '01-a.md') };
}

const ID = 'feat/01-a.md';

test('starts /implement as a background session in a worktree inside the repo', async () => {
  const { repo, cli, agents, ticket } = setup();
  const r = await agents.start(ID, ticket);

  assert.equal(r.state, 'running');
  assert.equal(r.bgId, 'bg1');
  assert.equal(r.branch, 'ticket/feat/01-a');
  assert.equal(r.worktree, path.join(repo, '.claude', 'worktrees', 'ticket-feat--01-a'));
  assert.equal(git(r.worktree, 'branch', '--show-current'), 'ticket/feat/01-a');
  assert.doesNotMatch(git(repo, 'status', '--porcelain'), /\.claude/, 'worktrees are git-ignored in the main checkout');

  const { args, cwd } = cli.calls[0];
  assert.equal(cwd, r.worktree);
  assert.match(args[0], new RegExp(`^/implement ${ticket}\\n`));
  assert.deepEqual(args.slice(1), ['-n', 'ticket 01-a', '--permission-mode', 'auto', '--add-dir', path.dirname(ticket)]);
});

test('calls onWorktree with the worktree and base once the worktree exists, before the session starts', async () => {
  const { repo, cli, ticket } = setup();
  const seen = [];
  const agents = createAgents({
    scratchRoot: path.join(repo, '.scratch'), cli,
    onWorktree: (worktree, base) => seen.push({ worktree, base, exists: fs.existsSync(worktree), sessions: cli.calls.length }),
  });
  const r = await agents.start(ID, ticket);
  assert.deepEqual(seen, [{ worktree: r.worktree, base: git(repo, 'rev-parse', 'HEAD'), exists: true, sessions: 0 }]);
});

test('a throwing onWorktree does not stop the agent from starting', async () => {
  const { repo, cli, ticket } = setup();
  const agents = createAgents({ scratchRoot: path.join(repo, '.scratch'), cli, onWorktree: () => { throw new Error('boom'); } });
  assert.equal((await agents.start(ID, ticket)).state, 'running');
});

test('follows the session: waiting on you, replying, then done once it has committed', async () => {
  const { cli, agents, changes, ticket } = setup();
  const r = await agents.start(ID, ticket);

  cli.set('bg1', { status: 'waiting', waitingFor: 'permission prompt', state: 'blocked' });
  await agents.poll();
  assert.equal(agents.get(ID).state, 'waiting');
  assert.equal(agents.get(ID).waitingFor, 'permission prompt');
  assert.equal(agents.get(ID).sessionId, 'session-bg1');
  assert.ok(agents.busy(ID));

  cli.set('bg1', { status: 'idle', state: 'done' });
  await agents.poll();
  assert.equal(agents.get(ID).state, 'idle', 'ended its turn without committing');

  commit(r.worktree, 'Build it');
  await agents.poll();
  assert.equal(agents.get(ID).state, 'done');
  assert.deepEqual(changes, ['starting→running', 'running→waiting', 'waiting→idle', 'idle→done']);
  assert.equal(agents.changes(ID).commits.length, 1);
});

test('resume continues the same conversation in the same worktree', async () => {
  const { cli, agents, ticket } = setup();
  const first = await agents.start(ID, ticket);
  await agents.poll();
  const r = await agents.resume(ID, ticket, 'Please add a test');

  assert.equal(cli.sessions.find(s => s.id === 'bg1').state, 'stopped', 'old session stopped first');
  const { args, cwd } = cli.calls[1];
  assert.equal(cwd, first.worktree);
  assert.deepEqual(args.slice(0, 3), ['--resume', 'session-bg1', 'Please add a test']);
  assert.equal(r.bgId, 'bg2');
  assert.equal(r.state, 'running');
});

test('a session that disappears or is stopped shows as stopped; a failed start is reported', async () => {
  const { cli, agents, ticket } = setup();
  await agents.start(ID, ticket);
  await agents.poll();
  cli.sessions.length = 0;
  await agents.poll();
  assert.equal(agents.get(ID).state, 'stopped');

  cli.background = async () => { throw new Error('Workspace not trusted'); };
  await assert.rejects(agents.resume(ID, ticket, 'go'));
  assert.equal(agents.get(ID).state, 'failed');
  assert.equal(agents.get(ID).error, 'Workspace not trusted');
});

test('reads activity and the last message from the session transcript', async () => {
  const { cli, agents, claudeHome, ticket } = setup();
  await agents.start(ID, ticket);
  await agents.poll();
  const dir = path.join(claudeHome, 'projects', 'some-project');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'user', message: { content: 'go' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking around' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Should I also update the docs?' }] } },
  ];
  fs.writeFileSync(path.join(dir, 'session-bg1.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');

  const { items, lastMessage } = agents.activity(ID);
  assert.deepEqual(items.map(i => `${i.kind}: ${i.text}`), ['text: Looking around', 'tool: Bash npm test', 'text: Should I also update the docs?']);
  assert.equal(lastMessage, 'Should I also update the docs?');
  assert.equal(cli.calls.length, 1);
});

test('state survives a restart of the board', async () => {
  const { repo, cli, agents, ticket } = setup();
  await agents.start(ID, ticket);
  const again = createAgents({ scratchRoot: path.join(repo, '.scratch'), cli });
  assert.equal(again.get(ID).bgId, 'bg1');
  assert.equal(again.get(ID).state, 'running');
});

test('moves a worktree from the old sibling-folder layout into .claude/worktrees', async () => {
  const { root, repo, cli, ticket } = setup();
  const old = path.join(root, 'repo-worktrees', 'feat--01-a');
  git(repo, 'worktree', 'add', '-q', '-b', 'ticket/feat/01-a', old);
  const stateDir = path.join(repo, '.git', 'ticket-viewer');
  fs.writeFileSync(path.join(stateDir, 'agents.json'), JSON.stringify({ [ID]: { branch: 'ticket/feat/01-a', worktree: old, base: git(repo, 'rev-parse', 'HEAD'), state: 'interrupted' } }));
  const r = await createAgents({ scratchRoot: path.join(repo, '.scratch'), cli }).start(ID, ticket);
  assert.equal(r.worktree, path.join(repo, '.claude', 'worktrees', 'ticket-feat--01-a'));
  assert.ok(!fs.existsSync(old));
  assert.equal(git(r.worktree, 'branch', '--show-current'), 'ticket/feat/01-a');
});

test('is unavailable outside a git repository', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nogit-'));
  assert.equal(createAgents({ scratchRoot: dir }), null);
});

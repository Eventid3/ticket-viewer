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

// Stands in for the /proc process lister: reports whatever processes the test puts in each folder.
function fakeProcesses() {
  const lister = {
    procs: [], killed: [],
    find(folders) {
      return Object.fromEntries(folders.map(f => [f, lister.procs.filter(p => p.cwd === f || p.cwd.startsWith(f + path.sep)).map(({ cwd, ...p }) => p)]));
    },
    async kill(pgid) { lister.killed.push(pgid); lister.procs = lister.procs.filter(p => p.pgid !== pgid); },
  };
  return lister;
}

function setupWithProcesses() {
  const s = setup();
  const processes = fakeProcesses();
  const seen = [];
  const agents = createAgents({ scratchRoot: path.join(s.repo, '.scratch'), cli: s.cli, processes, onProcesses: id => seen.push(id) });
  return { ...s, agents, processes, seen };
}

test('each poll finds the worktree processes of every ticket with a worktree, even when its agent has stopped', async () => {
  const { cli, agents, processes, seen, ticket } = setupWithProcesses();
  const r = await agents.start(ID, ticket);
  await agents.stop(ID);
  cli.sessions.length = 0;
  processes.procs.push(
    { cwd: path.join(r.worktree, 'web'), pid: 10, pgid: 10, command: 'dotnet watch', ports: [] },
    { cwd: path.join(r.worktree, 'web'), pid: 11, pgid: 10, command: 'dotnet web.dll', ports: [5000] },
    { cwd: path.dirname(r.worktree), pid: 12, pgid: 12, command: 'vim', ports: [] });
  seen.length = 0;
  await agents.poll();

  assert.deepEqual(agents.get(ID).processes.map(p => [p.pid, p.command, p.ports]), [[10, 'dotnet watch', []], [11, 'dotnet web.dll', [5000]]]);
  assert.deepEqual(agents.all()[ID].processes.length, 2);
  assert.deepEqual(seen, [ID], 'tells the board when the list changes');
  await agents.poll();
  assert.deepEqual(seen, [ID], 'and only then');
});

test('kills one worktree process by its group, or all of them, and refuses anything else', async () => {
  const { agents, processes, ticket } = setupWithProcesses();
  const r = await agents.start(ID, ticket);
  processes.procs.push(
    { cwd: r.worktree, pid: 10, pgid: 10, command: 'dotnet watch', ports: [] },
    { cwd: r.worktree, pid: 11, pgid: 10, command: 'dotnet web.dll', ports: [5000] },
    { cwd: r.worktree, pid: 20, pgid: 20, command: 'npm run dev', ports: [5173] },
    { cwd: '/elsewhere', pid: 30, pgid: 30, command: 'postgres', ports: [5432] });

  await assert.rejects(agents.killProcesses(ID, 30), /not a worktree process/);
  await assert.rejects(agents.killProcesses('feat/02-b.md', 10), /not a worktree process/);
  assert.deepEqual(processes.killed, []);

  assert.equal(await agents.killProcesses(ID, 11), 2, 'stops the whole group');
  assert.deepEqual(processes.killed, [10]);
  assert.deepEqual(agents.get(ID).processes.map(p => p.pid), [20], 'the list updates');

  assert.equal(await agents.killProcesses(ID), 1);
  assert.deepEqual(agents.get(ID).processes, []);
  assert.equal(await agents.killProcesses(ID), 0, 'nothing left to stop');
});

test('stopping the agent leaves its worktree processes running', async () => {
  const { agents, processes, ticket } = setupWithProcesses();
  const r = await agents.start(ID, ticket);
  processes.procs.push({ cwd: r.worktree, pid: 10, pgid: 10, command: 'npm run dev', ports: [] });
  await agents.stop(ID);
  assert.deepEqual(processes.killed, []);
  assert.equal(agents.get(ID).processes.length, 1);
});

test('without a process lister, records carry no processes', async () => {
  const { repo, cli, ticket } = setup();
  const agents = createAgents({ scratchRoot: path.join(repo, '.scratch'), cli, processes: null });
  await agents.start(ID, ticket);
  await agents.poll();
  assert.equal('processes' in agents.get(ID), false);
  await assert.rejects(agents.killProcesses(ID), /not available/);
});

test('the prompt tells the agent to stop its background processes', async () => {
  const { cli, agents, ticket } = setup();
  await agents.start(ID, ticket);
  assert.match(cli.calls[0].args[0], /stop any servers or background processes you started/i);
});

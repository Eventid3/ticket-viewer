import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createAgents, agentHostname, conflictCheck, mergeTree } from '../lib/agents.mjs';

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
  assert.deepEqual(args.slice(0, 2), ['--resume', 'session-bg1']);
  assert.match(args[2], /^Please add a test\n/);
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
  const probed = [];
  // Ports below 6000 speak TLS, like Kestrel's https endpoint; the rest are plain http.
  // Probes answer when the test calls answerProbes().
  let pending = [];
  const probeScheme = port => { probed.push(port); return new Promise(r => pending.push(() => r(port < 6000 ? 'https' : 'http'))); };
  const answerProbes = async () => { pending.splice(0).forEach(f => f()); await new Promise(r => setImmediate(r)); };
  const agents = createAgents({ scratchRoot: path.join(s.repo, '.scratch'), cli: s.cli, processes, probeScheme, onProcesses: id => seen.push(id) });
  return { ...s, agents, processes, seen, probed, answerProbes };
}

test('each poll finds the worktree processes of every ticket with a worktree, even when its agent has stopped', async () => {
  const { cli, agents, processes, seen, ticket, answerProbes } = setupWithProcesses();
  const r = await agents.start(ID, ticket);
  await agents.stop(ID);
  cli.sessions.length = 0;
  processes.procs.push(
    { cwd: path.join(r.worktree, 'web'), pid: 10, pgid: 10, command: 'dotnet watch', ports: [] },
    { cwd: path.join(r.worktree, 'web'), pid: 11, pgid: 10, command: 'dotnet web.dll', ports: [5000] },
    { cwd: path.dirname(r.worktree), pid: 12, pgid: 12, command: 'vim', ports: [] });
  seen.length = 0;
  await agents.poll();

  assert.deepEqual(agents.get(ID).processes.map(p => [p.pid, p.command, p.ports]), [[10, 'dotnet watch', []], [11, 'dotnet web.dll', [{ port: 5000, scheme: null }]]]);
  assert.deepEqual(agents.all()[ID].processes.length, 2);
  assert.deepEqual(seen, [ID], 'tells the board when the list changes');
  await answerProbes();
  await agents.poll();
  assert.deepEqual(seen, [ID, ID], 'and when a port\'s scheme is known, and only then');
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

test('the prompt tells the agent to stop its worktree processes', async () => {
  const { cli, agents, ticket } = setup();
  await agents.start(ID, ticket);
  assert.match(cli.calls[0].args[0], /stop any servers or background processes you started/i);
});

test('probes each listening port once for TLS and gives its scheme', async () => {
  const { agents, processes, probed, seen, ticket, answerProbes } = setupWithProcesses();
  const r = await agents.start(ID, ticket);
  processes.procs.push(
    { cwd: r.worktree, pid: 11, pgid: 10, command: 'dotnet web.dll', ports: [5001, 6000] },
    { cwd: r.worktree, pid: 20, pgid: 20, command: 'npm run dev', ports: [7000] });
  await agents.poll();
  assert.deepEqual(agents.get(ID).processes.flatMap(p => p.ports), [
    { port: 5001, scheme: null }, { port: 6000, scheme: null }, { port: 7000, scheme: null }], 'unknown until probed');

  seen.length = 0;
  await answerProbes();
  assert.deepEqual(seen, [ID, ID, ID], 'tells the board once the schemes are known');
  assert.deepEqual(agents.get(ID).processes.flatMap(p => p.ports), [
    { port: 5001, scheme: 'https' }, { port: 6000, scheme: 'http' }, { port: 7000, scheme: 'http' }]);

  await agents.poll();
  agents.all();
  await answerProbes();
  assert.deepEqual(probed, [5001, 6000, 7000], 'not again on later polls or reads');

  // A new server on a port the old one used gets probed afresh.
  processes.procs = [{ cwd: r.worktree, pid: 30, pgid: 30, command: 'node other.js', ports: [5001] }];
  await agents.poll();
  assert.deepEqual(probed, [5001, 6000, 7000, 5001]);
});

test('each ticket has a stable agent hostname that is one valid DNS label under dev.localhost', async () => {
  assert.equal(agentHostname('agent-sandboxing/02-per-worktree-localhost-hostname.md'), 'agent-sandboxing-02.dev.localhost');
  assert.equal(agentHostname('agent-sandboxing/02-per-worktree-localhost-hostname.md'), agentHostname('agent-sandboxing/02-other-slug.md'), 'the slug doesn\'t matter');
  assert.equal(agentHostname('Codemap v1.2/11-x.md'), 'codemap-v1-2-11.dev.localhost', 'dots, spaces and capitals');
  assert.equal(agentHostname('Ünïcode_Fëature!!/3-x.md'), 'unicode-feature-3.dev.localhost', 'accents, underscores, punctuation');
  assert.equal(agentHostname('--weird--/07-x.md'), 'weird-07.dev.localhost', 'no leading, trailing or doubled hyphens');
  assert.equal(agentHostname('日本/05-x.md'), 'ticket-05.dev.localhost', 'nothing usable left of the feature');
  assert.equal(agentHostname('feat/notes.md'), 'feat-notes.dev.localhost', 'a file without a number');

  const long = agentHostname(`${'very-long-feature-name-'.repeat(5)}x/123-x.md`);
  const label = long.replace(/\.dev\.localhost$/, '');
  assert.ok(label.length <= 63, `${label} is ${label.length} characters`);
  assert.match(label, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
  assert.match(label, /-123$/, 'keeps the number intact');
  assert.equal(label, 'very-long-feature-name-very-long-feature-name-very-long-fea-123');
  assert.ok(agentHostname(`f/${'9'.repeat(80)}-x.md`).split('.')[0].length <= 63, 'even with an absurd number');
});

test('records carry the agent hostname', async () => {
  const { agents, ticket } = setup();
  await agents.start(ID, ticket);
  assert.equal(agents.get(ID).hostname, 'feat-01.dev.localhost');
});

test('the prompt tells the agent to browse at its hostname and fall back to localhost, on start and resume', async () => {
  const { cli, agents, ticket } = setup();
  await agents.start(ID, ticket);
  const prompt = cli.calls[0].args[0];
  assert.match(prompt, /feat-01\.dev\.localhost/);
  assert.match(prompt, /usual scheme and port/);
  assert.match(prompt, /fall back to localhost/i);
  assert.match(prompt, /don't change the app's host configuration/i);

  await agents.poll();
  await agents.resume(ID, ticket, 'Fix the tests');
  const message = cli.calls[1].args[2];
  assert.match(message, /^Fix the tests\n/);
  assert.match(message, /feat-01\.dev\.localhost/);
});

// --- reference branch and merge conflicts -------------------------------------------------

const commitFile = (cwd, file, text, msg = `edit ${file}`) => {
  fs.writeFileSync(path.join(cwd, file), text);
  git(cwd, 'add', file);
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg);
};

test('the conflict check: a clean merge, a conflict with its files, and a cache hit while neither branch moves', () => {
  const { repo } = setup();
  commitFile(repo, 'shared.txt', 'one\n');
  git(repo, 'branch', 'side');
  git(repo, 'branch', 'clean');
  commitFile(repo, 'shared.txt', 'main\n');
  git(repo, 'checkout', '-q', 'side');
  commitFile(repo, 'shared.txt', 'side\n');
  commitFile(repo, 'other.txt', 'side only\n');
  git(repo, 'checkout', '-q', 'clean');
  commitFile(repo, 'new.txt', 'clean\n');
  git(repo, 'checkout', '-q', 'main');

  let runs = 0;
  const check = conflictCheck(repo, (...args) => { runs++; return mergeTree(...args); });
  assert.deepEqual(check('main', 'clean'), { files: [] });
  assert.deepEqual(check('main', 'side'), { files: ['shared.txt'] });
  assert.equal(runs, 2);
  assert.deepEqual(check('main', 'side'), { files: ['shared.txt'] });
  assert.equal(runs, 2, 'same pair of commits: cached');

  commitFile(repo, 'unrelated.txt', 'x\n');
  check('main', 'side');
  assert.equal(runs, 3, 're-runs once the reference branch moves');
  assert.equal(check('main', 'no-such-branch'), null, 'nothing to say about a branch that is gone');
});

function setupConflicts() {
  const s = setup();
  const checked = new Set([ID, 'feat/02-b.md']);
  fs.writeFileSync(path.join(path.dirname(s.ticket), '02-b.md'), '# 02: B\n\nStatus: claimed\n');
  commitFile(s.repo, 'shared.txt', 'one\n');
  const agents = createAgents({
    scratchRoot: path.join(s.repo, '.scratch'), cli: s.cli, processes: null,
    checkConflicts: id => checked.has(id),
    onConflicts: id => s.changes.push(id),
  });
  return { ...s, agents, checked, ticketB: path.join(path.dirname(s.ticket), '02-b.md') };
}

test('starting an agent records the main checkout\'s branch as the reference branch', async () => {
  const { repo, agents, ticket } = setupConflicts();
  git(repo, 'checkout', '-q', '-b', 'release');
  const r = await agents.start(ID, ticket);
  assert.equal(r.ref, 'release');
  git(repo, 'checkout', '-q', 'main');
  await agents.poll();
  assert.equal(agents.get(ID).ref, 'release', 'kept when the main checkout moves on');
});

test('an older record without a reference branch falls back to the branch checked out now', async () => {
  const { repo, cli, ticket } = setup();
  const agents = createAgents({ scratchRoot: path.join(repo, '.scratch'), cli, processes: null });
  await agents.start(ID, ticket);
  const file = path.join(repo, '.git', 'ticket-viewer', 'agents.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete saved[ID].ref;
  fs.writeFileSync(file, JSON.stringify(saved));
  const again = createAgents({ scratchRoot: path.join(repo, '.scratch'), cli, processes: null });
  assert.equal(again.get(ID).ref, 'main', 'before the first poll too');
  await again.poll();
  assert.equal(again.get(ID).ref, 'main');
});

test('a detached HEAD or a deleted reference branch turns the check off', async () => {
  const { repo, agents, ticket } = setupConflicts();
  git(repo, 'checkout', '-q', '--detach');
  const r = await agents.start(ID, ticket);
  assert.equal(r.ref, null);
  await agents.poll();
  assert.equal(agents.get(ID).ref, null);
  assert.equal(agents.get(ID).conflict, null);
  git(repo, 'checkout', '-q', 'main');
  await agents.poll();
  assert.equal(agents.get(ID).ref, null, 'started detached: stays off when a branch is checked out again');
  await agents.stop(ID);
  await agents.start(ID, ticket);
  assert.equal(agents.get(ID).ref, null, 'also when started again');

  const { repo: repo2, agents: agents2, ticket: ticket2 } = setupConflicts();
  git(repo2, 'checkout', '-q', '-b', 'temp');
  await agents2.start(ID, ticket2);
  git(repo2, 'checkout', '-q', 'main');
  git(repo2, 'branch', '-q', '-D', 'temp');
  await agents2.poll();
  assert.equal(agents2.get(ID).ref, null);
  assert.equal(agents2.get(ID).conflict, null);
});

test('merging ticket A into the reference branch shows ticket B\'s merge conflict on the next poll', async () => {
  const { repo, agents, changes, ticket, ticketB } = setupConflicts();
  const a = await agents.start(ID, ticket);
  const b = await agents.start('feat/02-b.md', ticketB);
  commitFile(a.worktree, 'shared.txt', 'from A\n');
  commitFile(b.worktree, 'shared.txt', 'from B\n');
  await agents.poll();
  assert.equal(agents.get(ID).conflict, null);
  assert.equal(agents.get('feat/02-b.md').conflict, null);

  changes.length = 0;
  git(repo, 'merge', '-q', a.branch);
  await agents.poll();
  assert.deepEqual(agents.get('feat/02-b.md').conflict, { files: ['shared.txt'] });
  assert.deepEqual(agents.all()['feat/02-b.md'].conflict, { files: ['shared.txt'] });
  assert.equal(agents.get(ID).conflict, null);
  assert.deepEqual(changes, ['feat/02-b.md'], 'tells the board');
});

test('tickets outside the checked statuses get no conflict check', async () => {
  const { repo, agents, checked, ticket, ticketB } = setupConflicts();
  const a = await agents.start(ID, ticket);
  const b = await agents.start('feat/02-b.md', ticketB);
  commitFile(a.worktree, 'shared.txt', 'from A\n');
  commitFile(b.worktree, 'shared.txt', 'from B\n');
  git(repo, 'merge', '-q', a.branch);
  checked.delete('feat/02-b.md');
  await agents.poll();
  assert.equal(agents.get('feat/02-b.md').conflict, null);
  checked.add('feat/02-b.md');
  await agents.poll();
  assert.deepEqual(agents.get('feat/02-b.md').conflict, { files: ['shared.txt'] });
});

test('review diffs measure from the merge-base with the reference branch', async () => {
  const { repo, agents, ticket, ticketB } = setupConflicts();
  const a = await agents.start(ID, ticket);
  const b = await agents.start('feat/02-b.md', ticketB);
  commitFile(a.worktree, 'a.txt', 'A\n', 'Work of A');
  commitFile(b.worktree, 'b.txt', 'B\n', 'Work of B');
  git(repo, 'merge', '-q', a.branch);
  git(b.worktree, '-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', '--no-edit', 'main');
  await agents.poll();

  const base = agents.reviewBase('feat/02-b.md');
  assert.equal(base, git(repo, 'rev-parse', 'main'));
  const changes = agents.changes('feat/02-b.md');
  assert.deepEqual(changes.commits.map(c => c.replace(/^\w+ /, '')), ["Merge branch 'main' into ticket/feat/02-b", 'Work of B'], 'not A\'s work');
  assert.equal(changes.base, base);
  assert.match(changes.stat, /b\.txt/);
  assert.doesNotMatch(changes.stat, /a\.txt/);
});

test('without a usable reference branch, review diffs measure from the stored base', async () => {
  const { repo, agents, ticket } = setupConflicts();
  git(repo, 'checkout', '-q', '--detach');
  const r = await agents.start(ID, ticket);
  assert.equal(agents.reviewBase(ID), r.base);
});

// --- resolving a merge conflict with the agent --------------------------------------------

// Ticket B conflicts with main in shared.txt once ticket A is merged; B's agent ended its turn.
async function setupConflictB({ sessionId = true } = {}) {
  const s = setupConflicts();
  const a = await s.agents.start(ID, s.ticket);
  const b = await s.agents.start('feat/02-b.md', s.ticketB);
  commitFile(a.worktree, 'shared.txt', 'from A\n');
  commitFile(b.worktree, 'shared.txt', 'from B\n');
  git(s.repo, 'merge', '-q', a.branch);
  if (!sessionId) s.cli.set('bg2', { sessionId: undefined });
  s.cli.set('bg2', { status: 'idle', state: 'done' });
  await s.agents.poll();
  return { ...s, b, calls: s.cli.calls.length };
}

test('resolving conflicts resumes the session with a merge prompt naming the reference branch and files', async () => {
  const { cli, agents, b, ticketB, calls } = await setupConflictB();
  const r = await agents.resolveConflicts('feat/02-b.md', ticketB);

  assert.equal(r.state, 'running');
  const { args, cwd } = cli.calls[calls];
  assert.equal(cwd, b.worktree);
  assert.deepEqual(args.slice(0, 2), ['--resume', 'session-bg2']);
  assert.match(args[2], /git merge main/);
  assert.match(args[2], /shared\.txt/);
  assert.match(args[2], /not rebase/i);
  assert.match(args[2], /run the tests/i);
  assert.match(args[2], /commit/i);
  assert.match(args[2], /end your turn/i);
  assert.match(args[2], /feat-02\.dev\.localhost/, 'with the browser note, like any resume');
});

test('resolving conflicts without a session to resume starts a new one in the same worktree', async () => {
  const { cli, agents, b, ticketB, calls } = await setupConflictB({ sessionId: false });
  assert.equal(agents.get('feat/02-b.md').sessionId, null);
  const r = await agents.resolveConflicts('feat/02-b.md', ticketB);

  assert.equal(r.state, 'running');
  assert.equal(r.worktree, b.worktree);
  assert.equal(r.branch, b.branch);
  const { args, cwd } = cli.calls[calls];
  assert.equal(cwd, b.worktree);
  assert.notEqual(args[0], '--resume');
  assert.doesNotMatch(args[0], /^\/implement/);
  assert.match(args[0], /git merge main/);
  assert.match(args[0], /shared\.txt/);
  assert.match(args[0], /not rebase/i);
  assert.ok(args[0].includes(`Read the ticket for context: ${ticketB}`));
  assert.match(args[0], /feat-02\.dev\.localhost/);
  assert.deepEqual(args.slice(1), ['-n', 'ticket 02-b', '--permission-mode', 'auto', '--add-dir', path.dirname(ticketB)]);
});

test('resolving conflicts is refused without a merge conflict or while the agent is busy', async () => {
  const { cli, agents, ticket, ticketB } = await setupConflictB();
  cli.set('bg1', { status: 'idle', state: 'done' });
  await agents.poll();
  await assert.rejects(agents.resolveConflicts(ID, ticket), /no merge conflict/i);
  cli.set('bg2', { status: 'busy', state: 'running' });
  await agents.poll();
  await assert.rejects(agents.resolveConflicts('feat/02-b.md', ticketB), /already running/i);
});

// --- resolving a merge conflict by hand ---------------------------------------------------

// Like setupConflictB, with a stand-in mergetool: `fake` runs whatever `tool(cmd)` sets, and touches tool-ran when done.
async function setupManualMerge() {
  const s = await setupConflictB();
  git(s.repo, 'config', 'user.name', 't');
  git(s.repo, 'config', 'user.email', 't@t');
  git(s.repo, 'config', 'mergetool.fake.trustExitCode', 'true');
  const ran = path.join(s.root, 'tool-ran');
  const tool = cmd => { fs.rmSync(ran, { force: true }); git(s.repo, 'config', 'mergetool.fake.cmd', `${cmd}; status=$?; touch '${ran}'; exit $status`); };
  tool('false'); // leaves the file unresolved, like closing meld without saving
  const agents = createAgents({ scratchRoot: path.join(s.repo, '.scratch'), cli: s.cli, processes: null, difftool: 'fake', onConflicts: id => s.changes.push(id) });
  await agents.poll();
  const toolRan = async () => {
    for (let i = 0; i < 200 && !fs.existsSync(ran); i++) await new Promise(r => setTimeout(r, 25));
    assert.ok(fs.existsSync(ran), 'the mergetool ran');
    await new Promise(r => setTimeout(r, 100)); // let git mergetool finish after the tool exits
  };
  return { ...s, agents, tool, toolRan, B: 'feat/02-b.md' };
}

const mergeHead = cwd => { try { return git(cwd, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'); } catch { return null; } };

test('merging by hand: conflicts leave the worktree mid-merge and open the mergetool on them', async () => {
  const { agents, b, tool, toolRan, B } = await setupManualMerge();
  tool('false');
  const before = git(b.worktree, 'rev-parse', 'HEAD');
  const result = await agents.merge(B);
  assert.deepEqual(result, { clean: false, unresolved: 1 });
  assert.ok(mergeHead(b.worktree), 'mid-merge');
  assert.equal(git(b.worktree, 'rev-parse', 'HEAD'), before, 'nothing committed yet');
  assert.deepEqual(agents.get(B).merging, { unresolved: 1 });
  await toolRan();
});

test('a resolving mergetool marks the files resolved, and Finish commits the merge', async () => {
  const { repo, agents, b, tool, toolRan, B } = await setupManualMerge();
  tool('cp "$REMOTE" "$MERGED"');
  await agents.merge(B);
  await toolRan();
  await agents.poll();
  assert.deepEqual(agents.get(B).merging, { unresolved: 0 });

  await agents.finishMerge(B);
  assert.equal(mergeHead(b.worktree), null);
  assert.equal(git(b.worktree, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3, 'a merge commit');
  assert.equal(git(b.worktree, 'status', '--porcelain'), '', 'no mergetool backups left behind');
  assert.equal(fs.readFileSync(path.join(b.worktree, 'shared.txt'), 'utf8'), fs.readFileSync(path.join(repo, 'shared.txt'), 'utf8'));
  assert.equal(agents.get(B).merging, null);
  await agents.poll();
  assert.equal(agents.get(B).conflict, null, 'the conflict is gone');
});

test('Finish is refused while files are unmerged, and works once they are resolved', async () => {
  const { agents, b, toolRan, B } = await setupManualMerge();
  await agents.merge(B);
  await toolRan();
  await assert.rejects(agents.finishMerge(B), /1 file still unmerged/i);
  assert.ok(mergeHead(b.worktree), 'still mid-merge');

  fs.writeFileSync(path.join(b.worktree, 'shared.txt'), 'both\n');
  git(b.worktree, 'add', 'shared.txt');
  await agents.finishMerge(B);
  assert.equal(mergeHead(b.worktree), null);
});

test('Reopen meld runs the mergetool again on what is still unmerged', async () => {
  const { agents, tool, toolRan, B } = await setupManualMerge();
  await agents.merge(B);
  await toolRan();
  tool('cp "$REMOTE" "$MERGED"');
  agents.openMergetool(B);
  await toolRan();
  await agents.poll();
  assert.deepEqual(agents.get(B).merging, { unresolved: 0 });
});

test('Abort restores the branch as it was before the merge', async () => {
  const { agents, b, toolRan, B } = await setupManualMerge();
  const before = git(b.worktree, 'rev-parse', 'HEAD');
  await agents.merge(B);
  await toolRan();
  await agents.abortMerge(B);
  assert.equal(mergeHead(b.worktree), null);
  assert.equal(git(b.worktree, 'rev-parse', 'HEAD'), before);
  assert.equal(git(b.worktree, 'status', '--porcelain'), '');
  assert.equal(agents.get(B).merging, null);
  assert.deepEqual(agents.get(B).conflict, { files: ['shared.txt'] }, 'the conflict is still there');
});

test('a clean merge is committed and leaves the agent state alone', async () => {
  const { repo, cli, agents, b, B, ticketB } = await setupManualMerge();
  // An agent that replied without committing anything since.
  await agents.resume(B, ticketB, 'Any questions?');
  cli.set(agents.get(B).bgId, { status: 'idle', state: 'done' });
  await agents.poll();
  assert.equal(agents.get(B).state, 'idle');
  // The reference branch moves on after the poll found the conflict: A's work is undone on main.
  git(repo, 'revert', '--no-edit', 'HEAD');
  const before = git(b.worktree, 'rev-parse', 'HEAD');
  assert.deepEqual(await agents.merge(B), { clean: true });
  assert.equal(mergeHead(b.worktree), null);
  assert.equal(git(b.worktree, 'rev-parse', 'HEAD^1'), before);
  assert.equal(git(b.worktree, 'rev-parse', 'HEAD^2'), git(repo, 'rev-parse', 'main'));
  await agents.poll();
  assert.equal(agents.get(B).state, 'idle', 'the merge commit is not the agent\'s work');
});

test('merging by hand is refused with uncommitted changes, without a conflict, mid-merge, or while the agent is busy', async () => {
  const { cli, agents, b, toolRan, B } = await setupManualMerge();
  fs.writeFileSync(path.join(b.worktree, 'shared.txt'), 'edited\n');
  await assert.rejects(agents.merge(B), /uncommitted changes/i);
  assert.equal(mergeHead(b.worktree), null);
  git(b.worktree, 'checkout', 'shared.txt');

  cli.set('bg1', { status: 'idle', state: 'done' });
  await agents.poll();
  await assert.rejects(agents.merge(ID), /no merge conflict/i);
  await assert.rejects(agents.finishMerge(B), /no merge in progress/i);
  await assert.rejects(agents.abortMerge(B), /no merge in progress/i);

  await agents.merge(B);
  await toolRan();
  await assert.rejects(agents.merge(B), /already in progress/i);

  cli.set('bg2', { status: 'busy', state: 'running' });
  await agents.poll();
  await assert.rejects(agents.abortMerge(B), /agent is running/i);
  await assert.rejects(agents.finishMerge(B), /agent is running/i);
});

test('a merge started outside the board shows as in progress on the next poll', async () => {
  const { agents, b, B, changes } = await setupManualMerge();
  assert.equal(agents.get(B).merging, null);
  try { git(b.worktree, 'merge', '--no-edit', 'main'); } catch { /* conflicts */ }
  changes.length = 0;
  await agents.poll();
  assert.deepEqual(agents.get(B).merging, { unresolved: 1 });
  assert.deepEqual(changes, [B], 'tells the board');
});

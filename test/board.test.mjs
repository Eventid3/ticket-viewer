import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createBoard, BOARD_HEADER } from '../lib/board.mjs';
import { projectsConfig } from '../lib/projects.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const commit = (cwd, msg) => {
  fs.appendFileSync(path.join(cwd, 'work.txt'), `${msg}\n`);
  git(cwd, 'add', 'work.txt');
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg);
};

// Stands in for the `claude` CLI, shared by every project's agents.
function fakeCli() {
  const cli = {
    calls: [], sessions: [], next: 1, lists: 0, held: null, failWith: null,
    async background(args, cwd) {
      if (cli.failWith) throw new Error(cli.failWith);
      // While `held` is an array, each call waits there until released, so its agent stays starting.
      if (cli.held) await new Promise(r => cli.held.push(r));
      const id = `bg${cli.next++}`;
      cli.calls.push({ args, cwd, id });
      cli.sessions.push({ id, sessionId: `session-${id}`, cwd, kind: 'background', status: 'busy' });
      return id;
    },
    async list() { cli.lists++; return cli.sessions; },
    async stop(id) { cli.set(id, { status: undefined, state: 'stopped' }); },
    set(id, fields) { Object.assign(cli.sessions.find(s => s.id === id), fields); },
  };
  return cli;
}

// `<root>/<name>/.scratch/feat/issues/01-a.md` with status `status`, optionally a git repo; returns the repo folder.
function makeRepo(root, name, { status = 'ready-for-agent', gitRepo = false } = {}) {
  const dir = path.join(root, name);
  const issues = path.join(dir, '.scratch', 'feat', 'issues');
  fs.mkdirSync(issues, { recursive: true });
  fs.writeFileSync(path.join(issues, '01-a.md'), `# 01: A\n\nStatus: ${status}\n`);
  if (gitRepo) {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  }
  return dir;
}

const status = (dir, file = '01-a.md') => fs.readFileSync(path.join(dir, '.scratch', 'feat', 'issues', file), 'utf8').match(/Status: (\S+)/)[1];

async function setup({ projects = [] } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'board-')));
  const config = projectsConfig(path.join(root, 'config', 'projects.json'));
  for (const dir of projects.map(f => f(root))) config.add(path.join(dir, '.scratch'));
  const cli = fakeCli();
  const board = createBoard({
    config, cli, pollMs: 0, watch: false, warn: () => {},
    agentOptions: { processes: null, claudeHome: path.join(root, 'claude-home') },
  });
  await new Promise(r => board.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${board.server.address().port}`;
  const get = async url => { const res = await fetch(base + url); return { status: res.status, headers: res.headers, body: await res.json() }; };
  const send = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const post = (url, body) => send('POST', url, body);
  return { root, config, cli, board, base, get, post, send };
}

test('GET /api/projects marks the board and lists projects with display names and availability', async t => {
  const s = await setup({ projects: [r => makeRepo(r, 'shop'), r => makeRepo(r, 'blog')] });
  t.after(() => s.board.close());
  const { status: code, headers, body } = await s.get('/api/projects');
  assert.equal(code, 200);
  assert.equal(headers.get(BOARD_HEADER), '1');
  assert.deepEqual(body.projects.map(p => [p.id, p.name, p.available]), [['blog', 'blog', true], ['shop', 'shop', true]]);
  assert.deepEqual(Object.keys(body.options).sort(), ['claude', 'difftool', 'lanes', 'permissionMode']);
});

test('with no projects remembered the list is empty', async t => {
  const s = await setup();
  t.after(() => s.board.close());
  assert.deepEqual((await s.get('/api/projects')).body.projects, []);
});

test('GET /api/tickets routes by project id; a missing or unknown id is a 4xx', async t => {
  const s = await setup({ projects: [r => makeRepo(r, 'shop', { status: 'needs-triage' }), r => makeRepo(r, 'blog', { status: 'resolved' })] });
  t.after(() => s.board.close());
  const shop = await s.get('/api/tickets?project=shop');
  assert.equal(shop.status, 200);
  assert.equal(shop.body.project, 'shop');
  assert.equal(shop.body.features[0].tickets[0].status, 'needs-triage');
  assert.equal(shop.body.features[0].tickets[0].path, '.scratch/feat/issues/01-a.md', 'paths are relative to that project\'s repo root');
  assert.equal((await s.get('/api/tickets?project=blog')).body.features[0].tickets[0].status, 'resolved');
  assert.equal(shop.body.features[0].completed, false, 'a feature with open work is not completed');
  assert.equal((await s.get('/api/tickets?project=blog')).body.features[0].completed, true, 'every ticket done: completed');

  assert.equal((await s.get('/api/tickets')).status, 400);
  const unknown = await s.get('/api/tickets?project=nope');
  assert.equal(unknown.status, 404);
  assert.match(unknown.body.error, /Unknown project: nope/);
  assert.equal((await s.get('/api/agent?project=nope&id=feat/01-a.md')).status, 404);
  assert.equal((await s.post('/api/move', { project: 'nope', id: 'feat/01-a.md', to: 'resolved' })).status, 404);
  assert.equal((await s.post('/api/move', { id: 'feat/01-a.md', to: 'resolved' })).status, 400);
});

test('moves change only the named project\'s ticket', async t => {
  let shop, blog;
  const s = await setup({ projects: [r => (shop = makeRepo(r, 'shop', { status: 'ready-for-review' })), r => (blog = makeRepo(r, 'blog', { status: 'ready-for-review' }))] });
  t.after(() => s.board.close());
  const res = await s.post('/api/move', { project: 'blog', id: 'feat/01-a.md', to: 'resolved' });
  assert.equal(res.status, 200);
  assert.equal(status(blog), 'resolved');
  assert.equal(status(shop), 'ready-for-review');
});

test('POST /api/projects adds a repo root, .scratch or feature folder once, and returns the feature for a feature folder', async t => {
  const s = await setup();
  t.after(() => s.board.close());
  const dir = makeRepo(s.root, 'shop');
  const first = await s.post('/api/projects', { path: dir });
  assert.equal(first.status, 200);
  assert.equal(first.body.project.id, 'shop');
  assert.equal(first.body.project.available, true);
  assert.equal(first.body.feature, null);
  const again = await s.post('/api/projects', { path: path.join(dir, '.scratch', 'feat') });
  assert.equal(again.body.project.id, 'shop');
  assert.equal(again.body.feature, 'feat');
  assert.equal(s.config.list().length, 1);
  assert.equal((await s.get('/api/tickets?project=shop')).status, 200);
});

test('POST /api/projects expands ~ and reports validation errors as 400', async t => {
  const s = await setup();
  t.after(() => s.board.close());
  const missing = await s.post('/api/projects', { path: path.join(s.root, 'gone') });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /Not a folder/);
  assert.equal((await s.post('/api/projects', { path: 'relative/dir' })).status, 400);
  assert.equal((await s.post('/api/projects', { path: '' })).status, 400);
  const home = await s.post('/api/projects', { path: '~/definitely-not-a-ticket-viewer-folder-xyz' });
  assert.equal(home.status, 400);
  assert.match(home.body.error, new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(s.config.list(), []);
});

test('POST /api/projects refuses a git worktree of another repo, naming the repo', async t => {
  const s = await setup();
  t.after(() => s.board.close());
  const dir = makeRepo(s.root, 'shop', { gitRepo: true });
  git(dir, 'add', '.');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'tickets');
  const wt = path.join(s.root, 'shop-wt');
  git(dir, 'worktree', 'add', '-q', wt);
  const res = await s.post('/api/projects', { path: wt });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, `This folder is a worktree of ${dir}; add the repo instead`);
});

test('DELETE /api/projects/<id> forgets the project without touching its files; an unknown id is 404', async t => {
  let dir;
  const s = await setup({ projects: [r => (dir = makeRepo(r, 'shop'))] });
  t.after(() => s.board.close());
  assert.equal((await s.send('DELETE', '/api/projects/shop')).status, 200);
  assert.deepEqual(s.config.list(), []);
  assert.ok(fs.existsSync(path.join(dir, '.scratch', 'feat', 'issues', '01-a.md')));
  assert.equal((await s.get('/api/tickets?project=shop')).status, 404);
  assert.equal((await s.send('DELETE', '/api/projects/shop')).status, 404);
});

test('a cross-origin DELETE is refused', async t => {
  const s = await setup({ projects: [r => makeRepo(r, 'shop')] });
  t.after(() => s.board.close());
  const res = await fetch(`${s.base}/api/projects/shop`, { method: 'DELETE', headers: { Origin: 'http://evil.example' } });
  assert.equal(res.status, 403);
  assert.equal(s.config.list().length, 1);
});

test('a project whose folder is gone is unavailable with a reason, and comes back without a restart', async t => {
  let dir;
  const s = await setup({ projects: [r => (dir = makeRepo(r, 'shop')), r => makeRepo(r, 'blog')] });
  t.after(() => s.board.close());
  fs.renameSync(dir, `${dir}-away`);
  const list = (await s.get('/api/projects')).body.projects;
  assert.deepEqual(list.map(p => [p.id, p.available]), [['blog', true], ['shop', false]], 'unavailable projects come last');
  assert.match(list[1].reason, /Not a folder/);
  const res = await s.get('/api/tickets?project=shop');
  assert.equal(res.status, 409);
  assert.match(res.body.error, /unavailable/);

  fs.renameSync(`${dir}-away`, dir);
  assert.equal((await s.get('/api/tickets?project=shop')).status, 200, 'selecting it rechecks it');
});

test('a project that is missing at startup does not break the board, and the poll picks it up once it is back', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'board-')));
  const config = projectsConfig(path.join(root, 'projects.json'));
  config.add(path.join(root, 'later', '.scratch'));
  const board = createBoard({ config, cli: fakeCli(), pollMs: 0, watch: false, warn: () => {}, agentOptions: { processes: null } });
  t.after(() => board.close());
  assert.deepEqual(board.projects().map(p => [p.id, p.available]), [['later', false]]);
  makeRepo(root, 'later');
  await board.pollAll();
  assert.deepEqual(board.projects().map(p => [p.id, p.available]), [['later', true]]);
});

test('agents work per project, and one finishing in another project moves its ticket to ready-for-review', async t => {
  let shop, blog;
  const s = await setup({ projects: [r => (shop = makeRepo(r, 'shop', { gitRepo: true })), r => (blog = makeRepo(r, 'blog', { gitRepo: true }))] });
  t.after(() => s.board.close());
  assert.equal((await s.post('/api/agent/start', { project: 'shop', id: 'feat/01-a.md' })).status, 200);
  assert.equal((await s.post('/api/agent/start', { project: 'blog', id: 'feat/01-a.md' })).status, 200);
  assert.equal(s.cli.calls[0].cwd, path.join(shop, '.claude', 'worktrees', 'ticket-feat--01-a'));
  assert.equal(s.cli.calls[1].cwd, path.join(blog, '.claude', 'worktrees', 'ticket-feat--01-a'));
  assert.equal((await s.get('/api/tickets?project=shop')).body.agents['feat/01-a.md'].bgId, 'bg1');
  assert.equal((await s.get('/api/tickets?project=blog')).body.agents['feat/01-a.md'].bgId, 'bg2');
  assert.equal((await s.get('/api/projects')).body.projects.find(p => p.id === 'blog').running, 1);

  commit(s.cli.calls[1].cwd, 'blog work');
  s.cli.set('bg2', { status: 'idle' });
  s.cli.lists = 0;
  await s.board.pollAll();
  assert.equal(s.cli.lists, 1, 'one `claude agents` for every project');
  assert.equal(status(blog), 'ready-for-review');
  assert.equal(status(shop), 'claimed');
});

test('sending a ticket in review back with notes adds them to ## Comments, resumes the session with them and keeps them on the agent record', async t => {
  let shop;
  const s = await setup({ projects: [r => (shop = makeRepo(r, 'shop', { gitRepo: true }))] });
  t.after(() => s.board.close());
  const id = 'feat/01-a.md';
  assert.equal((await s.post('/api/agent/start', { project: 'shop', id })).status, 200);
  commit(s.cli.calls[0].cwd, 'work');
  s.cli.set('bg1', { status: 'idle' });
  await s.board.pollAll();
  assert.equal(status(shop), 'ready-for-review');

  assert.equal((await s.post('/api/move', { project: 'shop', id, to: 'claimed', notes: 'Rename the flag' })).status, 200);
  assert.equal(status(shop), 'claimed');
  assert.match(fs.readFileSync(path.join(shop, '.scratch', 'feat', 'issues', id.split('/')[1]), 'utf8'), /## Comments[\s\S]*Rename the flag/);
  assert.deepEqual(s.cli.calls[1].args.slice(0, 2), ['--resume', 'session-bg1']);
  assert.match(s.cli.calls[1].args[2], /^Review feedback on your work[\s\S]*Rename the flag/);
  assert.equal((await s.get(`/api/agent?project=shop&id=${encodeURIComponent(id)}`)).body.record.reviewNotes, 'Rename the flag');
});

test('the project list counts each available project\'s tickets to review and agents that need you', async t => {
  let blog;
  const s = await setup({ projects: [r => makeRepo(r, 'shop', { status: 'needs-triage', gitRepo: true }), r => (blog = makeRepo(r, 'blog', { status: 'ready-for-review', gitRepo: true }))] });
  t.after(() => s.board.close());
  const issues = path.join(blog, '.scratch', 'feat', 'issues');
  fs.writeFileSync(path.join(issues, '02-b.md'), '# 02: B\n\nStatus: ready-for-review\n');
  for (const f of ['03-c.md', '04-d.md']) fs.writeFileSync(path.join(issues, f), `# ${f}\n\nStatus: ready-for-agent\n`);
  const counts = async () => Object.fromEntries((await s.get('/api/projects')).body.projects.map(p => [p.id, [p.review, p.needsYou]]));
  assert.deepEqual(await counts(), { blog: [2, 0], shop: [0, 0] });

  // 03 waits on a prompt; 04 ends its turn without committing, then is sent to review: it counts once, as review.
  assert.equal((await s.post('/api/agent/start', { project: 'blog', id: 'feat/03-c.md' })).status, 200);
  assert.equal((await s.post('/api/agent/start', { project: 'blog', id: 'feat/04-d.md' })).status, 200);
  s.cli.set('bg1', { status: 'waiting', waitingFor: 'permission' });
  s.cli.set('bg2', { status: 'idle' });
  await s.board.pollAll();
  assert.deepEqual(await counts(), { blog: [2, 2], shop: [0, 0] });
  fs.writeFileSync(path.join(issues, '04-d.md'), '# 04\n\nStatus: ready-for-review\n');
  assert.deepEqual(await counts(), { blog: [3, 1], shop: [0, 0] });

  fs.writeFileSync(path.join(issues, '02-b.md'), '# 02: B\n\nStatus: resolved\n');
  assert.deepEqual(await counts(), { blog: [2, 1], shop: [0, 0] }, 'counts are the current state, read when the list is asked for');
});

test('unavailable projects carry no counts', async t => {
  let dir;
  const s = await setup({ projects: [r => (dir = makeRepo(r, 'shop', { status: 'ready-for-review' }))] });
  t.after(() => s.board.close());
  assert.equal((await s.get('/api/projects')).body.projects[0].review, 1);
  fs.renameSync(dir, `${dir}-away`);
  const [shop] = (await s.get('/api/projects')).body.projects;
  assert.equal(shop.available, false);
  assert.equal('review' in shop || 'needsYou' in shop, false);
});

test('a second start while the first agent is still starting is refused', async t => {
  const s = await setup({ projects: [r => makeRepo(r, 'shop', { gitRepo: true })] });
  t.after(() => s.board.close());
  s.cli.held = [];
  const first = s.post('/api/agent/start', { project: 'shop', id: 'feat/01-a.md' });
  while (!s.cli.held.length) await new Promise(r => setTimeout(r, 5));
  const second = s.post('/api/agent/start', { project: 'shop', id: 'feat/01-a.md' });
  await new Promise(r => setTimeout(r, 50));
  s.cli.held.forEach(release => release());
  s.cli.held = null;
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 409);
  assert.equal(s.cli.calls.length, 1);
});

test('every ticket action route refuses with the ticket action\'s reason', async t => {
  const s = await setup({ projects: [r => makeRepo(r, 'shop', { status: 'claimed', gitRepo: true })] });
  t.after(() => s.board.close());
  const id = 'feat/01-a.md';
  const refusals = [
    ['/api/move', { to: 'wontfix' }, /use \/triage/],
    ['/api/agent/start', {}, /not ready-for-agent/],
    ['/api/agent/stop', {}, /No agent session/],
    ['/api/agent/resolve-conflicts', {}, /No merge conflict/],
    ['/api/agent/merge', {}, /No merge conflict/],
    ['/api/agent/merge/finish', {}, /No merge in progress/],
    ['/api/agent/merge/abort', {}, /No merge in progress/],
    ['/api/agent/merge/meld', {}, /No merge in progress/],
  ];
  for (const [route, body, why] of refusals) {
    const res = await s.post(route, { project: 'shop', id, ...body });
    assert.equal(res.status, 409, route);
    assert.match(res.body.error, why, route);
  }
  assert.equal((await s.post('/api/agent/start', { project: 'shop', id: 'feat/99-none.md' })).status, 404);
});

test('tickets carry their ticket actions, with the reason a route refuses them', async t => {
  const s = await setup({ projects: [r => makeRepo(r, 'shop', { gitRepo: true })] });
  t.after(() => s.board.close());
  s.cli.held = [];
  const starting = s.post('/api/agent/start', { project: 'shop', id: 'feat/01-a.md' });
  while (!s.cli.held.length) await new Promise(r => setTimeout(r, 5));
  const [ticket] = (await s.get('/api/tickets?project=shop')).body.features[0].tickets;
  assert.equal(ticket.status, 'claimed');
  assert.deepEqual(ticket.actions.moves['ready-for-agent'], { ok: false, why: 'Stop the agent first' });
  const res = await s.post('/api/move', { project: 'shop', id: 'feat/01-a.md', to: 'ready-for-agent' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, ticket.actions.moves['ready-for-agent'].why);
  s.cli.held.forEach(release => release());
  s.cli.held = null;
  await starting;
});

test('a project that is not a git repo has no agents, and starting one says why', async t => {
  const s = await setup({ projects: [r => makeRepo(r, 'shop')] });
  t.after(() => s.board.close());
  assert.equal((await s.get('/api/tickets?project=shop')).body.agents, null);
  const res = await s.post('/api/agent/start', { project: 'shop', id: 'feat/01-a.md' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /git repository/);
});

test('change events carry the project id; project list changes send a projects event', async t => {
  const s = await setup({ projects: [r => makeRepo(r, 'shop', { gitRepo: true })] });
  t.after(() => s.board.close());
  const controller = new AbortController();
  t.after(() => controller.abort());
  const res = await fetch(`${s.base}/api/events`, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const until = async pattern => {
    while (!pattern.test(text)) text += decoder.decode((await reader.read()).value);
  };
  await until(/connected/);
  await s.post('/api/agent/start', { project: 'shop', id: 'feat/01-a.md' });
  await until(/event: change/);
  assert.match(text, /event: change\ndata: \{"project":"shop"\}/);
  await s.post('/api/projects', { path: makeRepo(s.root, 'blog') });
  await until(/event: projects/);
  assert.match(text, /event: projects\ndata: \{\}/);
});

test('requests under a name other than a loopback one are refused, so DNS rebinding reads and changes nothing', async t => {
  const s = await setup({ projects: [r => makeRepo(r, 'shop')] });
  t.after(() => s.board.close());
  const { port } = s.board.server.address();
  const statusFor = host => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/projects', headers: { Host: host } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(await statusFor('evil.example:80'), 403);
  assert.equal(await statusFor(`localhost:${port}`), 200);
  assert.equal(await statusFor(`multi-project-01.dev.localhost:${port}`), 200);
});

test('POST /api/criterion ticks a criterion in the file, and refuses a stale one without writing', async t => {
  let shop;
  const s = await setup({ projects: [r => (shop = makeRepo(r, 'shop'))] });
  t.after(() => s.board.close());
  const file = path.join(shop, '.scratch', 'feat', 'issues', '01-a.md');
  fs.writeFileSync(file, '# 01: A\n\nStatus: ready-for-agent\n\n- [ ] One\n- [ ] Two\n');

  const res = await s.post('/api/criterion', { project: 'shop', id: 'feat/01-a.md', index: 1, text: 'Two', done: false });
  assert.equal(res.status, 200);
  assert.equal(fs.readFileSync(file, 'utf8'), '# 01: A\n\nStatus: ready-for-agent\n\n- [ ] One\n- [x] Two\n');
  const ticket = (await s.get('/api/tickets?project=shop')).body.features[0].tickets[0];
  assert.deepEqual(ticket.checks, { done: 1, total: 2 });

  // Someone inserts a criterion above: the page's row 1 is now "One".
  fs.writeFileSync(file, '# 01: A\n\nStatus: ready-for-agent\n\n- [ ] Zero\n- [ ] One\n- [x] Two\n');
  const before = fs.readFileSync(file, 'utf8');
  const stale = await s.post('/api/criterion', { project: 'shop', id: 'feat/01-a.md', index: 1, text: 'Two', done: true });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /changed/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);

  assert.equal((await s.post('/api/criterion', { project: 'shop', id: 'feat/nope.md', index: 0, text: 'One', done: false })).status, 404);
  assert.equal((await s.post('/api/criterion', { project: 'shop', id: 'feat/01-a.md', index: 'x', text: 'One', done: false })).status, 400);
});

test('tasks: listed apart from the features, with their own lanes, no actions, and Plan items ticked like criteria', async t => {
  const s = await setup({ projects: [r => makeRepo(r, 'shop', { gitRepo: true })] });
  t.after(() => s.board.close());
  const tasks = path.join(s.root, 'shop', '.scratch', 'tasks');
  fs.mkdirSync(path.join(tasks, 'issues'), { recursive: true });
  const file = path.join(tasks, '01-a.md');
  fs.writeFileSync(file, '# 01: A\n\nStatus: ready-for-review\n\n## Description\n\nDo it.\n\n## Plan\n\n- [ ] One\n');

  const body = (await s.get('/api/tickets?project=shop')).body;
  assert.deepEqual(body.features.map(f => f.name), ['feat'], 'tasks/ is not a feature');
  assert.equal(body.tasks.name, 'tasks');
  assert.deepEqual(body.tasks.lanes, ['drafting', 'plan-review', 'implementing', 'ready-for-review', 'resolved', 'wontfix']);
  const [task] = body.tasks.tickets;
  assert.equal(task.id, 'tasks/01-a.md');
  assert.deepEqual(task.actions.moves, {});
  assert.equal(task.actions.start, undefined);
  assert.equal(task.blocked, false);

  const tick = await s.post('/api/criterion', { project: 'shop', id: task.id, index: 0, text: 'One', done: false });
  assert.equal(tick.status, 200);
  assert.match(fs.readFileSync(file, 'utf8'), /- \[x\] One/);

  // Tasks in ready-for-review count in the project alerts.
  const shop = (await s.get('/api/projects')).body.projects.find(p => p.id === 'shop');
  assert.equal(shop.review, 1);
});

test('a repo root without .scratch can be added and shows an empty Tasks entry', async t => {
  const s = await setup();
  t.after(() => s.board.close());
  const dir = path.join(s.root, 'fresh');
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  const added = await s.post('/api/projects', { path: dir });
  assert.equal(added.status, 200);
  assert.equal(added.body.project.available, true);
  const body = (await s.get(`/api/tickets?project=${added.body.project.id}`)).body;
  assert.deepEqual(body.features, []);
  assert.deepEqual(body.tasks.tickets, []);
});

test('POST /api/task/create writes the next task file in drafting, with its branch, worktree and a /task session', async t => {
  let shop;
  const s = await setup({ projects: [r => (shop = makeRepo(r, 'shop', { gitRepo: true }))] });
  t.after(() => s.board.close());
  const create = body => s.post('/api/task/create', { project: 'shop', ...body });
  const tasks = path.join(shop, '.scratch', 'tasks');

  const first = await create({ description: 'Add a dark mode toggle to the settings page', title: '' });
  assert.equal(first.status, 200);
  assert.equal(first.body.id, 'tasks/01-add-a-dark-mode-toggle-to.md');
  const text = fs.readFileSync(path.join(tasks, '01-add-a-dark-mode-toggle-to.md'), 'utf8');
  assert.match(text, /^Status: drafting$/m);
  assert.match(text, /## Description\n\nAdd a dark mode toggle to the settings page/);

  const worktree = path.join(shop, '.claude', 'worktrees', 'task-01-add-a-dark-mode-toggle-to');
  assert.equal(git(worktree, 'branch', '--show-current'), 'task/01-add-a-dark-mode-toggle-to');
  const [call] = s.cli.calls;
  assert.equal(call.cwd, worktree);
  assert.equal(call.args[0].split('\n')[0], `/task ${path.join(tasks, '01-add-a-dark-mode-toggle-to.md')}`);
  assert.match(call.args[0], /task-01\.dev\.localhost/);
  assert.equal(call.args[call.args.indexOf('-n') + 1], 'task 01-add-a-dark-mode-toggle-to');
  assert.ok(!call.args.includes('--model'), 'no model is pinned');

  // The same title twice makes two files; the first is not overwritten. The reference branch is recorded.
  assert.equal((await create({ description: 'one', title: 'Same' })).body.id, 'tasks/02-same.md');
  assert.equal((await create({ description: 'two', title: 'Same' })).body.id, 'tasks/03-same.md');
  assert.match(fs.readFileSync(path.join(tasks, '02-same.md'), 'utf8'), /one/);
  const { body } = await s.get('/api/tickets?project=shop');
  assert.equal(body.agents['tasks/01-add-a-dark-mode-toggle-to.md'].ref, 'main');
  assert.equal(body.agents['tasks/01-add-a-dark-mode-toggle-to.md'].hostname, 'task-01.dev.localhost');
  assert.equal(body.tasks.tickets.length, 3);
});

test('a task whose agent cannot start leaves no file, branch, worktree or record behind', async t => {
  let shop;
  const s = await setup({ projects: [r => (shop = makeRepo(r, 'shop', { gitRepo: true }))] });
  t.after(() => s.board.close());
  s.cli.failWith = 'claude is not logged in';
  const res = await s.post('/api/task/create', { project: 'shop', description: 'Do it', title: 'Do it' });
  assert.equal(res.status, 500);
  assert.match(res.body.error, /claude is not logged in/);
  assert.deepEqual(fs.readdirSync(path.join(shop, '.scratch', 'tasks')), []);
  assert.equal(git(shop, 'branch', '--list', 'task/*'), '');
  assert.equal(git(shop, 'worktree', 'list').split('\n').length, 1);
  assert.deepEqual((await s.get('/api/tickets?project=shop')).body.agents, {});
});

test('creating a task needs a description and a git repository', async t => {
  const s = await setup({ projects: [r => makeRepo(r, 'shop', { gitRepo: true }), r => makeRepo(r, 'plain')] });
  t.after(() => s.board.close());
  assert.equal((await s.post('/api/task/create', { project: 'shop', description: '  ' })).status, 400);
  const plain = await s.post('/api/task/create', { project: 'plain', description: 'x' });
  assert.equal(plain.status, 400);
  assert.match(plain.body.error, /git repository/);
});

test('a task whose agent asked a question stays in drafting, waits for a reply and needs you', async t => {
  const s = await setup({ projects: [r => makeRepo(r, 'shop', { gitRepo: true }), r => makeRepo(r, 'blog', { gitRepo: true })] });
  t.after(() => s.board.close());
  const { body: { id } } = await s.post('/api/task/create', { project: 'shop', description: 'Do it' });
  // The agent's transcript ends with the question marker.
  const home = path.join(s.root, 'claude-home', 'projects', 'p');
  fs.mkdirSync(home, { recursive: true });
  const ev = text => JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { content: [{ type: 'text', text }] } });
  fs.writeFileSync(path.join(home, 'session-bg1.jsonl'), `${ev('Which page?\n\n[[turn: question]]')}\n`);
  s.cli.set('bg1', { status: 'idle' });
  await s.board.pollAll();
  const shop = (await s.get('/api/tickets?project=shop')).body;
  assert.equal(shop.agents[id].state, 'idle');
  assert.equal(shop.agents[id].asked, true);
  const task = shop.tasks.tickets[0];
  assert.equal(task.status, 'drafting');
  assert.equal(task.needsYou, true);
  assert.equal((await s.get('/api/projects')).body.projects.find(p => p.id === 'shop').needsYou, 1);
});

test('POST /api/agent/reply resumes an asking agent with the answer, keeps the task in drafting and refuses empty or untimely replies', async t => {
  const s = await setup({ projects: [r => makeRepo(r, 'shop', { gitRepo: true })] });
  t.after(() => s.board.close());
  const { body: { id } } = await s.post('/api/task/create', { project: 'shop', description: 'Do it' });
  const reply = message => s.post('/api/agent/reply', { project: 'shop', id, message });

  const early = await reply('Yes');
  assert.equal(early.status, 409, 'the agent is still starting');
  assert.match(early.body.error, /busy/);

  const home = path.join(s.root, 'claude-home', 'projects', 'p');
  fs.mkdirSync(home, { recursive: true });
  const ev = text => JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { content: [{ type: 'text', text }] } });
  fs.writeFileSync(path.join(home, 'session-bg1.jsonl'), `${ev('Which page?\n\n[[turn: question]]')}\n`);
  s.cli.set('bg1', { status: 'idle' });
  await s.board.pollAll();
  assert.ok((await s.get('/api/tickets?project=shop')).body.tasks.tickets[0].actions.reply.ok);

  for (const message of [undefined, '', '   ']) {
    const empty = await reply(message);
    assert.equal(empty.status, 400);
    assert.match(empty.body.error, /reply/);
  }
  assert.equal(s.cli.calls.length, 1, 'nothing was started');

  assert.equal((await reply('The settings page')).status, 200);
  const call = s.cli.calls[1];
  assert.deepEqual(call.args.slice(0, 2), ['--resume', 'session-bg1']);
  assert.match(call.args[2], /The settings page/);
  assert.match(call.args[2], /## Questions/);
  assert.match(call.args[2], /\[\[turn: done\]\]/, 'the turn note is appended as on every resume');
  assert.match(call.args[2], /task-01\.dev\.localhost/, 'and the browser note');
  const { body } = await s.get('/api/tickets?project=shop');
  assert.equal(body.tasks.tickets[0].status, 'drafting');
  assert.ok(['starting', 'running'].includes(body.agents[id].state), 'the agent is running again');
  assert.equal(body.tasks.tickets[0].actions.reply, undefined, 'the reply box is gone while the agent works');
  assert.equal((await reply('again')).status, 409);
});

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
    calls: [], sessions: [], next: 1, lists: 0, held: null,
    async background(args, cwd) {
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

// The board's HTTP server: one page and API for every remembered project, picked by project id.
// Each available project has a registry entry with its features, its agents (one createAgents per repo) and its file watcher.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFeatures, loadFeature, setStatus, appendComment } from './tickets.mjs';
import { createAgents, claudeCli } from './agents.mjs';
import { resolveProject, expandPath } from './projects.mjs';
import { isBusy, needsYou, resumes, ticketActions, refusal } from './ticket-actions.mjs';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
export const DEFAULT_LANES = ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'claimed', 'ready-for-review', 'resolved', 'wontfix'];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
// Sent with GET /api/projects, so a second `ticket-viewer` can tell a running board from anything else on the port.
export const BOARD_HEADER = 'x-ticket-viewer';
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|(.+\.)?localhost)$/;

class HttpError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * `claude agents --json` once for every project polling at the same moment: concurrent calls share one run.
 * Sessions of every repo are in that one list, so each project's agents pick out their own.
 */
function sharedList(cli) {
  let pending = null;
  return {
    ...cli,
    list() {
      pending ||= cli.list().finally(() => { pending = null; });
      return pending;
    },
  };
}

/**
 * @param {object} opts
 * @param {ReturnType<import('./projects.mjs').projectsConfig>} opts.config  The remembered projects.
 * @param {string[]} [opts.lanes]
 * @param {string} [opts.claude]  Claude Code executable, shown to a second `ticket-viewer` that hands off.
 * @param {string} [opts.permissionMode]
 * @param {string} [opts.difftool]
 * @param {ReturnType<typeof claudeCli>} [opts.cli]
 * @param {ReturnType<import('./codemap.mjs').createCodemap>} [opts.codemap]  Null hides the structure diff.
 * @param {object} [opts.agentOptions]  More createAgents options for every project (tests: processes, claudeHome).
 * @param {number} [opts.pollMs]  How often agents are polled and unavailable projects rechecked; 0 turns the timer off.
 * @param {boolean} [opts.watch]  Watch each project's files for live reload.
 * @param {(message: string) => void} [opts.warn]
 */
export function createBoard({
  config, lanes = DEFAULT_LANES, claude = 'claude', permissionMode = 'auto', difftool = 'meld',
  cli = claudeCli(claude), codemap = null, agentOptions = {}, pollMs = 3000, watch = true, warn = console.warn,
}) {
  const agentCli = sharedList(cli);

  // --- project registry ----------------------------------------------------------------
  /** @type {Map<string, {id: string, path: string, name: string, available: boolean, reason: string|null, features: any[], agents: any, watcher: any}>} */
  const registry = new Map();

  // Brings the registry in line with the config file: new projects are opened, forgotten ones closed.
  function sync() {
    const list = config.list();
    for (const [id, p] of registry) if (!list.some(x => x.id === id)) { close(p); registry.delete(id); }
    for (const { id, path: scratchRoot, name } of list) {
      const p = registry.get(id);
      if (p && p.path === scratchRoot) { p.name = name; continue; }
      if (p) close(p);
      const entry = { id, path: scratchRoot, name, available: false, reason: null, features: [], agents: null, watcher: null };
      registry.set(id, entry);
      check(entry);
    }
  }

  // Opens a project the first time its folder checks out, and closes it when the folder is gone.
  // Returns whether its availability changed.
  function check(p) {
    let features;
    try { features = resolveFeatures(p.path).features; }
    catch (e) {
      const changed = p.available;
      if (p.available) close(p);
      p.reason = e.message;
      return changed;
    }
    p.features = features;
    if (p.available) return false;
    try { open(p); } catch (e) { close(p); p.reason = e.message; return false; }
    return true;
  }

  function open(p) {
    // A poll already under way when the project is removed (or reopened) must not move its tickets any more.
    const live = () => p.agents === agents && registry.get(p.id) === p;
    const agents = createAgents({
      scratchRoot: p.path, cli: agentCli, permissionMode, difftool, ...agentOptions,
      // Snapshot the base while the agent works, so opening its structure diff later is fast.
      onWorktree: codemap ? (worktree, base) => codemap.warmUp(worktree, base) : undefined,
      onChange: (id, record) => {
        // Committed work and a finished turn hand the ticket to you; any other state keeps it claimed.
        // This runs for every project, not just the one on screen.
        if (!live()) return;
        if (record.state === 'done' && ticketStatus(p, id) === 'claimed') writeStatus(p, id, 'ready-for-review');
        notifyChange(p.id);
      },
      onProcesses: () => notifyChange(p.id),
      onConflicts: () => notifyChange(p.id),
      // Work that is done or dropped has nothing left to merge.
      checkConflicts: id => ['claimed', 'ready-for-review'].includes(ticketStatus(p, id)),
    });
    p.agents = agents;
    if (watch) {
      try {
        p.watcher = fs.watch(p.path, { recursive: true }, (_evt, name) => { if (!name || name.endsWith('.md')) notifyChange(p.id); });
        // The folder going away (or similar) mustn't take the board down; the next check marks the project unavailable.
        p.watcher.on('error', () => {});
      } catch (e) {
        warn(`File watching unavailable for ${p.path} (${e.message}); refresh the page manually.`);
      }
    }
    p.available = true;
    p.reason = null;
  }

  // Stops watching and polling; nothing on disk is touched, and agent sessions keep running.
  function close(p) {
    p.watcher?.close();
    Object.assign(p, { available: false, agents: null, watcher: null });
  }

  // An available project also carries its project alert counts: tickets in ready-for-review, and agents that need you.
  function summary(p) {
    const base = { id: p.id, name: p.name, path: p.path, available: p.available, reason: p.reason };
    if (!p.available) return { ...base, running: 0 };
    const agents = p.agents ? p.agents.all() : {};
    const tickets = p.features.flatMap(f => loadFeature(f));
    return {
      ...base,
      running: Object.values(agents).filter(isBusy).length,
      review: tickets.filter(t => t.status === 'ready-for-review').length,
      needsYou: tickets.filter(t => needsYou(t, agents[t.id])).length,
    };
  }

  // Available projects by name, then the unavailable ones.
  function projectList() {
    return [...registry.values()].map(summary)
      .sort((a, b) => Number(b.available) - Number(a.available) || a.name.localeCompare(b.name));
  }

  /** The project a request names: 400 without one, 404 for an unknown id, 409 while it is unavailable. */
  function projectFor(id) {
    if (!id) throw new HttpError(400, 'Missing project');
    const p = registry.get(String(id));
    if (!p) throw new HttpError(404, `Unknown project: ${id}`);
    if (!p.available && check(p)) notifyProjects();
    if (!p.available) throw new HttpError(409, `Project ${p.name} is unavailable: ${p.reason}`);
    return p;
  }

  // One poll of every project's agents, plus a recheck of every project, so a folder that comes back shows up.
  async function pollAll() {
    let changed = false;
    for (const p of registry.values()) changed = check(p) || changed;
    if (changed) notifyProjects();
    await Promise.all([...registry.values()].filter(p => p.agents).map(p => {
      const agents = p.agents;
      return agents.poll().catch(e => warn(`Could not read agent sessions for ${p.name}: ${e.message}`));
    }));
  }

  // --- tickets of one project -----------------------------------------------------------
  function snapshot(p) {
    // Re-resolve so features created while running show up.
    try { p.features = resolveFeatures(p.path).features; } catch { /* keep last good list */ }
    const agents = p.agents ? p.agents.all() : null;
    const project = { agents: !!p.agents };
    return {
      project: p.id,
      root: p.path,
      lanes,
      features: p.features.map(f => ({
        name: f.name,
        tickets: loadFeature(f).map(t => ({ ...t, needsYou: needsYou(t, agents?.[t.id]), actions: ticketActions(t, agents?.[t.id] ?? null, project) })),
      })),
      agents,
      codemap: !!codemap,
    };
  }

  function findTicketPath(p, id) {
    const [featureName, file] = String(id).split('/');
    const feat = p.features.find(f => f.name === featureName);
    if (!feat || !file || file !== path.basename(file) || !file.endsWith('.md')) return null;
    const f = path.join(feat.issuesDir, file);
    return fs.existsSync(f) ? f : null;
  }

  function findTicket(p, id) {
    const feat = p.features.find(f => f.name === String(id).split('/')[0]);
    return feat && loadFeature(feat).find(t => t.id === id);
  }

  function ticketStatus(p, id) { return findTicket(p, id)?.status ?? null; }

  function writeStatus(p, id, status) {
    const file = findTicketPath(p, id);
    fs.writeFileSync(file, setStatus(fs.readFileSync(file, 'utf8'), status));
  }

  /** The ticket's agent worktree and review base (the merge-base with its reference branch), for codemap. */
  function reviewTarget(p, id) {
    if (!codemap) throw new HttpError(400, 'codemap is not installed');
    const r = p.agents?.get(id);
    if (!r?.worktree || !fs.existsSync(r.worktree)) throw new HttpError(404, 'No worktree for this ticket');
    return { worktree: r.worktree, base: p.agents.reviewBase(id) };
  }

  function addNotes(p, id, notes) {
    if (!notes || typeof notes !== 'string') return;
    const file = findTicketPath(p, id);
    fs.writeFileSync(file, appendComment(fs.readFileSync(file, 'utf8'), notes));
  }

  /**
   * Claims ticket `t` and gets an agent working on it: a new session for a fresh ticket,
   * or the ticket's existing session (full history) with `message` when there is one.
   */
  async function startAgent(p, t, message) {
    const { agents } = p;
    await claimWhile(p, t, file => {
      // start() moves the worktree of a record from before background sessions into place.
      if (resumes(agents.get(t.id))) return agents.resume(t.id, file, message || 'Continue implementing the ticket. Re-read it first; it may have new review comments.');
      return agents.start(t.id, file);
    });
  }

  // Merging the reference branch by hand in the ticket's worktree; the ticket stays in its lane.
  const mergeByHand = (action, run) => ({
    action: () => action, agents: true,
    run: async (p, { id }) => {
      try { return (await run(p.agents, id)) || {}; } catch (e) { throw new HttpError(409, e.message); }
      finally { notifyChange(p.id); }
    },
  });

  // The project's agents, when ticket `id` has an agent record.
  function agentsFor(p, id) {
    if (!p.agents?.get(id)) throw new HttpError(404, 'No agent for this ticket');
    return p.agents;
  }

  /**
   * POST routes on one project's ticket. `run(project, body, ticket)` gives extra response fields.
   * A route with `action` is a ticket action (see ticket-actions.mjs): `action(body)` names it, and the request
   * is refused with its reason unless it is allowed. `agents`: the route needs a project that can run agents.
   */
  const POST_ACTIONS = {
    '/api/move': { action: ({ to }) => `moves.${to}`, run: (p, { to, notes }, t) => move(p, t, to, notes) },
    '/api/agent/start': { action: () => 'start', agents: true, run: (p, _body, t) => startAgent(p, t) },
    // A fixed prompt rather than review notes, so nothing is added to the ticket's ## Comments.
    '/api/agent/resolve-conflicts': {
      action: () => 'resolveConflicts', agents: true,
      run: (p, _body, t) => claimWhile(p, t, file => p.agents.resolveConflicts(t.id, file)),
    },
    '/api/agent/stop': { action: () => 'stop', agents: true, run: async (p, { id }) => { await p.agents.stop(id); } },
    '/api/agent/merge': mergeByHand('mergeByHand', (agents, id) => agents.merge(id)),
    '/api/agent/merge/finish': mergeByHand('finishMerge', (agents, id) => agents.finishMerge(id)),
    '/api/agent/merge/abort': mergeByHand('abortMerge', (agents, id) => agents.abortMerge(id)),
    '/api/agent/merge/meld': mergeByHand('reopenMeld', (agents, id) => agents.openMergetool(id)),
    // `pid` picks one worktree process (its whole group); without it, all of the ticket's are stopped.
    '/api/agent/kill': {
      run: async (p, { id, pid }) => {
        const agents = agentsFor(p, id);
        try { return { stopped: await agents.killProcesses(id, pid) }; } catch (e) { throw new HttpError(409, e.message); }
      },
    },
    '/api/agent/diff': { run: (p, { id }) => { agentsFor(p, id).openDiff(id); } },
    '/api/codemap/view': {
      run: async (p, { id }) => {
        const { worktree, base } = reviewTarget(p, id);
        try { await codemap.view(worktree, base); } catch (e) { throw new HttpError(502, e.message); }
      },
    },
  };

  // Runs POST route `route` for project `p`, refusing a ticket action that isn't allowed.
  function post(route, p, body) {
    if (!route.action) return route.run(p, body);
    if (route.agents && !p.agents) throw new HttpError(400, 'Agents need the project to be a git repository');
    const t = findTicket(p, body.id);
    if (!t) throw new HttpError(404, 'Unknown ticket');
    const why = refusal(t, p.agents?.get(t.id) ?? null, { agents: !!p.agents }, route.action(body));
    if (why) throw new HttpError(409, why);
    return route.run(p, body, t);
  }

  // Moves ticket `t` to claimed while `run(ticketFile)` gets its agent going; moves it back if that fails.
  async function claimWhile(p, t, run) {
    writeStatus(p, t.id, 'claimed');
    notifyChange(p.id);
    try {
      await run(findTicketPath(p, t.id));
    } catch (e) {
      writeStatus(p, t.id, t.status);
      throw new HttpError(500, `Could not start agent: ${e.message}`);
    }
  }

  async function move(p, t, to, notes) {
    const { id } = t;
    const { agents } = p;
    addNotes(p, id, notes);
    if (to === 'claimed') {
      const message = t.status === 'ready-for-review' && notes
        ? `Review feedback on your work (also added to the ticket's ## Comments):\n\n${notes}\n\nAddress it, commit, and end your turn.`
        : undefined;
      return startAgent(p, t, message);
    }
    writeStatus(p, id, to);
    // Approving ends the session; its conversation is kept, so `claude attach` still opens it.
    if (to === 'resolved' && agents?.get(id)?.bgId && agents.get(id).state !== 'stopped') await agents.stop(id).catch(() => {});
    // Approving or handing the ticket back also stops the servers left running in its worktree.
    // Moving to ready-for-review doesn't, so you can still click through the running app while reviewing.
    // killProcesses scans afresh, so a server started since the last poll is stopped too.
    if (['resolved', 'ready-for-agent'].includes(to) && agents) return { stopped: await agents.killProcesses(id).catch(() => 0) };
    return {};
  }

  // --- live reload via server-sent events -----------------------------------------------
  // One stream for every project: `change` names the project whose tickets changed, `projects` means the list did.
  const clients = new Set();
  const pending = new Set();
  let reloadTimer = null;
  function notifyChange(projectId) {
    pending.add(projectId);
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      for (const id of pending) broadcast('change', { project: id });
      pending.clear();
    }, 150);
  }
  function notifyProjects() { broadcast('projects', {}); }
  function broadcast(event, data) {
    for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // --- HTTP ------------------------------------------------------------------------------
  function send(res, code, body, type = 'application/json', headers = {}) {
    res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', ...headers });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', c => { data += c; if (data.length > 1e5) { reject(new HttpError(413, 'Request too large')); req.destroy(); } });
      req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
      req.on('error', reject);
    });
  }

  function addProject(input) {
    if (typeof input !== 'string' || !input.trim()) throw new HttpError(400, 'Enter the path of a project folder');
    let resolved;
    try { resolved = resolveProject(expandPath(input)); } catch (e) { throw new HttpError(400, e.message); }
    const { project, added } = config.add(resolved.scratchRoot);
    sync();
    if (added) notifyProjects();
    return { project: summary(registry.get(project.id)), feature: resolved.feature, added };
  }

  const options = { lanes, claude, permissionMode, difftool };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const q = name => url.searchParams.get(name);
    // Only answer under a loopback name, so a site that points its own name at 127.0.0.1 (DNS rebinding)
    // can't read paths or change anything. Browsers resolve every *.localhost name to loopback themselves.
    const hostname = new URL(`http://${req.headers.host || 'x'}`).hostname;
    if (!LOOPBACK_HOST.test(hostname)) return send(res, 403, { error: 'Unexpected Host' });
    try {
      if (req.method === 'GET' && url.pathname === '/api/projects') {
        sync();
        if ([...registry.values()].map(check).some(Boolean)) notifyProjects();
        return send(res, 200, { projects: projectList(), options }, 'application/json', { [BOARD_HEADER]: '1' });
      }

      if (req.method === 'GET' && url.pathname === '/api/tickets') return send(res, 200, snapshot(projectFor(q('project'))));

      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(': connected\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/agent') {
        const p = projectFor(q('project'));
        const id = q('id');
        const agents = agentsFor(p, id);
        return send(res, 200, { record: agents.get(id), ...agents.activity(id), changes: agents.changes(id) });
      }

      if (req.method === 'GET' && url.pathname === '/api/codemap/summary') {
        const { worktree, base } = reviewTarget(projectFor(q('project')), q('id'));
        try { return send(res, 200, await codemap.summary(worktree, base)); }
        catch (e) { throw new HttpError(502, e.message); }
      }

      if (req.method === 'POST' || req.method === 'DELETE') {
        // Only accept requests from our own page, so other sites can't change tickets, start agents or edit the project list.
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'Cross-origin request refused' });
      }

      if (req.method === 'DELETE' && url.pathname.startsWith('/api/projects/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/projects/'.length));
        // Only forgets the project: its files, worktrees and agent sessions stay; adding it back picks them up.
        if (!config.remove(id)) throw new HttpError(404, `Unknown project: ${id}`);
        sync();
        notifyProjects();
        return send(res, 200, { ok: true });
      }

      if (req.method === 'POST') {
        if (!String(req.headers['content-type']).startsWith('application/json')) return send(res, 415, { error: 'Expected JSON' });
        const body = await readBody(req);
        if (url.pathname === '/api/projects') return send(res, 200, addProject(body.path));
        const route = POST_ACTIONS[url.pathname];
        if (!route) return send(res, 404, { error: 'Not found' });
        return send(res, 200, { ok: true, ...await post(route, projectFor(body.project), body) });
      }

      if (req.method === 'GET') {
        const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const file = path.join(PUBLIC_DIR, rel);
        if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file)) return send(res, 404, 'Not found', 'text/plain');
        return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
      }

      send(res, 405, { error: 'Method not allowed' });
    } catch (e) {
      send(res, e instanceof HttpError ? e.code : 500, { error: e.message });
    }
  });

  sync();

  // Polling can notify the page, so it starts once live reload is set up.
  let pollTimer = null;
  let stopped = false;
  if (pollMs > 0) {
    const loop = () => pollAll().finally(() => { if (!stopped) pollTimer = setTimeout(loop, pollMs); });
    loop();
  }

  return {
    server,
    /** Every project as the page sees it: available ones by name, then the unavailable ones. */
    projects: projectList,
    pollAll,
    /** Stops polling and watching, and closes the server and its event streams. */
    close() {
      stopped = true;
      clearTimeout(pollTimer);
      clearTimeout(reloadTimer);
      for (const p of registry.values()) close(p);
      for (const res of clients) res.end();
      server.close();
    },
  };
}

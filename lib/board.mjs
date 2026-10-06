// The board's HTTP server: one page and API for every remembered project, picked by project id.
// Each available project has a registry entry with its features, its agents (one createAgents per repo) and its file watcher.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFeatures, loadFeature, setStatus, appendComment } from './tickets.mjs';
import { createAgents, claudeCli } from './agents.mjs';
import { resolveProject, expandPath } from './projects.mjs';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
export const DEFAULT_LANES = ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'claimed', 'ready-for-review', 'resolved', 'wontfix'];
// The only status changes the board makes itself. Everything else goes through /triage.
// ready-for-agent -> claimed starts an agent; the agent committing and ending its turn moves claimed -> ready-for-review.
// ready-for-review -> claimed sends your review notes back into the agent's session.
const MOVES = {
  'ready-for-agent': ['claimed'],
  'claimed': ['ready-for-agent'], // only while no agent is running
  'ready-for-review': ['resolved', 'claimed', 'ready-for-agent'],
};
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
// Sent with GET /api/projects, so a second `ticket-viewer` can tell a running board from anything else on the port.
export const BOARD_HEADER = 'x-ticket-viewer';
const BUSY = ['starting', 'running', 'waiting'];

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
    p.agents = createAgents({
      scratchRoot: p.path, cli: agentCli, permissionMode, difftool, ...agentOptions,
      // Snapshot the base while the agent works, so opening its structure diff later is fast.
      onWorktree: codemap ? (worktree, base) => codemap.warmUp(worktree, base) : undefined,
      onChange: (id, record) => {
        // Committed work and a finished turn hand the ticket to you; any other state keeps it claimed.
        // This runs for every project, not just the one on screen.
        if (record.state === 'done' && ticketStatus(p, id) === 'claimed') writeStatus(p, id, 'ready-for-review');
        notifyChange(p.id);
      },
      onProcesses: () => notifyChange(p.id),
      onConflicts: () => notifyChange(p.id),
      // Work that is done or dropped has nothing left to merge.
      checkConflicts: id => ['claimed', 'ready-for-review'].includes(ticketStatus(p, id)),
    });
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

  function summary(p) {
    const running = p.agents ? Object.values(p.agents.all()).filter(r => BUSY.includes(r.state)).length : 0;
    return { id: p.id, name: p.name, path: p.path, available: p.available, reason: p.reason, running };
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
    return {
      project: p.id,
      root: p.path,
      lanes,
      features: p.features.map(f => ({ name: f.name, tickets: loadFeature(f) })),
      moves: MOVES,
      agents: p.agents ? p.agents.all() : null,
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
   * Claims the ticket and gets an agent working on it: a new session for a fresh ticket,
   * or the ticket's existing session (full history) with `message` when there is one.
   */
  async function startAgent(p, id, message) {
    const t = agentTicket(p, id, ['ready-for-agent', 'claimed', 'ready-for-review'], 'ready-for-agent');
    if (t.blocked) throw new HttpError(409, `Blocked by ${t.openBlockers.join(', ')}`);
    const { agents } = p;
    await claimWhile(p, t, file => {
      // Records from before background sessions (no bgId) start over; start() moves their worktree into place.
      if (agents.get(id)?.bgId && agents.get(id).sessionId) return agents.resume(id, file, message || 'Continue implementing the ticket. Re-read it first; it may have new review comments.');
      return agents.start(id, file);
    });
  }

  /**
   * Claims the ticket and has its agent merge the reference branch and resolve the merge conflict:
   * a fixed prompt rather than review notes, so nothing is added to the ticket's ## Comments.
   */
  async function resolveConflicts(p, id) {
    // No blocker check: the ticket's work exists already, and merging its reference branch doesn't depend on blockers.
    const t = agentTicket(p, id, ['claimed', 'ready-for-review'], 'claimed or ready-for-review');
    if (!p.agents.get(id)?.conflict) throw new HttpError(409, 'No merge conflict to resolve');
    const { agents } = p;
    await claimWhile(p, t, file => agents.resolveConflicts(id, file));
  }

  // Merging the reference branch by hand in the ticket's worktree; the ticket stays in its lane.
  const MERGE_ACTIONS = {
    '/api/agent/merge': (agents, id) => agents.merge(id),
    '/api/agent/merge/finish': (agents, id) => agents.finishMerge(id),
    '/api/agent/merge/abort': (agents, id) => agents.abortMerge(id),
    '/api/agent/merge/meld': (agents, id) => agents.openMergetool(id),
  };

  async function mergeByHand(p, action, id) {
    if (!p.agents?.get(id)) throw new HttpError(404, 'No agent for this ticket');
    try { return (await action(p.agents, id)) || {}; } catch (e) { throw new HttpError(409, e.message); }
    finally { notifyChange(p.id); }
  }

  // The ticket, when it is in one of `statuses` and no agent is working on it.
  function agentTicket(p, id, statuses, expected) {
    if (!p.agents) throw new HttpError(400, 'Agents need the project to be a git repository');
    const t = findTicket(p, id);
    if (!t) throw new HttpError(404, 'Unknown ticket');
    if (!statuses.includes(t.status)) throw new HttpError(409, `Ticket is ${t.status || 'without status'}, not ${expected}`);
    if (p.agents.busy(id)) throw new HttpError(409, 'An agent is already working on this ticket');
    return t;
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

  async function move(p, id, to, notes) {
    const from = ticketStatus(p, id);
    if (!findTicketPath(p, id)) throw new HttpError(404, 'Unknown ticket');
    if (!(MOVES[from] || []).includes(to)) throw new HttpError(409, `Can't move ${from || 'no status'} → ${to} here; use /triage`);
    const { agents } = p;
    if (from === 'claimed' && agents?.busy(id)) throw new HttpError(409, 'Stop the agent first');
    addNotes(p, id, notes);
    if (to === 'claimed') {
      const message = from === 'ready-for-review' && notes
        ? `Review feedback on your work (also added to the ticket's ## Comments):\n\n${notes}\n\nAddress it, commit, and end your turn.`
        : undefined;
      return startAgent(p, id, message);
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
      req.on('data', c => { data += c; if (data.length > 1e5) req.destroy(); });
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
        const record = p.agents?.get(id);
        if (!record) return send(res, 404, { error: 'No agent for this ticket' });
        return send(res, 200, { record, ...p.agents.activity(id), changes: p.agents.changes(id) });
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
        const { id, to, notes, pid } = body;
        const known = ['/api/move', '/api/agent/start', '/api/agent/resolve-conflicts', '/api/agent/stop', '/api/agent/kill', '/api/agent/diff', '/api/codemap/view'];
        if (!known.includes(url.pathname) && !MERGE_ACTIONS[url.pathname]) return send(res, 404, { error: 'Not found' });
        const p = projectFor(body.project);
        if (url.pathname === '/api/move') return send(res, 200, { ok: true, ...await move(p, id, to, notes) });
        else if (url.pathname === '/api/agent/start') await startAgent(p, id);
        else if (url.pathname === '/api/agent/resolve-conflicts') await resolveConflicts(p, id);
        else if (MERGE_ACTIONS[url.pathname]) return send(res, 200, { ok: true, ...await mergeByHand(p, MERGE_ACTIONS[url.pathname], id) });
        else if (url.pathname === '/api/agent/stop') { if (!(await p.agents?.stop(id))) throw new HttpError(409, 'No agent session'); }
        else if (url.pathname === '/api/agent/kill') {
          if (!p.agents?.get(id)) throw new HttpError(404, 'No agent for this ticket');
          // `pid` picks one worktree process (its whole group); without it, all of the ticket's are stopped.
          try { return send(res, 200, { ok: true, stopped: await p.agents.killProcesses(id, pid) }); }
          catch (e) { throw new HttpError(409, e.message); }
        }
        else if (url.pathname === '/api/agent/diff') { if (!p.agents?.get(id)) throw new HttpError(404, 'No agent for this ticket'); p.agents.openDiff(id); }
        else if (url.pathname === '/api/codemap/view') {
          const { worktree, base } = reviewTarget(p, id);
          try { await codemap.view(worktree, base); } catch (e) { throw new HttpError(502, e.message); }
        }
        return send(res, 200, { ok: true });
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

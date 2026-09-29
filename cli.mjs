#!/usr/bin/env node
// Local kanban viewer for .scratch/<feature>/issues/*.md tickets.
// Usage: node tools/ticket-viewer/cli.mjs <project-folder> [options]; see --help.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveFeatures, loadFeature, setStatus, appendComment } from './lib/tickets.mjs';
import { createAgents, claudeCli } from './lib/agents.mjs';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const DEFAULT_LANES = ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'claimed', 'ready-for-review', 'resolved', 'wontfix'];
// The only status changes the board makes itself. Everything else goes through /triage.
// ready-for-agent -> claimed starts an agent; the agent committing and ending its turn moves claimed -> ready-for-review.
// ready-for-review -> claimed sends your review notes back into the agent's session.
const MOVES = {
  'ready-for-agent': ['claimed'],
  'claimed': ['ready-for-agent'], // only while no agent is running
  'ready-for-review': ['resolved', 'claimed', 'ready-for-agent'],
};
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const USAGE = `Usage: ticket-viewer <project-folder> [options]

<project-folder>  Repo root (containing .scratch/), a .scratch folder, or one feature folder.

Options:
  -p, --port <n>             Port to listen on (default 4777; the next free port is used if taken)
      --lanes <list>         Comma-separated lane order (default ${DEFAULT_LANES.join(',')})
      --no-open              Don't open a browser
      --claude <cmd>         Claude Code executable for background agents (default claude)
      --permission-mode <m>  Permission mode for background agents (default acceptEdits)
      --difftool <tool>      git difftool used to review a ticket's changes (default meld)
  -h, --help                 Show this help`;

function parseArgs(argv) {
  const opts = { dir: null, port: 4777, open: true, lanes: DEFAULT_LANES, claude: 'claude', permissionMode: 'acceptEdits', difftool: 'meld' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else if (a === '-p' || a === '--port') opts.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) opts.port = Number(a.slice(7));
    else if (a === '--lanes') opts.lanes = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a.startsWith('--lanes=')) opts.lanes = a.slice(8).split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--no-open') opts.open = false;
    else if (a === '--claude') opts.claude = argv[++i];
    else if (a === '--permission-mode') opts.permissionMode = argv[++i];
    else if (a === '--difftool') opts.difftool = argv[++i];
    else if (a.startsWith('-')) fail(`Unknown option: ${a}`);
    else if (!opts.dir) opts.dir = a;
    else fail(`Unexpected argument: ${a}`);
  }
  if (!opts.dir) fail('Missing <project-folder>');
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) fail('Invalid --port');
  return opts;
}

function fail(msg) {
  console.error(`${msg}\n\n${USAGE}`);
  process.exit(1);
}

const opts = parseArgs(process.argv.slice(2));
let project;
try { project = resolveFeatures(opts.dir); } catch (e) { console.error(e.message); process.exit(1); }

const agents = createAgents({
  scratchRoot: project.scratchRoot, cli: claudeCli(opts.claude), permissionMode: opts.permissionMode, difftool: opts.difftool,
  onChange: (id, record) => {
    // Committed work and a finished turn hand the ticket to you; any other state keeps it claimed.
    if (record.state === 'done' && ticketStatus(id) === 'claimed') writeStatus(id, 'ready-for-review');
    notifyChange();
  },
});
if (agents) {
  const poll = () => agents.poll().catch(e => console.warn(`Could not read agent sessions: ${e.message}`)).finally(() => setTimeout(poll, 3000));
  poll();
}

function snapshot() {
  // Re-resolve so features created while running show up.
  try { project = resolveFeatures(opts.dir); } catch { /* keep last good list */ }
  return {
    root: project.scratchRoot,
    lanes: opts.lanes,
    features: project.features.map(f => ({ name: f.name, tickets: loadFeature(f) })),
    moves: MOVES,
    agents: agents ? agents.all() : null,
  };
}

function findTicketPath(id) {
  const [featureName, file] = String(id).split('/');
  const feat = project.features.find(f => f.name === featureName);
  if (!feat || !file || file !== path.basename(file) || !file.endsWith('.md')) return null;
  const p = path.join(feat.issuesDir, file);
  return fs.existsSync(p) ? p : null;
}

function findTicket(id) {
  const feat = project.features.find(f => f.name === String(id).split('/')[0]);
  return feat && loadFeature(feat).find(t => t.id === id);
}

function ticketStatus(id) { return findTicket(id)?.status ?? null; }

function writeStatus(id, status) {
  const file = findTicketPath(id);
  fs.writeFileSync(file, setStatus(fs.readFileSync(file, 'utf8'), status));
}

class HttpError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function addNotes(id, notes) {
  if (!notes || typeof notes !== 'string') return;
  const file = findTicketPath(id);
  fs.writeFileSync(file, appendComment(fs.readFileSync(file, 'utf8'), notes));
}

/**
 * Claims the ticket and gets an agent working on it: a new session for a fresh ticket,
 * or the ticket's existing session (full history) with `message` when there is one.
 */
async function startAgent(id, message) {
  if (!agents) throw new HttpError(400, 'Agents need the project to be a git repository');
  const t = findTicket(id);
  if (!t) throw new HttpError(404, 'Unknown ticket');
  if (!['ready-for-agent', 'claimed', 'ready-for-review'].includes(t.status)) throw new HttpError(409, `Ticket is ${t.status || 'without status'}, not ready-for-agent`);
  if (t.blocked) throw new HttpError(409, `Blocked by ${t.openBlockers.join(', ')}`);
  if (agents.busy(id)) throw new HttpError(409, 'An agent is already working on this ticket');
  const file = findTicketPath(id);
  writeStatus(id, 'claimed');
  notifyChange();
  try {
    // Records from before background sessions (no bgId) start over; start() moves their worktree into place.
    if (agents.get(id)?.bgId && agents.get(id).sessionId) await agents.resume(id, file, message || 'Continue implementing the ticket. Re-read it first; it may have new review comments.');
    else await agents.start(id, file);
  } catch (e) {
    writeStatus(id, t.status);
    throw new HttpError(500, `Could not start agent: ${e.message}`);
  }
}

async function move(id, to, notes) {
  const from = ticketStatus(id);
  if (!findTicketPath(id)) throw new HttpError(404, 'Unknown ticket');
  if (!(MOVES[from] || []).includes(to)) throw new HttpError(409, `Can't move ${from || 'no status'} → ${to} here; use /triage`);
  if (from === 'claimed' && agents?.busy(id)) throw new HttpError(409, 'Stop the agent first');
  addNotes(id, notes);
  if (to === 'claimed') {
    const message = from === 'ready-for-review' && notes
      ? `Review feedback on your work (also added to the ticket's ## Comments):\n\n${notes}\n\nAddress it, commit, and end your turn.`
      : undefined;
    return startAgent(id, message);
  }
  writeStatus(id, to);
  // Approving ends the session; its conversation is kept, so `claude attach` still opens it.
  if (to === 'resolved' && agents?.get(id)?.bgId && agents.get(id).state !== 'stopped') await agents.stop(id).catch(() => {});
}

// --- live reload via server-sent events -------------------------------------------------
const clients = new Set();
let reloadTimer = null;
function notifyChange() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => { for (const res of clients) res.write('event: change\ndata: {}\n\n'); }, 150);
}
try {
  fs.watch(project.scratchRoot, { recursive: true }, (_evt, name) => {
    if (!name || name.endsWith('.md')) notifyChange();
  });
} catch (e) {
  console.warn(`File watching unavailable (${e.message}); refresh the page manually.`);
}

// --- HTTP --------------------------------------------------------------------------------
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/api/tickets') return send(res, 200, snapshot());

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/agent') {
      const id = url.searchParams.get('id');
      const record = agents?.get(id);
      if (!record) return send(res, 404, { error: 'No agent for this ticket' });
      return send(res, 200, { record, ...agents.activity(id), changes: agents.changes(id) });
    }

    if (req.method === 'POST') {
      // Only accept JSON from our own page, so other sites can't change tickets or start agents.
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'Cross-origin request refused' });
      if (!String(req.headers['content-type']).startsWith('application/json')) return send(res, 415, { error: 'Expected JSON' });
      const { id, to, notes } = await readBody(req);
      if (url.pathname === '/api/move') await move(id, to, notes);
      else if (url.pathname === '/api/agent/start') await startAgent(id);
      else if (url.pathname === '/api/agent/stop') { if (!(await agents?.stop(id))) throw new HttpError(409, 'No agent session'); }
      else if (url.pathname === '/api/agent/diff') { if (!agents?.get(id)) throw new HttpError(404, 'No agent for this ticket'); agents.openDiff(id); }
      else return send(res, 404, { error: 'Not found' });
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

function listen(port, attemptsLeft) {
  server.once('error', err => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) return listen(port + 1, attemptsLeft - 1);
    console.error(err.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}/`;
    const names = project.features.map(f => f.name).join(', ');
    const agentLine = agents ? `agents: ${opts.claude} --bg (${opts.permissionMode}), worktrees in ${path.join(agents.repoRoot, '.claude', 'worktrees')}` : 'agents: off (not a git repo)';
    console.log(`Ticket viewer for ${project.scratchRoot}\n  features: ${names}\n  ${agentLine}\n  ${url}\n(Ctrl+C to stop; agents keep running as Claude Code background sessions)`);
    if (opts.open) openBrowser(url);
  });
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch { /* no browser available; the URL is printed */ }
}

listen(opts.port, 10);

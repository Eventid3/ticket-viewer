#!/usr/bin/env node
// Local kanban viewer for .scratch/<feature>/issues/*.md tickets.
// Usage: node tools/ticket-viewer/cli.mjs <project-folder> [--port 4777] [--no-open] [--lanes a,b,c]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveFeatures, loadFeature, setStatus, isValidStatus } from './lib/tickets.mjs';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const DEFAULT_LANES = ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'claimed', 'resolved', 'wontfix'];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const USAGE = `Usage: ticket-viewer <project-folder> [options]

<project-folder>  Repo root (containing .scratch/), a .scratch folder, or one feature folder.

Options:
  -p, --port <n>     Port to listen on (default 4777; the next free port is used if taken)
      --lanes <list> Comma-separated lane order (default ${DEFAULT_LANES.join(',')})
      --no-open      Don't open a browser
  -h, --help         Show this help`;

function parseArgs(argv) {
  const opts = { dir: null, port: 4777, open: true, lanes: DEFAULT_LANES };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else if (a === '-p' || a === '--port') opts.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) opts.port = Number(a.slice(7));
    else if (a === '--lanes') opts.lanes = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a.startsWith('--lanes=')) opts.lanes = a.slice(8).split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--no-open') opts.open = false;
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

function snapshot() {
  // Re-resolve so features created while running show up.
  try { project = resolveFeatures(opts.dir); } catch { /* keep last good list */ }
  return {
    root: project.scratchRoot,
    lanes: opts.lanes,
    features: project.features.map(f => ({ name: f.name, tickets: loadFeature(f) })),
  };
}

function findTicketPath(id) {
  const [featureName, file] = String(id).split('/');
  const feat = project.features.find(f => f.name === featureName);
  if (!feat || !file || file !== path.basename(file) || !file.endsWith('.md')) return null;
  const p = path.join(feat.issuesDir, file);
  return fs.existsSync(p) ? p : null;
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

    if (req.method === 'POST' && url.pathname === '/api/status') {
      // Only accept requests from our own page, so other sites can't rewrite tickets.
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'Cross-origin request refused' });
      const { id, status } = await readBody(req);
      if (!isValidStatus(status)) return send(res, 400, { error: 'Invalid status' });
      const file = findTicketPath(id);
      if (!file) return send(res, 404, { error: 'Unknown ticket' });
      fs.writeFileSync(file, setStatus(fs.readFileSync(file, 'utf8'), status));
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
    send(res, 500, { error: e.message });
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
    console.log(`Ticket viewer for ${project.scratchRoot}\n  features: ${names}\n  ${url}\n(Ctrl+C to stop)`);
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

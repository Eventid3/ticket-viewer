#!/usr/bin/env node
// Local kanban viewer for .scratch/<feature>/issues/*.md tickets, one board for every remembered project.
// Usage: node tools/ticket-viewer/cli.mjs [project-folder] [options]; see --help.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createBoard, DEFAULT_LANES, BOARD_HEADER } from './lib/board.mjs';
import { claudeCli } from './lib/agents.mjs';
import { createCodemap } from './lib/codemap.mjs';
import { projectsConfig, resolveProject, expandPath } from './lib/projects.mjs';

const USAGE = `Usage: ticket-viewer [project-folder] [options]

Starts the board for every remembered project. With [project-folder], adds that project
(remembered in $XDG_CONFIG_HOME/ticket-viewer/projects.json) and opens the board on it.
When a board is already running, hands the folder to it and exits.

[project-folder]  Repo root (containing .scratch/), a .scratch folder, or one feature folder.

Options:
  -p, --port <n>             Port to listen on (default 4777; the next free port is used if taken)
      --lanes <list>         Comma-separated lane order (default ${DEFAULT_LANES.join(',')})
      --no-open              Don't open a browser
      --claude <cmd>         Claude Code executable for background agents (default claude)
      --permission-mode <m>  Permission mode for background agents (default auto)
      --difftool <tool>      git difftool and mergetool for reviewing and merging by hand (default meld)
  -h, --help                 Show this help`;

// The options a running board was started with; a second `ticket-viewer` that hands off can't change them.
const BOARD_OPTIONS = { lanes: '--lanes', claude: '--claude', permissionMode: '--permission-mode', difftool: '--difftool' };

function parseArgs(argv) {
  const opts = { dir: null, port: 4777, open: true, lanes: DEFAULT_LANES, claude: 'claude', permissionMode: 'auto', difftool: 'meld', given: new Set() };
  const set = (key, value) => { opts[key] = value; opts.given.add(key); };
  const lanes = s => s.split(',').map(x => x.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else if (a === '-p' || a === '--port') opts.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) opts.port = Number(a.slice(7));
    else if (a === '--lanes') set('lanes', lanes(argv[++i]));
    else if (a.startsWith('--lanes=')) set('lanes', lanes(a.slice(8)));
    else if (a === '--no-open') opts.open = false;
    else if (a === '--claude') set('claude', argv[++i]);
    else if (a === '--permission-mode') set('permissionMode', argv[++i]);
    else if (a === '--difftool') set('difftool', argv[++i]);
    else if (a.startsWith('-')) fail(`Unknown option: ${a}`);
    else if (!opts.dir) opts.dir = a;
    else fail(`Unexpected argument: ${a}`);
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) fail('Invalid --port');
  return opts;
}

function fail(msg) {
  console.error(`${msg}\n\n${USAGE}`);
  process.exit(1);
}

function exitWith(msg) {
  console.error(msg);
  process.exit(1);
}

/** What answers on `port`: a ticket-viewer board (with its project list and options), nothing ('free'), or something else. */
async function probe(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects`, { signal: AbortSignal.timeout(3000) });
    if (res.headers.get(BOARD_HEADER) !== '1') return { kind: 'other' };
    return { kind: 'board', info: await res.json() };
  } catch (e) {
    return { kind: e.cause?.code === 'ECONNREFUSED' ? 'free' : 'other' };
  }
}

const boardUrl = (port, project, feature) => {
  const hash = new URLSearchParams();
  if (project) hash.set('project', project);
  if (feature) hash.set('feature', feature);
  return `http://localhost:${port}/${project ? `#${hash}` : ''}`;
};

// A board already runs on `port`: give it the folder, point the browser at it, and leave.
async function handOff(opts, port, info) {
  let project = null, feature = null, added = false;
  if (opts.dir) {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: path.resolve(expandPath(opts.dir)) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) exitWith(body.error || `The running board refused the folder (${res.status})`);
    ({ project, feature, added } = body);
  }
  const ignored = [...opts.given].filter(k => JSON.stringify(opts[k]) !== JSON.stringify(info.options?.[k])).map(k => BOARD_OPTIONS[k]);
  if (ignored.length) console.warn(`Warning: the running board keeps its own options; ignored ${ignored.join(', ')}. Stop it and start again to change them.`);
  const url = boardUrl(port, project?.id, feature);
  console.log(!project ? `A board is already running at ${url}`
    : `${added ? 'Added' : 'Opening'} ${project.name} on the board already running at ${url}`);
  if (opts.open) openBrowser(url);
  process.exit(0);
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch { /* no browser available; the URL is printed */ }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = err => { server.off('listening', onListening); reject(err); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

const opts = parseArgs(process.argv.slice(2));

// A board already running on this port (or one of the next ones, when something else held this one) takes over.
let port = null;
for (let p = opts.port; p <= Math.min(opts.port + 10, 65535) && port === null; p++) {
  const found = await probe(p);
  if (found.kind === 'board') await handOff(opts, p, found.info);
  if (found.kind === 'free') port = p;
}
if (port === null) exitWith(`No free port in ${opts.port}–${opts.port + 10}`);

const config = projectsConfig();
let start = null;
try {
  if (opts.dir) {
    const { scratchRoot, feature } = resolveProject(path.resolve(expandPath(opts.dir)));
    start = { project: config.add(scratchRoot).project, feature };
  }
} catch (e) { exitWith(e.message); }

// Structure-diff review; hidden when codemap isn't installed.
const codemap = createCodemap();
let board;
try {
  board = createBoard({
    config, lanes: opts.lanes, claude: opts.claude, permissionMode: opts.permissionMode, difftool: opts.difftool,
    cli: claudeCli(opts.claude), codemap,
  });
} catch (e) { exitWith(e.message); }

// Something may grab the probed port in between; then the next free one is used, as before.
for (let attempts = 10; ; attempts--) {
  try { await listen(board.server, port); break; }
  catch (err) {
    if (err.code !== 'EADDRINUSE' || attempts === 0) exitWith(err.message);
    port++;
  }
}

const url = boardUrl(port, start?.project.id, start?.feature);
const projects = board.projects();
const projectLines = projects.length
  ? projects.map(p => `    ${p.name}: ${p.available ? p.path : `unavailable (${p.reason})`}`).join('\n')
  : '    none yet: use Add project on the board, or run ticket-viewer <project-folder>';
console.log(`Ticket viewer\n  projects (${config.file}):\n${projectLines}
  agents: ${opts.claude} --bg (${opts.permissionMode}), worktrees in <repo>/.claude/worktrees
  ${codemap ? 'structure diff: codemap' : 'structure diff: off (codemap not on PATH)'}
  ${url}
(Ctrl+C to stop; agents keep running as Claude Code background sessions)`);
if (opts.open) openBrowser(url);

// Runs one Claude Code background session (`claude --bg`) per ticket, each in its own git worktree and branch.
// Sessions belong to Claude Code, not to the board: they survive board restarts and you can `claude attach` to them,
// for instance to answer a permission prompt. The board polls `claude agents --json` to follow them.
// Agent records live in <git-common-dir>/ticket-viewer/agents.json, so they are never committed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryGit(cwd, ...args) {
  try { return git(cwd, ...args); } catch { return null; }
}

/** The three `claude` commands the board needs. Swapped for a fake in tests. */
export function claudeCli(claude = 'claude') {
  const run = (args, cwd) => new Promise((resolve, reject) => {
    execFile(claude, args, { cwd, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim().split('\n')[0]));
      else resolve(stdout);
    });
  });
  return {
    /** Starts a background session and returns its short id. */
    async background(args, cwd) {
      const out = await run(['--bg', ...args], cwd);
      const m = out.match(/backgrounded · ([0-9a-f]+)/);
      if (!m) throw new Error(out.trim().split('\n')[0] || 'claude --bg printed no session id');
      return m[1];
    },
    async list() { return JSON.parse(await run(['agents', '--json', '--all'])); },
    async stop(id) { await run(['stop', id]); },
  };
}

// What the board shows for a session, from what `claude agents --json` reports about it.
//   running  the agent is working
//   waiting  the agent needs you (e.g. a permission prompt): attach to answer
//   idle     the agent ended its turn without committing, so it probably asked you something
//   done     the agent ended its turn with new commits: ready for review
//   stopped  the session isn't running (attach to reopen it)
function sessionState(s, hasNewCommits) {
  if (!s || s.state === 'stopped') return 'stopped';
  if (s.status === 'waiting') return 'waiting';
  if (s.status === 'idle' || s.state === 'done') return hasNewCommits() ? 'done' : 'idle';
  return 'running';
}

/**
 * @param {object} opts
 * @param {string} opts.scratchRoot   The .scratch folder; must be inside a git repo.
 * @param {ReturnType<typeof claudeCli>} [opts.cli]
 * @param {string} [opts.permissionMode]
 * @param {string} [opts.difftool]    Tool name passed to `git difftool --tool`.
 * @param {string} [opts.claudeHome]  Where Claude Code keeps session transcripts.
 * @param {(id: string, record: object, previous: string) => void} [opts.onChange]  Called when a session's state changes.
 */
export function createAgents({
  scratchRoot, cli = claudeCli(), permissionMode = 'acceptEdits', difftool = 'meld',
  claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), onChange = () => {},
}) {
  const repoRoot = tryGit(scratchRoot, 'rev-parse', '--show-toplevel');
  if (!repoRoot) return null; // not a git repo: the board works, agents are unavailable
  const commonDir = path.resolve(repoRoot, git(repoRoot, 'rev-parse', '--git-common-dir'));
  const stateDir = path.join(commonDir, 'ticket-viewer');
  const stateFile = path.join(stateDir, 'agents.json');
  // Inside the repo, where Claude Code keeps its own worktrees, so they inherit the repo's workspace trust.
  // (`claude --bg` refuses folders you haven't trusted.)
  const worktreesDir = path.join(repoRoot, '.claude', 'worktrees');
  fs.mkdirSync(stateDir, { recursive: true });

  let records = {};
  try { records = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first run */ }
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(records, null, 2));

  function names(id) {
    const [feature, file] = id.split('/');
    const clean = s => s.replace(/[^\w.-]+/g, '-');
    const stem = clean(file.replace(/\.md$/, ''));
    return { branch: `ticket/${clean(feature)}/${stem}`, worktree: path.join(worktreesDir, `ticket-${clean(feature)}--${stem}`) };
  }

  function ignoreWorktrees() {
    if (tryGit(repoRoot, 'check-ignore', '-q', path.join(worktreesDir, 'x')) !== null) return;
    const exclude = path.join(commonDir, 'info', 'exclude');
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, '\n# ticket-viewer agent worktrees\n/.claude/worktrees/\n');
  }

  // Reuses the ticket's worktree when it's worked on again, so the agent continues on its branch.
  function ensureWorktree(id) {
    const prev = records[id];
    const { branch, worktree } = names(id);
    const base = prev?.base || git(repoRoot, 'rev-parse', 'HEAD');
    fs.mkdirSync(worktreesDir, { recursive: true });
    ignoreWorktrees();
    if (fs.existsSync(worktree)) return { branch, worktree, base };
    if (prev?.worktree && fs.existsSync(prev.worktree)) git(repoRoot, 'worktree', 'move', prev.worktree, worktree); // older layout
    else if (tryGit(repoRoot, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)) git(repoRoot, 'worktree', 'add', worktree, branch);
    else git(repoRoot, 'worktree', 'add', '-b', branch, worktree, base);
    return { branch, worktree, base };
  }

  const sessionArgs = ticketFile => ['-n', `ticket ${path.basename(ticketFile, '.md')}`,
    '--permission-mode', permissionMode, '--add-dir', path.dirname(ticketFile)];

  function prompt(ticketFile, branch) {
    return `/implement ${ticketFile}

You are running as a background session in a dedicated git worktree on branch ${branch}. Work and commit only here.
The ticket file is outside this worktree. Read it and tick its acceptance criteria as you go, but do not change its Status line: the ticket board moves the ticket to ready-for-review once you end your turn with your work committed.`;
  }

  const head = worktree => tryGit(worktree, 'rev-parse', 'HEAD');

  function transcriptPath(sessionId) {
    if (!sessionId) return null;
    const projects = path.join(claudeHome, 'projects');
    let dirs = [];
    try { dirs = fs.readdirSync(projects); } catch { return null; }
    for (const d of dirs) {
      const p = path.join(projects, d, `${sessionId}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  function readTranscript(r) {
    const file = r.transcript && fs.existsSync(r.transcript) ? r.transcript : transcriptPath(r.sessionId);
    if (!file) return [];
    r.transcript = file;
    const out = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type !== 'assistant') continue;
      for (const c of ev.message?.content || []) {
        if (c.type === 'text' && c.text.trim()) out.push({ kind: 'text', text: c.text.trim() });
        if (c.type === 'tool_use') out.push({ kind: 'tool', text: `${c.name} ${toolSummary(c.input)}`.trim() });
      }
    }
    return out;
  }

  function setState(id, state, extra = {}) {
    const r = records[id];
    const previous = r.state;
    Object.assign(r, extra, { state });
    save();
    if (previous !== state) onChange(id, { ...r }, previous);
  }

  async function launch(id, args, worktree) {
    const r = records[id];
    try {
      const bgId = await cli.background(args, worktree);
      Object.assign(r, { bgId, sessionId: null, transcript: null, startHead: head(worktree), error: null });
      setState(id, 'running');
    } catch (e) {
      setState(id, 'failed', { error: e.message });
      throw e;
    }
  }

  const active = r => r.bgId && !['failed'].includes(r.state);

  return {
    repoRoot,

    get(id) { return records[id] ? { ...records[id] } : null; },

    all() { return Object.fromEntries(Object.keys(records).map(id => [id, this.get(id)])); },

    /** True while the session is running or waiting on you, i.e. it could still change the worktree. */
    busy(id) { return ['running', 'waiting'].includes(records[id]?.state); },

    /** Creates the worktree and starts `/implement` in a new background session. */
    async start(id, ticketFile) {
      if (this.busy(id)) throw new Error('An agent is already running for this ticket');
      const { branch, worktree, base } = ensureWorktree(id);
      records[id] = { ...records[id], branch, worktree, base, startedAt: new Date().toISOString(), state: 'starting' };
      save();
      await launch(id, [prompt(ticketFile, branch), ...sessionArgs(ticketFile)], worktree);
      return this.get(id);
    },

    /** Continues the ticket's conversation with `message`, in a background session with its full history. */
    async resume(id, ticketFile, message) {
      const r = records[id];
      if (!r?.sessionId) throw new Error('No session to continue for this ticket');
      if (r.state !== 'stopped') await cli.stop(r.bgId).catch(() => {});
      await launch(id, ['--resume', r.sessionId, message, ...sessionArgs(ticketFile)], r.worktree);
      return this.get(id);
    },

    async stop(id) {
      const r = records[id];
      if (!r?.bgId) return false;
      await cli.stop(r.bgId);
      await this.poll();
      return true;
    },

    /** Refreshes every session's state from `claude agents --json`. Call it on a timer. */
    async poll() {
      const ids = Object.keys(records).filter(id => active(records[id]));
      if (!ids.length) return;
      const sessions = await cli.list();
      for (const id of ids) {
        const r = records[id];
        const s = sessions.find(x => x.id === r.bgId);
        if (s?.sessionId && s.sessionId !== r.sessionId) { r.sessionId = s.sessionId; r.transcript = null; save(); }
        const state = sessionState(s, () => head(r.worktree) !== r.startHead);
        setState(id, state, { waitingFor: state === 'waiting' ? s.waitingFor || 'your input' : null });
      }
    },

    /** Recent things the agent said or did, and the last thing it said. */
    activity(id, limit = 40) {
      const r = records[id];
      if (!r) return { items: [], lastMessage: null };
      const items = readTranscript(r);
      const last = items.findLast(x => x.kind === 'text');
      return { items: items.slice(-limit), lastMessage: last?.text ?? null };
    },

    /** Commits and changed files on the ticket's branch since it was created, including uncommitted work. */
    changes(id) {
      const r = records[id];
      if (!r || !fs.existsSync(r.worktree)) return null;
      return {
        commits: (tryGit(r.worktree, 'log', '--oneline', `${r.base}..HEAD`) || '').split('\n').filter(Boolean),
        stat: tryGit(r.worktree, 'diff', '--stat', r.base) || '',
        dirty: !!tryGit(r.worktree, 'status', '--porcelain'),
      };
    },

    /** Opens the diff between the branch's starting point and the worktree in the configured difftool. */
    openDiff(id) {
      const r = records[id];
      if (!r || !fs.existsSync(r.worktree)) throw new Error('No worktree for this ticket');
      const child = execFile('git', ['difftool', '--dir-diff', `--tool=${difftool}`, '--no-prompt', r.base], { cwd: r.worktree });
      child.on('error', () => {});
      child.unref();
    },
  };
}

function toolSummary(input = {}) {
  const v = input.command ?? input.file_path ?? input.pattern ?? input.path ?? input.description ?? '';
  const s = String(v).replace(/\s+/g, ' ');
  return s.length > 120 ? s.slice(0, 117) + '…' : s;
}

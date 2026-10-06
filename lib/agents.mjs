// Runs one Claude Code background session (`claude --bg`) per ticket, each in its own git worktree and branch.
// Sessions belong to Claude Code, not to the board: they survive board restarts and you can `claude attach` to them,
// for instance to answer a permission prompt. The board polls `claude agents --json` to follow them.
// Agent records live in <git-common-dir>/ticket-viewer/agents.json, so they are never committed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { procProcesses, tlsScheme } from './processes.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryGit(cwd, ...args) {
  try { return git(cwd, ...args); } catch { return null; }
}

const branchSha = (cwd, branch) => tryGit(cwd, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);

/** `{ unresolved: N }` while worktree `cwd` is mid-merge (MERGE_HEAD exists), else null. */
export function mergeState(cwd) {
  if (!tryGit(cwd, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD')) return null;
  const unmerged = tryGit(cwd, 'diff', '--name-only', '--diff-filter=U') || '';
  return { unresolved: new Set(unmerged.split('\n').filter(Boolean)).size };
}

/**
 * Test-merges commit `branch` into commit `ref` without touching any worktree or the index.
 * Returns the conflicting files (none for a clean merge), or null when git can't tell (e.g. git older than 2.38).
 */
export function mergeTree(repoRoot, ref, branch) {
  try {
    git(repoRoot, 'merge-tree', '--write-tree', '--name-only', '--no-messages', ref, branch);
    return { files: [] };
  } catch (e) {
    // Exit code 1 means conflicts: the first line is the merged tree, then one conflicting file per line.
    if (e.status !== 1 || typeof e.stdout !== 'string') return null;
    return { files: [...new Set(e.stdout.trim().split('\n').slice(1).filter(Boolean))] };
  }
}

/**
 * The merge-conflict check of branch `branch` against branch `ref`, cached by the pair of commits they point to,
 * so it only re-runs when either branch moves. Returns null when either branch doesn't exist.
 * `prune()` forgets every pair not looked up since the last prune.
 */
export function conflictCheck(repoRoot, run = mergeTree) {
  let cache = new Map();
  let used = new Map();
  const check = (ref, branch) => {
    const refSha = branchSha(repoRoot, ref);
    const headSha = branchSha(repoRoot, branch);
    if (!refSha || !headSha) return null;
    const key = `${refSha}:${headSha}`;
    if (!cache.has(key)) cache.set(key, run(repoRoot, refSha, headSha));
    used.set(key, cache.get(key));
    return cache.get(key);
  };
  check.prune = () => { cache = used; used = new Map(); };
  return check;
}

/**
 * The ticket's agent hostname, `<feature>-<NN>.dev.localhost`: browsers send every `*.localhost` name to 127.0.0.1
 * and keep separate cookies per name, so agents testing the same app on different ports don't share logins.
 * The first label is a single DNS label (a wildcard certificate only matches one) of at most 63 characters;
 * a long feature name is cut short, the number never is.
 */
export function agentHostname(id) {
  const [feature, file] = id.split('/');
  const dnsLabel = s => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const stem = file.replace(/\.md$/, '');
  const number = (stem.match(/^\d+/)?.[0] || dnsLabel(stem) || 'x').slice(0, 20).replace(/-+$/, '');
  const name = dnsLabel(feature).slice(0, 62 - number.length).replace(/-+$/, '') || 'ticket';
  return `${name}-${number}.dev.localhost`;
}

// What the agent is told about browsing its app, on start and on every resume.
const browserNote = hostname => `When you test the app in a browser, keep its usual scheme and port but open it at ${hostname} instead of localhost (so https://localhost:5001 becomes https://${hostname}:5001), so your login cookies don't collide with other agents testing the same app. If the app rejects that hostname (e.g. a host allowlist answers 400), don't change the app's host configuration: fall back to localhost and mention it in your final message.`;

// What the agent is told to do about a merge conflict with its reference branch.
const conflictPrompt = (ref, files) => `Your branch has a merge conflict with ${ref}, the branch it will be merged into, in:
${files.map(f => `- ${f}`).join('\n')}

Merge ${ref} into your branch with \`git merge ${ref}\` (merge, not rebase: don't rewrite your branch's history), resolve the conflicts in those files keeping the intent of both sides, run the tests, commit the merge, and end your turn.`;

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
 * @param {ReturnType<typeof procProcesses>} [opts.processes]  Finds and kills worktree processes; null turns that off.
 * @param {(port: number) => Promise<'https' | 'http'>} [opts.probeScheme]  Tells whether a listening port speaks TLS.
 * @param {string} [opts.permissionMode]
 * @param {string} [opts.difftool]    Tool name passed to `git difftool --tool` and `git mergetool --tool`.
 * @param {string} [opts.claudeHome]  Where Claude Code keeps session transcripts.
 * @param {(id: string, record: object, previous: string) => void} [opts.onChange]  Called when a session's state changes.
 * @param {(id: string) => void} [opts.onProcesses]  Called when a ticket's worktree processes change.
 * @param {(id: string) => void} [opts.onConflicts]  Called when a ticket's reference branch or merge conflict changes.
 * @param {(id: string) => boolean} [opts.checkConflicts]  Whether the poll checks the ticket for a merge conflict
 *   with its reference branch (e.g. only while it is claimed or in review).
 * @param {(worktree: string, base: string) => void} [opts.onWorktree]  Called on start once the ticket's worktree exists,
 *   before the session starts, e.g. to warm a cache. Its errors are ignored.
 */
export function createAgents({
  scratchRoot, cli = claudeCli(), processes = procProcesses(), probeScheme = tlsScheme, permissionMode = 'auto', difftool = 'meld',
  claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
  onChange = () => {}, onProcesses = () => {}, onWorktree = () => {}, onConflicts = () => {}, checkConflicts = () => true,
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
    // The reference branch: where the ticket's work will be merged. Null on a detached HEAD, and it stays null.
    const ref = prev && 'ref' in prev ? prev.ref : currentBranch();
    fs.mkdirSync(worktreesDir, { recursive: true });
    ignoreWorktrees();
    if (fs.existsSync(worktree)) return { branch, worktree, base, ref };
    if (prev?.worktree && fs.existsSync(prev.worktree)) git(repoRoot, 'worktree', 'move', prev.worktree, worktree); // older layout
    else if (branchSha(repoRoot, branch)) git(repoRoot, 'worktree', 'add', worktree, branch);
    else git(repoRoot, 'worktree', 'add', '-b', branch, worktree, base);
    return { branch, worktree, base, ref };
  }

  const sessionArgs = ticketFile => ['-n', `ticket ${path.basename(ticketFile, '.md')}`,
    '--permission-mode', permissionMode, '--add-dir', path.dirname(ticketFile)];

  // What a new session is told about where it runs, after its task.
  const sessionNote = (id, branch) => `You are running as a background session in a dedicated git worktree on branch ${branch}. Work and commit only here.
The ticket file is outside this worktree. Read it and tick its acceptance criteria as you go, but do not change its Status line: the ticket board moves the ticket to ready-for-review once you end your turn with your work committed.
Stop any servers or background processes you started before you end your turn.
${browserNote(agentHostname(id))}`;

  const prompt = (id, ticketFile, branch) => `/implement ${ticketFile}\n\n${sessionNote(id, branch)}`;

  // Creates (or reuses) the ticket's worktree and starts a new background session there with `task(branch)`.
  async function startSession(id, ticketFile, task) {
    const { branch, worktree, base, ref } = ensureWorktree(id);
    try { onWorktree(worktree, base); } catch { /* optional extra; never blocks the agent */ }
    records[id] = { ...records[id], branch, worktree, base, ref, startedAt: new Date().toISOString(), state: 'starting' };
    save();
    conflictsByTicket[id] = { ref: referenceBranch(records[id]), conflict: conflictsByTicket[id]?.conflict ?? null };
    await launch(id, [task(branch), ...sessionArgs(ticketFile)], worktree);
  }

  const head = worktree => tryGit(worktree, 'rev-parse', 'HEAD');
  const currentBranch = () => tryGit(repoRoot, 'symbolic-ref', '--short', '--quiet', 'HEAD');

  // The ticket's reference branch while it exists as a local branch; records from before it was kept
  // use the branch checked out now. Null turns the conflict check off and diffs fall back to the stored base.
  function referenceBranch(r) {
    const ref = 'ref' in r ? r.ref : currentBranch();
    return ref && branchSha(repoRoot, ref) ? ref : null;
  }

  // Where review diffs start: the merge-base with the reference branch, so merging the reference branch
  // into the ticket's branch doesn't fill the review with other tickets' work.
  function reviewBase(r) {
    const ref = referenceBranch(r);
    return (ref && tryGit(r.worktree, 'merge-base', ref, 'HEAD')) || r.base;
  }

  // Reference branch and merge conflict per ticket, from the last poll. Live data, so never saved.
  let conflictsByTicket = {};
  const check = conflictCheck(repoRoot);
  function scanConflicts() {
    const next = {};
    for (const [id, r] of Object.entries(records)) {
      if (!r.worktree) continue;
      const ref = referenceBranch(r);
      const result = ref && fs.existsSync(r.worktree) && checkConflicts(id) ? check(ref, r.branch) : null;
      // Mid-merge shows in every lane, also for a merge started outside the board.
      const merging = fs.existsSync(r.worktree) ? mergeState(r.worktree) : null;
      next[id] = { ref, conflict: result?.files.length ? { files: result.files } : null, merging };
    }
    check.prune();
    const changed = Object.keys(next).filter(id => JSON.stringify(next[id]) !== JSON.stringify(conflictsByTicket[id]));
    conflictsByTicket = next;
    for (const id of changed) onConflicts(id);
  }

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

  // Worktree processes per ticket, from the last scan. Live data, so never saved.
  let processesByTicket = {};
  // 'https' or 'http' per `<pid>:<port>`, probed once while that process listens there; null while probing.
  const schemes = new Map();
  const schemeKey = (p, port) => `${p.pid}:${port}`;
  function scanProcesses() {
    if (!processes) return;
    const ids = Object.keys(records).filter(id => records[id].worktree && fs.existsSync(records[id].worktree));
    const byFolder = processes.find(ids.map(id => records[id].worktree));
    const next = Object.fromEntries(ids.map(id => [id, byFolder[records[id].worktree] || []]));
    const changed = [...new Set([...Object.keys(processesByTicket), ...ids])].filter(id => JSON.stringify(processesByTicket[id] || []) !== JSON.stringify(next[id] || []));
    processesByTicket = next;
    probeSchemes();
    for (const id of changed) onProcesses(id);
  }

  function probeSchemes() {
    const live = new Set();
    for (const [id, procs] of Object.entries(processesByTicket)) {
      for (const p of procs) {
        for (const port of p.ports) {
          const key = schemeKey(p, port);
          live.add(key);
          if (schemes.has(key)) continue;
          schemes.set(key, null);
          probeScheme(port).catch(() => 'http').then(scheme => {
            if (!schemes.has(key)) return; // the process went away meanwhile
            schemes.set(key, scheme);
            onProcesses(id);
          });
        }
      }
    }
    for (const key of schemes.keys()) if (!live.has(key)) schemes.delete(key);
  }

  // The ticket's worktree, when you may merge in it by hand: it exists and no agent could be changing it.
  function mergeWorktree(id) {
    const r = records[id];
    if (!r?.worktree || !fs.existsSync(r.worktree)) throw new Error('No worktree for this ticket');
    if (['running', 'waiting'].includes(r.state)) throw new Error('The agent is running in this worktree; stop it first');
    return r;
  }

  // Runs `git args` in the ticket's worktree for a merge done by hand, and keeps a commit it makes from counting as
  // the agent's work: an agent that hadn't committed stays idle rather than becoming done (and moving the ticket).
  function gitByHand(r, ...args) {
    const untouched = head(r.worktree) === r.startHead;
    try { return git(r.worktree, ...args); }
    finally {
      if (untouched && head(r.worktree) !== r.startHead) { r.startHead = head(r.worktree); save(); }
      scanConflicts();
    }
  }

  const gitError = e => new Error((e.stderr || e.stdout || e.message).toString().trim().split('\n')[0]);

  const withSchemes = procs => procs.map(p => ({ ...p, ports: p.ports.map(port => ({ port, scheme: schemes.get(schemeKey(p, port)) ?? null })) }));

  return {
    repoRoot,

    get(id) {
      if (!records[id]) return null;
      // Until the first poll, the reference branch is looked up here and there is no conflict to report.
      const live = conflictsByTicket[id] || { ref: records[id].worktree ? referenceBranch(records[id]) : null, conflict: null, merging: null };
      const r = { ...records[id], hostname: agentHostname(id), ...live };
      return processes ? { ...r, processes: withSchemes(processesByTicket[id] || []) } : r;
    },

    all() { return Object.fromEntries(Object.keys(records).map(id => [id, this.get(id)])); },

    /** True while the session is running or waiting on you, i.e. it could still change the worktree. */
    busy(id) { return ['running', 'waiting'].includes(records[id]?.state); },

    /** Creates the worktree and starts `/implement` in a new background session. */
    async start(id, ticketFile) {
      if (this.busy(id)) throw new Error('An agent is already running for this ticket');
      await startSession(id, ticketFile, branch => prompt(id, ticketFile, branch));
      return this.get(id);
    },

    /**
     * Tells the ticket's agent to merge its reference branch and resolve the conflicts from the last poll:
     * in its session when there is one to resume, else in a new session in the same worktree.
     */
    async resolveConflicts(id, ticketFile) {
      if (this.busy(id)) throw new Error('An agent is already running for this ticket');
      const { ref, conflict } = this.get(id) || {};
      if (!conflict) throw new Error('No merge conflict to resolve');
      const task = conflictPrompt(ref, conflict.files);
      if (records[id]?.bgId && records[id].sessionId) return this.resume(id, ticketFile, task);
      await startSession(id, ticketFile, branch => `${task}\n\nRead the ticket for context: ${ticketFile}\n\n${sessionNote(id, branch)}`);
      return this.get(id);
    },

    /** Continues the ticket's conversation with `message`, in a background session with its full history. */
    async resume(id, ticketFile, message) {
      const r = records[id];
      if (!r?.sessionId) throw new Error('No session to continue for this ticket');
      if (r.state !== 'stopped') await cli.stop(r.bgId).catch(() => {});
      await launch(id, ['--resume', r.sessionId, `${message}\n\n${browserNote(agentHostname(id))}`, ...sessionArgs(ticketFile)], r.worktree);
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
      scanProcesses();
      scanConflicts();
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

    /**
     * Stops the process group of worktree process `pid`, or of all the ticket's worktree processes,
     * and returns how many processes that stopped. Only PIDs that are worktree processes of this ticket right now are accepted.
     */
    async killProcesses(id, pid) {
      if (!processes) throw new Error('Worktree processes are not available on this platform');
      scanProcesses();
      const current = processesByTicket[id] || [];
      if (pid != null && !current.some(p => p.pid === Number(pid))) throw new Error(`${pid} is not a worktree process of this ticket`);
      const groups = new Set(current.filter(p => pid == null || p.pid === Number(pid)).map(p => p.pgid));
      await Promise.all([...groups].map(g => processes.kill(g)));
      scanProcesses();
      return current.filter(p => groups.has(p.pgid)).length;
    },

    /** Recent things the agent said or did, and the last thing it said. */
    activity(id, limit = 40) {
      const r = records[id];
      if (!r) return { items: [], lastMessage: null };
      const items = readTranscript(r);
      const last = items.findLast(x => x.kind === 'text');
      return { items: items.slice(-limit), lastMessage: last?.text ?? null };
    },

    /** Where the ticket's review diffs start: the merge-base with its reference branch, else the stored base. */
    reviewBase(id) {
      const r = records[id];
      return r ? reviewBase(r) : null;
    },

    /** Commits and changed files on the ticket's branch since the review base, including uncommitted work. */
    changes(id) {
      const r = records[id];
      if (!r || !fs.existsSync(r.worktree)) return null;
      const base = reviewBase(r);
      return {
        base,
        commits: (tryGit(r.worktree, 'log', '--oneline', `${base}..HEAD`) || '').split('\n').filter(Boolean),
        stat: tryGit(r.worktree, 'diff', '--stat', base) || '',
        dirty: !!tryGit(r.worktree, 'status', '--porcelain'),
      };
    },

    /**
     * Merges the reference branch into the ticket's branch by hand, for the merge conflict from the last poll.
     * A clean merge is committed; on conflicts the worktree stays mid-merge and the mergetool opens on them.
     * Refused with uncommitted changes (untracked files aside): the board doesn't stash for you.
     */
    async merge(id) {
      const r = mergeWorktree(id);
      const { ref, conflict } = this.get(id);
      if (mergeState(r.worktree)) throw new Error('A merge is already in progress in this worktree');
      if (!conflict) throw new Error('No merge conflict to resolve');
      if (tryGit(r.worktree, 'status', '--porcelain', '--untracked-files=no')) throw new Error('The worktree has uncommitted changes; commit or stash them first');
      try {
        gitByHand(r, 'merge', '--no-edit', ref);
        return { clean: true };
      } catch (e) {
        const state = mergeState(r.worktree);
        if (!state) throw gitError(e); // git refused to start the merge
        this.openMergetool(id);
        return { clean: false, unresolved: state.unresolved };
      }
    },

    /** Opens the configured mergetool on the files still unmerged in the ticket's worktree, without waiting for it. */
    openMergetool(id) {
      const r = mergeWorktree(id);
      if (!mergeState(r.worktree)) throw new Error('No merge in progress');
      // No .orig backups: they would show as uncommitted changes.
      const child = execFile('git', ['-c', 'mergetool.keepBackup=false', 'mergetool', `--tool=${difftool}`, '--no-prompt'], { cwd: r.worktree }, () => scanConflicts());
      child.unref();
    },

    /** Commits the merge in progress; refused while any file is still unmerged. */
    async finishMerge(id) {
      const r = mergeWorktree(id);
      const state = mergeState(r.worktree);
      if (!state) throw new Error('No merge in progress');
      if (state.unresolved) throw new Error(`${state.unresolved === 1 ? '1 file' : `${state.unresolved} files`} still unmerged; resolve them in meld first`);
      try { gitByHand(r, 'commit', '--no-edit'); } catch (e) { throw gitError(e); }
    },

    /** Abandons the merge in progress, restoring the branch and worktree as they were before it. */
    async abortMerge(id) {
      const r = mergeWorktree(id);
      if (!mergeState(r.worktree)) throw new Error('No merge in progress');
      try { gitByHand(r, 'merge', '--abort'); } catch (e) { throw gitError(e); }
    },

    /** Opens the diff between the review base and the worktree in the configured difftool. */
    openDiff(id) {
      const r = records[id];
      if (!r || !fs.existsSync(r.worktree)) throw new Error('No worktree for this ticket');
      const child = execFile('git', ['difftool', '--dir-diff', `--tool=${difftool}`, '--no-prompt', reviewBase(r)], { cwd: r.worktree });
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

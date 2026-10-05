// Finds and stops worktree processes: running processes whose working folder is inside a ticket's worktree,
// such as the dev servers an agent started to test its work. Linux only, through /proc.
import fs from 'node:fs';
import path from 'node:path';

// A Claude Code session: the `claude` launcher, its pty host, or the versioned binary it runs.
// Some of them rewrite their title, so argv[0] can be "claude bg-pty-host ..." as one string: look at the first words.
const isClaude = argv => argv.join(' ').split(/\s+/).slice(0, 2)
  .some(a => /(^|\/)claude$|\/claude\/versions\/|@anthropic-ai\/claude-code/.test(a));

/**
 * The two things the board asks about processes. Swapped for a fake in tests.
 * Returns null when there is no /proc (macOS, Windows), which turns the feature off.
 */
export function procProcesses(procRoot = '/proc') {
  if (!fs.existsSync(path.join(procRoot, 'self')) && !fs.existsSync(path.join(procRoot, 'net'))) return null;
  const read = (...p) => { try { return fs.readFileSync(path.join(procRoot, ...p), 'utf8'); } catch { return null; } };
  const link = (...p) => { try { return fs.readlinkSync(path.join(procRoot, ...p)); } catch { return null; } };

  // `pid (comm) state ppid pgrp ...`; comm may hold spaces and parentheses, so split after the last ')'.
  function stat(pid) {
    const s = read(String(pid), 'stat');
    if (!s) return null;
    const [state, , pgid] = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return { state, pgid: Number(pgid) };
  }

  const pids = () => { try { return fs.readdirSync(procRoot).filter(d => /^\d+$/.test(d)).map(Number); } catch { return []; } };

  // Socket inode -> port, for sockets in the LISTEN state (0A).
  function listeners() {
    const ports = new Map();
    for (const file of ['tcp', 'tcp6']) {
      for (const line of (read('net', file) || '').split('\n').slice(1)) {
        const f = line.trim().split(/\s+/);
        if (f[3] === '0A') ports.set(f[9], parseInt(f[1].split(':').at(-1), 16));
      }
    }
    return ports;
  }

  function ports(pid, listening) {
    let fds = [];
    try { fds = fs.readdirSync(path.join(procRoot, String(pid), 'fd')); } catch { return []; }
    const found = new Set();
    for (const fd of fds) {
      const inode = link(String(pid), 'fd', fd)?.match(/^socket:\[(\d+)\]$/)?.[1];
      if (inode && listening.has(inode)) found.add(listening.get(inode));
    }
    return [...found].sort((a, b) => a - b);
  }

  // Live members of a process group; zombies have already exited.
  const groupAlive = pgid => pids().some(pid => { const s = stat(pid); return s?.pgid === pgid && s.state !== 'Z'; });

  return {
    /** The worktree processes inside each folder, as { [folder]: [{ pid, pgid, command, ports }] }. */
    find(folders) {
      const out = Object.fromEntries(folders.map(f => [f, []]));
      const own = stat('self')?.pgid;
      const claudeGroups = new Set(own ? [own] : []);
      const candidates = [];
      for (const pid of pids()) {
        const cwd = link(String(pid), 'cwd');
        const s = cwd && stat(pid);
        const argv = s && read(String(pid), 'cmdline')?.split('\0').filter(Boolean);
        if (!argv?.length || s.state === 'Z') continue;
        if (isClaude(argv)) { claudeGroups.add(s.pgid); continue; }
        const folder = folders.find(f => cwd === f || cwd.startsWith(f + path.sep));
        if (folder) candidates.push({ folder, pid, pgid: s.pgid, argv });
      }
      const listening = candidates.length ? listeners() : new Map();
      for (const c of candidates) {
        // An MCP server or tool shell sharing the session's group belongs to the session.
        if (claudeGroups.has(c.pgid)) continue;
        out[c.folder].push({ pid: c.pid, pgid: c.pgid, command: c.argv.join(' '), ports: ports(c.pid, listening) });
      }
      return out;
    },

    /** Stops a whole process group: SIGTERM, then SIGKILL to whatever is still alive after `graceMs`. */
    async kill(pgid, graceMs = 5000) {
      const signal = sig => { try { process.kill(-pgid, sig); } catch { /* already gone */ } };
      signal('SIGTERM');
      for (const end = Date.now() + graceMs; Date.now() < end;) {
        if (!groupAlive(pgid)) return;
        await new Promise(r => setTimeout(r, 100));
      }
      signal('SIGKILL');
      for (let i = 0; i < 20 && groupAlive(pgid); i++) await new Promise(r => setTimeout(r, 50));
    },
  };
}

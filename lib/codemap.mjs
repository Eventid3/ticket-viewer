// Optional structure-diff review through codemap, a separately installed `codemap` command.
// The board only talks to it through its command line, so it imports no codemap code and stays dependency-free.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

// Review-list groups in codemap's words; codemap orders entries by how likely they are to be a problem.
const GROUP_LABELS = {
  'new-cycle': 'New cycles',
  'new-project-reference': 'New project references',
  'new-coupling': 'New coupling',
  'injected-concrete': 'Injected concrete classes',
  'surface-change': 'Surface changes',
  'move': 'Moves',
  'other-change': 'Other changes',
};

/** The full path of `cmd` on the PATH in `env`, or null. */
function findOnPath(cmd, env) {
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* not here */ }
    }
  }
  return null;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.bin]  The codemap command (default codemap).
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns null when codemap isn't on PATH: the board works as before, with the structure diff hidden.
 */
export function createCodemap({ bin = 'codemap', env = process.env } = {}) {
  const exe = findOnPath(bin, env);
  if (!exe) return null;

  // Cold snapshots of a large solution take a while, so this allows minutes, not seconds.
  const run = args => new Promise((resolve, reject) => {
    execFile(exe, args, { env, encoding: 'utf8', timeout: 5 * 60_000, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      // codemap reports failures as one `codemap: …` line; keep the tail of anything longer, such as extractor output.
      if (err) reject(new Error((stderr.trim() || err.message).slice(-800)));
      else resolve(stdout);
    });
  });

  return {
    /** Opens the review list in the browser, on the repo's codemap server. Rejects when codemap can't. */
    async view(worktree, base) {
      await run(['view', '--repo', worktree, '--base', base]);
    },

    /** Counts per review-list group, the flagged entries, and their notes ready to send back to the agent. */
    async summary(worktree, base) {
      const out = await run(['diff', '--repo', worktree, '--base', base, '--json']);
      let s;
      try { s = JSON.parse(out); } catch { s = null; }
      if (!s?.counts || !Array.isArray(s.entries) || !Array.isArray(s.notes)) throw new Error('Unexpected output from codemap diff --json; is codemap up to date?');
      const kinds = Object.keys(s.counts).sort((a, b) => Number(a === 'other-change') - Number(b === 'other-change'));
      return {
        groups: kinds.map(kind => ({ kind, label: GROUP_LABELS[kind] || kind, count: s.counts[kind] })),
        unmarked: s.entries.filter(e => !e.mark).length,
        flagged: s.entries.filter(e => e.note).map(e => ({ title: e.title, note: e.note })),
        notes: s.notes,
        warning: s.referenceWarning?.message ?? null,
      };
    },

    /** Snapshots the base commit in the background, so opening the review later is fast. The result is ignored. */
    warmUp(worktree, base) {
      try {
        const child = spawn(exe, ['snapshot', '--repo', worktree, '--commit', base], { env, stdio: 'ignore', detached: true });
        child.on('error', () => {});
        child.unref();
      } catch { /* a missed warm-up only costs one extraction later */ }
    },
  };
}

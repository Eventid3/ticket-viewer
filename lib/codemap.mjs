// Optional structure-diff review through codemap, a separately installed `codemap` command.
// The board only talks to it through its command line, so it imports no codemap code and stays dependency-free.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

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

const THUMBNAILS = 3;
const CACHE_LIMIT = 100;

// The flows the Flows list in codemap shows first: those still asking for the agent's words (they need an annotation and
// have no current one) and the stale ones, then the rest, each group in codemap's order.
function flowOrder(segments) {
  const asking = s => s.annotation === 'stale' || (s.needsAnnotation && s.annotation !== 'current');
  return [...segments.filter(asking), ...segments.filter(s => !asking(s))];
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The flows counts from `diff --json`, with the review panel's line; null from a codemap without flows.
function flowsOf(f) {
  if (![f?.changed, f?.missing, f?.stale].every(Number.isInteger)) return null;
  const { changed, needsAnnotation, missing, stale } = f;
  return { changed, needsAnnotation, missing, stale, line: `${plural(changed, 'changed flow')} · ${missing} without annotation · ${stale} stale` };
}

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
 * @param {number} [opts.renderTimeoutMs]  How long one `codemap render` may take (default a minute).
 * @param {number} [opts.maxOutputBytes]  How much stdout or stderr one command may print (default 64 MiB).
 * @returns null when codemap isn't on PATH: the board works as before, with the structure diff hidden.
 */
export function createCodemap({ bin = 'codemap', env = process.env, renderTimeoutMs = 60_000, maxOutputBytes = 64 << 20 } = {}) {
  const exe = findOnPath(bin, env);
  if (!exe) return null;

  // Cold snapshots of a large solution take a while, so this allows minutes, not seconds. codemap runs in a process group
  // of its own, so a timeout or an overflow kills its extractor children too instead of orphaning them.
  const run = (args, timeout = 5 * 60_000) => new Promise((resolve, reject) => {
    const posix = process.platform !== 'win32';
    const child = spawn(exe, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: posix });
    let stdout = '', stderr = '', size = 0, failure = null, done = false;
    const kill = () => {
      try { if (posix) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch (e) {
        if (e.code === 'ESRCH') return; // already gone
        try { child.kill('SIGKILL'); } catch { /* nothing more to do */ }
      }
    };
    // Kills once and settles at once: a descendant that outlived the kill may hold the pipes, so 'close' may never come.
    const fail = message => {
      if (failure) return;
      failure = new Error(message);
      kill();
      child.stdout.destroy();
      child.stderr.destroy();
      finish(null);
    };
    const timer = setTimeout(() => fail(`codemap ${args[0]} timed out after ${Math.round(timeout / 1000)}s`), timeout);
    const take = which => chunk => {
      size += chunk.length;
      if (size > maxOutputBytes) return fail(`codemap ${args[0]} printed more than ${Math.round(maxOutputBytes / 1024 / 1024)} MiB; stopped`);
      if (which === 'out') stdout += chunk; else stderr += chunk;
    };
    child.stdout.setEncoding('utf8').on('data', take('out'));
    child.stderr.setEncoding('utf8').on('data', take('err'));
    function finish(err, code) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // codemap reports failures as one `codemap: …` line; keep the tail of anything longer, such as extractor output.
      if (failure) reject(failure);
      else if (err) reject(new Error(err.message));
      else if (code !== 0) reject(new Error((stderr.trim() || `codemap ${args[0]} exited with code ${code}`).slice(-800)));
      else resolve(stdout);
    }
    child.on('error', err => finish(err));
    child.on('close', code => finish(null, code));
  });

  // Rendered thumbnails by what the drawing depends on, so the board draws each flow once until the code or its annotation
  // changes; a render in flight is shared. Failures are dropped, so a retry runs again. In memory: a restart starts clean.
  const cache = new Map();
  function renderThumbnail(worktree, base, s) {
    // Everything the drawing is made from: the segment as `flows --json` gives it (its steps with their labels and
    // arguments, and the annotation's state and words), so a change of detail alone draws again.
    const key = createHash('sha256').update(JSON.stringify([worktree, base, s])).digest('hex');
    if (cache.has(key)) return cache.get(key);
    const done = (async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-viewer-thumb-'));
      try {
        const out = path.join(dir, 'flow.svg');
        await run(['render', '--repo', worktree, '--base', base, '--segment', s.id, '--out', out], renderTimeoutMs);
        return { id: s.id, label: s.label, svg: fs.readFileSync(out, 'utf8') };
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    })();
    cache.set(key, done);
    done.catch(() => cache.delete(key));
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return done;
  }

  const drawing = new Map();
  async function drawThumbnails(worktree, base) {
    let flows;
    try { flows = JSON.parse(await run(['flows', '--repo', worktree, '--base', base, '--json'])); } catch (e) {
      if (e instanceof SyntaxError) flows = null; else throw e;
    }
    if (!Array.isArray(flows?.segments)) throw new Error('Unexpected output from codemap flows --json; is codemap up to date?');
    // One at a time: a cold cache extracts snapshots once, and parallel renders would each wait on it and time out.
    const items = [];
    for (const s of flowOrder(flows.segments).slice(0, THUMBNAILS)) {
      items.push(await renderThumbnail(worktree, base, s).catch(e => ({ id: s.id, label: s.label, error: e.message })));
    }
    return { items };
  }

  return {
    /**
     * The paragraph that goes into the agent's prompt: annotate the changed flows of the worktree since the review base.
     * The format is in codemap's own usage text, so it is not repeated here.
     */
    annotationNote(worktree, base, ref = null) {
      // The agent runs in the worktree, so `.` names it and a path with spaces can't break the commands.
      const moved = ref ? ` If you merged ${ref} during this turn, use \`git merge-base ${ref} HEAD\` as the base instead.` : '';
      return `codemap is installed. Before your final message with the turn marker, run \`codemap flows --repo . --base ${base}\`. For each segment marked needsAnnotation (or whose annotation is missing or stale), write annotations with \`codemap annotate --repo . --base ${base}\`; it reads JSON from stdin or --file, and \`codemap annotate --help\` shows the format.${moved} If no segment needs annotation, do nothing.`;
    },

    /** Opens the review in the browser, on the repo's codemap server, on `segment` if given. Rejects when codemap can't. */
    async view(worktree, base, segment) {
      await run(['view', '--repo', worktree, '--base', base, ...(segment ? [`--segment=${segment}`] : [])]);
    },

    /**
     * SVGs of the first flows, those asking for an annotation first: `{ items: [{ id, label, svg } | { id, label, error }] }`.
     * One render failing or timing out is that item's `error`; codemap's flows failing rejects.
     */
    thumbnails(worktree, base) {
      // Requests for the same review share one `flows` and one run of renders, one at a time.
      const key = JSON.stringify([worktree, base]);
      if (!drawing.has(key)) {
        const job = drawThumbnails(worktree, base);
        drawing.set(key, job);
        const forget = () => drawing.delete(key);
        job.then(forget, forget);
      }
      return drawing.get(key);
    },

    /** Counts per review-list group, and codemap's reference warning. codemap is view-only: it carries no marks or notes. */
    async summary(worktree, base) {
      const out = await run(['diff', '--repo', worktree, '--base', base, '--json']);
      let s;
      try { s = JSON.parse(out); } catch { s = null; }
      if (!s?.counts || !Array.isArray(s.entries)) throw new Error('Unexpected output from codemap diff --json; is codemap up to date?');
      const kinds = Object.keys(s.counts).sort((a, b) => Number(a === 'other-change') - Number(b === 'other-change'));
      return {
        flows: flowsOf(s.flows),
        groups: kinds.map(kind => ({ kind, label: GROUP_LABELS[kind] || kind, count: s.counts[kind] })),
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

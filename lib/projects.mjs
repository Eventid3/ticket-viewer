// The projects the board remembers: one `.scratch` folder each, kept in a small JSON config file as `{ id, path }`.
// The id is fixed when a project is added; the display name is worked out from the current list every time.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveFeatures } from './tickets.mjs';

/** `$XDG_CONFIG_HOME/ticket-viewer/projects.json`, by default `~/.config/ticket-viewer/projects.json`. */
export function configFile(env = process.env) {
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'ticket-viewer', 'projects.json');
}

/** `~` and `~/…` expanded to the home folder; surrounding spaces trimmed. */
export function expandPath(p) {
  const s = String(p ?? '').trim();
  if (s === '~') return os.homedir();
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  return s;
}

// The folder a project is named after: the one holding `.scratch/`, or the scratch folder itself when it has another name.
const projectFolder = scratchRoot => path.basename(scratchRoot) === '.scratch' ? path.dirname(scratchRoot) : scratchRoot;

function slug(name) {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

// Display names: the folder's name, or `<parent>/<name>` for every project sharing that name with another.
function withNames(projects) {
  const base = p => path.basename(projectFolder(p.path));
  const counts = new Map();
  for (const p of projects) counts.set(base(p), (counts.get(base(p)) || 0) + 1);
  return projects.map(p => {
    const folder = projectFolder(p.path);
    const name = counts.get(base(p)) > 1 ? `${path.basename(path.dirname(folder))}/${base(p)}` : base(p);
    return { id: p.id, path: p.path, name };
  });
}

/**
 * The remembered projects in config file `file`. Every call reads the file afresh, so it is the only state.
 * A missing file is an empty list; a file that isn't a list of projects is an error rather than being overwritten.
 */
export function projectsConfig(file = configFile()) {
  function read() {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    let list;
    try { list = JSON.parse(text); } catch (e) { throw new Error(`Could not read ${file}: ${e.message}`); }
    if (!Array.isArray(list)) throw new Error(`Could not read ${file}: expected a list of projects`);
    return list.filter(p => p && typeof p.id === 'string' && typeof p.path === 'string').map(p => ({ id: p.id, path: p.path }));
  }

  function write(list) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n');
    fs.renameSync(tmp, file);
  }

  const named = (list, id) => withNames(list).find(p => p.id === id);

  return {
    file,

    /** Every project as `{ id, path, name }`, in the order they were added. */
    list() { return withNames(read()); },

    /** Remembers scratch folder `scratchRoot` (absolute) unless it already is; returns the project and whether it is new. */
    add(scratchRoot) {
      const list = read();
      const existing = list.find(p => p.path === scratchRoot);
      if (existing) return { project: named(list, existing.id), added: false };
      const stem = slug(path.basename(projectFolder(scratchRoot)));
      let id = stem;
      for (let n = 2; list.some(p => p.id === id); n++) id = `${stem}-${n}`;
      list.push({ id, path: scratchRoot });
      write(list);
      return { project: named(list, id), added: true };
    },

    /** Forgets project `id`; nothing on disk besides the config file is touched. False when there was no such project. */
    remove(id) {
      const list = read();
      const next = list.filter(p => p.id !== id);
      if (next.length === list.length) return false;
      write(next);
      return true;
    },
  };
}

function tryGit(cwd, ...args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

/**
 * Checks folder `dir` (absolute) the way both the command line and the Add project dialog do, and returns its
 * project's scratch folder plus the feature it names, if it is a feature folder. Throws with a message for the user.
 * A git worktree of another repo is refused: it shares the repo's agent records, so it must never be a project of its own.
 */
export function resolveProject(dir) {
  if (!path.isAbsolute(dir)) throw new Error(`Expected an absolute path: ${dir}`);
  const { scratchRoot, features } = resolveFeatures(dir);
  const gitDir = tryGit(scratchRoot, 'rev-parse', '--absolute-git-dir');
  // Relative to the folder git ran in (no --path-format, which needs git 2.31).
  const commonDir = gitDir && path.resolve(scratchRoot, tryGit(scratchRoot, 'rev-parse', '--git-common-dir') || gitDir);
  // A linked worktree's git dir is `<common dir>/worktrees/<name>`; a repo's (or a submodule's) is its common dir.
  if (gitDir && commonDir && path.resolve(gitDir) !== path.resolve(commonDir)) {
    const main = tryGit(scratchRoot, 'worktree', 'list', '--porcelain')?.match(/^worktree (.+)$/m)?.[1];
    throw new Error(`This folder is a worktree of ${main || path.dirname(commonDir)}; add the repo instead`);
  }
  const single = features.length === 1 && features[0].dir === path.resolve(dir);
  // Through symlinks, so the same folder reached two ways is still one project.
  return { scratchRoot: fs.realpathSync(scratchRoot), feature: single ? features[0].name : null };
}

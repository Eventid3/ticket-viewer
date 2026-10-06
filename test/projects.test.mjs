import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { projectsConfig, configFile, resolveProject, expandPath } from '../lib/projects.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'projects-')));
}

// A folder `<root>/<...parts>` holding `.scratch/<feature>/issues/01-a.md`; returns the folder.
function repo(root, ...parts) {
  const dir = path.join(root, ...parts);
  fs.mkdirSync(path.join(dir, '.scratch', 'feat', 'issues'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.scratch', 'feat', 'issues', '01-a.md'), '# 01: A\n\nStatus: needs-triage\n');
  return dir;
}

test('the config file lives in $XDG_CONFIG_HOME, else ~/.config', () => {
  assert.equal(configFile({ XDG_CONFIG_HOME: '/x/conf' }), '/x/conf/ticket-viewer/projects.json');
  assert.equal(configFile({}), path.join(os.homedir(), '.config', 'ticket-viewer', 'projects.json'));
});

test('a missing config file is an empty list', () => {
  const config = projectsConfig(path.join(tmp(), 'nope', 'projects.json'));
  assert.deepEqual(config.list(), []);
});

test('add saves { id, path } and list reads it back with a display name', () => {
  const root = tmp();
  const file = path.join(root, 'conf', 'projects.json');
  const config = projectsConfig(file);
  const scratch = path.join(root, 'My Shop', '.scratch');
  const { project, added } = config.add(scratch);
  assert.equal(added, true);
  assert.deepEqual(project, { id: 'my-shop', path: scratch, name: 'My Shop' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [{ id: 'my-shop', path: scratch }]);
  assert.deepEqual(projectsConfig(file).list(), [{ id: 'my-shop', path: scratch, name: 'My Shop' }]);
});

test('adding the same scratch folder twice keeps one entry', () => {
  const root = tmp();
  const config = projectsConfig(path.join(root, 'projects.json'));
  const scratch = path.join(root, 'shop', '.scratch');
  config.add(scratch);
  const again = config.add(scratch);
  assert.equal(again.added, false);
  assert.equal(again.project.id, 'shop');
  assert.equal(config.list().length, 1);
});

test('ids clash with -2, -3, and are never recomputed', () => {
  const root = tmp();
  const file = path.join(root, 'projects.json');
  const config = projectsConfig(file);
  const a = config.add(path.join(root, 'a', 'shop', '.scratch')).project;
  const b = config.add(path.join(root, 'b', 'shop', '.scratch')).project;
  const c = config.add(path.join(root, 'c', 'Shop', '.scratch')).project;
  assert.deepEqual([a.id, b.id, c.id], ['shop', 'shop-2', 'shop-3']);
  config.remove('shop');
  const d = config.add(path.join(root, 'd', 'shop', '.scratch')).project;
  assert.equal(d.id, 'shop', 'a freed id can be taken again');
  assert.deepEqual(config.list().map(p => p.id).sort(), ['shop', 'shop-2', 'shop-3']);
});

test('a folder name without letters or digits still gets an id', () => {
  const root = tmp();
  const config = projectsConfig(path.join(root, 'projects.json'));
  assert.equal(config.add(path.join(root, '___', '.scratch')).project.id, 'project');
});

test('a scratch folder not named .scratch is named after itself', () => {
  const root = tmp();
  const config = projectsConfig(path.join(root, 'projects.json'));
  assert.deepEqual(config.add(path.join(root, 'tickets')).project, { id: 'tickets', path: path.join(root, 'tickets'), name: 'tickets' });
});

test('duplicate folder names show <parent>/<name>, and go back to the plain name once the clash is gone', () => {
  const root = tmp();
  const config = projectsConfig(path.join(root, 'projects.json'));
  config.add(path.join(root, 'work', 'shop', '.scratch'));
  config.add(path.join(root, 'home', 'shop', '.scratch'));
  config.add(path.join(root, 'home', 'blog', '.scratch'));
  assert.deepEqual(config.list().map(p => p.name), ['work/shop', 'home/shop', 'blog']);
  config.remove('shop-2');
  assert.deepEqual(config.list().map(p => p.name), ['shop', 'blog']);
});

test('remove forgets the project and reports whether it was there', () => {
  const root = tmp();
  const file = path.join(root, 'projects.json');
  const config = projectsConfig(file);
  const scratch = path.join(repo(root, 'shop'), '.scratch');
  config.add(scratch);
  assert.equal(config.remove('shop'), true);
  assert.equal(config.remove('shop'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), []);
  assert.ok(fs.existsSync(scratch), 'nothing on disk is touched');
});

test('a corrupt config file is an error, not an empty list that the next add would overwrite', () => {
  const root = tmp();
  const file = path.join(root, 'projects.json');
  fs.writeFileSync(file, '{ nope');
  assert.throws(() => projectsConfig(file).list(), new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('resolveProject: repo root, .scratch and a feature folder name the same project', () => {
  const root = tmp();
  const dir = repo(root, 'shop');
  const scratch = path.join(dir, '.scratch');
  assert.deepEqual(resolveProject(dir), { scratchRoot: scratch, feature: null });
  assert.deepEqual(resolveProject(scratch), { scratchRoot: scratch, feature: null });
  assert.deepEqual(resolveProject(path.join(scratch, 'feat')), { scratchRoot: scratch, feature: 'feat' });
});

test('resolveProject rejects missing folders, folders without tickets and relative paths', () => {
  const root = tmp();
  assert.throws(() => resolveProject(path.join(root, 'gone')), /Not a folder/);
  fs.mkdirSync(path.join(root, 'empty'));
  assert.throws(() => resolveProject(path.join(root, 'empty')), /No ticket folders/);
  assert.throws(() => resolveProject('shop'), /absolute path/);
});

test('resolveProject rejects a git worktree of another repo, naming the repo', () => {
  const root = tmp();
  const dir = repo(root, 'shop');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '.');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  assert.deepEqual(resolveProject(dir), { scratchRoot: path.join(dir, '.scratch'), feature: null }, 'the repo itself is fine');
  const wt = path.join(root, 'shop-wt');
  git(dir, 'worktree', 'add', '-q', wt);
  assert.throws(() => resolveProject(wt), { message: `This folder is a worktree of ${dir}; add the repo instead` });
  assert.throws(() => resolveProject(path.join(wt, '.scratch', 'feat')), /worktree of/);
});

test('expandPath expands ~ and leaves other paths alone', () => {
  assert.equal(expandPath('~'), os.homedir());
  assert.equal(expandPath('~/code/x'), path.join(os.homedir(), 'code', 'x'));
  assert.equal(expandPath('  /a/b  '), '/a/b');
  assert.equal(expandPath('rel'), 'rel');
});

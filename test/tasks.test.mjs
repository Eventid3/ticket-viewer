import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { slugFor, nextNumber, taskMarkdown, createTaskFile } from '../lib/tasks.mjs';
import { parseTicket } from '../lib/tickets.mjs';

test('slugs come from the title, else the first words of the description', () => {
  assert.equal(slugFor('Fix the Login Bug!', 'ignored'), 'fix-the-login-bug');
  assert.equal(slugFor('', 'Add a dark mode toggle to the settings page, please'), 'add-a-dark-mode-toggle-to');
  assert.equal(slugFor('  ', 'Café crème'), 'cafe-creme');
  assert.equal(slugFor('', '???'), 'task');
  assert.ok(slugFor('x'.repeat(100), '').length <= 40);
});

test('the next number follows the highest, with two digits at least', () => {
  assert.equal(nextNumber([]), '01');
  assert.equal(nextNumber(['01-a.md', '03-b.md', 'notes.md']), '04');
  assert.equal(nextNumber(['99-a.md']), '100');
});

test('a task file parses as a drafting task with its description', () => {
  const t = parseTicket(taskMarkdown('02', '', 'Rename the thing\nand more'), '02-rename-the-thing.md', 'tasks');
  assert.equal(t.status, 'drafting');
  assert.equal(t.title, 'Rename the thing');
  assert.equal(t.sections.find(s => s.key === 'description').body, 'Rename the thing\nand more');
});

test('creating tasks numbers them in turn, and never overwrites a file', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-')), '.scratch', 'tasks');
  assert.equal(createTaskFile(dir, { title: 'Same', description: 'one' }), '01-same.md');
  assert.equal(createTaskFile(dir, { title: 'Same', description: 'two' }), '02-same.md');
  fs.rmSync(path.join(dir, '01-same.md'));
  assert.equal(createTaskFile(dir, { title: 'Other', description: 'three' }), '03-other.md');
  assert.match(fs.readFileSync(path.join(dir, '02-same.md'), 'utf8'), /two/);
  assert.equal(createTaskFile(dir, { description: 'x' }, f => !f.startsWith('04-')), '05-x.md', 'a vetoed name is skipped');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTicket, setStatus, appendComment, loadFeature, resolveFeatures, isFeatureCompleted } from '../lib/tickets.mjs';

const BOLD = `# 06: Build green on Umbraco 17

**What to build:** The whole solution builds.

**Blocked by:** 02, 03

**Status:** ready-for-agent

- [x] One
- [ ] Two

## Comments

- **2026-09-01:** looks good
`;

test('parses bold metadata, title, blockers and checkboxes', () => {
  const t = parseTicket(BOLD, '06-build-green.md');
  assert.equal(t.number, '06');
  assert.equal(t.title, 'Build green on Umbraco 17');
  assert.equal(t.status, 'ready-for-agent');
  assert.deepEqual(t.blockedBy, ['02', '03']);
  assert.equal(t.summary, 'The whole solution builds.');
  assert.deepEqual(t.checks, { done: 1, total: 2 });
  assert.equal(t.comments, 1);
});

test('parses plain metadata lines and "None" blockers', () => {
  const t = parseTicket('# Q\n\nType: research\nStatus: Claimed\nBlocked by: None (can start)\n\nWhy?\n', '01-q.md');
  assert.equal(t.status, 'claimed');
  assert.equal(t.type, 'research');
  assert.deepEqual(t.blockedBy, []);
  assert.equal(t.summary, 'Why?');
});

test('ignores Status lines inside sections below the header', () => {
  const t = parseTicket('# Q\n\n## Answer\n\nStatus: resolved\n', '01-q.md');
  assert.equal(t.status, null);
});

test('setStatus keeps the existing line format', () => {
  assert.match(setStatus(BOLD, 'claimed'), /^\*\*Status:\*\* claimed$/m);
  assert.equal(setStatus('# Q\nStatus: needs-triage\n', 'resolved'), '# Q\nStatus: resolved\n');
  assert.equal(setStatus('# Q\r\nStatus: a\r\n', 'b'), '# Q\r\nStatus: b\r\n');
});

test('setStatus inserts a status line when missing', () => {
  assert.equal(setStatus('# Q\n\nBody\n', 'needs-triage'), '# Q\n\nStatus: needs-triage\n\nBody\n');
});

test('appendComment adds to an existing Comments section', () => {
  const out = appendComment(BOLD, 'please add a test', '2026-09-29');
  assert.match(out, /- \*\*2026-09-01:\*\* looks good\n- \*\*2026-09-29 \(review\):\*\* please add a test\n$/);
});

test('appendComment creates a Comments section when missing', () => {
  assert.equal(appendComment('# Q\n\nBody\n', 'a\nb', '2026-09-29'), '# Q\n\nBody\n\n## Comments\n\n- **2026-09-29 (review):** a b\n');
});

test('loadFeature marks tickets blocked until blockers are done', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-'));
  const issues = path.join(root, '.scratch', 'feat', 'issues');
  fs.mkdirSync(issues, { recursive: true });
  fs.writeFileSync(path.join(issues, '01-a.md'), '# A\n\nStatus: resolved\n');
  fs.writeFileSync(path.join(issues, '02-b.md'), '# B\n\nStatus: ready-for-agent\n');
  fs.writeFileSync(path.join(issues, '03-c.md'), '# C\n\nBlocked by: 01\nStatus: ready-for-agent\n');
  fs.writeFileSync(path.join(issues, '04-d.md'), '# D\n\nBlocked by: 01, 02\nStatus: ready-for-agent\n');

  const { features } = resolveFeatures(root);
  assert.deepEqual(features.map(f => f.name), ['feat']);
  const byNum = Object.fromEntries(loadFeature(features[0]).map(t => [t.number, t]));
  assert.equal(byNum['03'].blocked, false);
  assert.equal(byNum['04'].blocked, true);
  assert.deepEqual(byNum['04'].openBlockers, ['02']);
  assert.deepEqual(byNum['01'].blocks, ['03', '04']);
  assert.equal(byNum['01'].path, '.scratch/feat/issues/01-a.md');
  assert.equal(byNum['01'].absPath, path.join(issues, '01-a.md'));

  // A feature folder can be passed directly, too.
  const single = resolveFeatures(path.join(root, '.scratch', 'feat')).features;
  assert.equal(single.length, 1);
  assert.equal(loadFeature(single[0])[0].path, '.scratch/feat/issues/01-a.md');
  fs.rmSync(root, { recursive: true });
});

test('a feature is completed when it has tickets and every one is in the done set', () => {
  const t = status => ({ status });
  assert.equal(isFeatureCompleted([t('resolved'), t('wontfix'), t('done'), t('closed')]), true);
  assert.equal(isFeatureCompleted([t('resolved'), t('ready-for-agent')]), false);
  assert.equal(isFeatureCompleted([]), false, 'a feature with no tickets is not completed');
});

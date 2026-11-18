import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCodemap } from '../lib/codemap.mjs';

// A stand-in `codemap` on a PATH of its own: logs its arguments, prints $FAKE_OUT and exits with $FAKE_EXIT.
function fakeCodemap() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-')));
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(path.join(dir, 'codemap'), `#!/bin/sh
echo "$*" >> "${log}"
[ -n "$FAKE_DELAY" ] && sleep "$FAKE_DELAY"
printf '%s' "$FAKE_OUT"
[ -n "$FAKE_ERR" ] && echo "$FAKE_ERR" >&2
exit \${FAKE_EXIT:-0}
`, { mode: 0o755 });
  const env = { PATH: `${dir}${path.delimiter}/usr/bin${path.delimiter}/bin` };
  return { dir, env, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}

const SUMMARY = {
  base: { commit: 'aaa' },
  after: { commit: 'bbb', dirty: true },
  counts: { 'new-coupling': 2, 'surface-change': 1, 'other-change': 4 },
  entries: [
    { id: 'c1', kind: 'new-coupling', title: 'New coupling: Archive → Logbooks', text: 'ArchiveController now injects LogbookService (Archive → Logbooks, new coupling)' },
    { id: 'c2', kind: 'new-coupling', title: 'New coupling: Archive → Users' },
    { id: 's1', kind: 'surface-change', title: 'Surface change: Foo (1 added)' },
    { id: 'o1', kind: 'other-change', title: 'Added type Bar' },
  ],
};

test('is unavailable when codemap is not on PATH', () => {
  assert.equal(createCodemap({ env: { PATH: fs.mkdtempSync(path.join(os.tmpdir(), 'empty-')) } }), null);
});

test('summary runs diff --json for the worktree and base, and returns the counts per group', async () => {
  const fake = fakeCodemap();
  const codemap = createCodemap({ env: { ...fake.env, FAKE_OUT: JSON.stringify(SUMMARY) } });
  const s = await codemap.summary('/wt', 'aaa');

  assert.deepEqual(fake.calls(), ['diff --repo /wt --base aaa --json']);
  assert.deepEqual(s.groups, [
    { kind: 'new-coupling', label: 'New coupling', count: 2 },
    { kind: 'surface-change', label: 'Surface changes', count: 1 },
    { kind: 'other-change', label: 'Other changes', count: 4 },
  ]);
  assert.deepEqual(Object.keys(s).sort(), ['flows', 'groups', 'warning']);
  assert.equal(s.flows, null, 'older codemap output has no flows');
});

test('summary reports the package-reference warning', async () => {
  const fake = fakeCodemap();
  const out = { ...SUMMARY, referenceWarning: { message: 'Package references were incomplete' } };
  const s = await createCodemap({ env: { ...fake.env, FAKE_OUT: JSON.stringify(out) } }).summary('/wt', 'aaa');
  assert.equal(s.warning, 'Package references were incomplete');
});

test('a failing command rejects with what codemap printed on stderr', async () => {
  const fake = fakeCodemap();
  const codemap = createCodemap({ env: { ...fake.env, FAKE_EXIT: '1', FAKE_ERR: 'codemap: no extractor found for this repo' } });
  await assert.rejects(codemap.view('/wt', 'aaa'), { message: 'codemap: no extractor found for this repo' });
  await assert.rejects(codemap.summary('/wt', 'aaa'), { message: 'codemap: no extractor found for this repo' });
});

test('view runs codemap view for the worktree and base', async () => {
  const fake = fakeCodemap();
  await createCodemap({ env: fake.env }).view('/wt', 'aaa');
  assert.deepEqual(fake.calls(), ['view --repo /wt --base aaa']);
});

test('warmUp snapshots the base commit in the background and ignores the result', async () => {
  const fake = fakeCodemap();
  const codemap = createCodemap({ env: { ...fake.env, FAKE_EXIT: '1', FAKE_DELAY: '0.2' } });
  const started = Date.now();
  assert.equal(codemap.warmUp('/wt', 'aaa'), undefined);
  assert.ok(Date.now() - started < 150, 'does not wait for the snapshot');
  for (let i = 0; i < 50 && !fake.calls().length; i++) await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(fake.calls(), ['snapshot --repo /wt --commit aaa']);
});

test('summary words the flows counts from diff --json', async () => {
  const fake = fakeCodemap();
  const out = { ...SUMMARY, flows: { changed: 3, needsAnnotation: 2, missing: 1, stale: 1 } };
  const s = await createCodemap({ env: { ...fake.env, FAKE_OUT: JSON.stringify(out) } }).summary('/wt', 'aaa');
  assert.deepEqual(s.flows, { changed: 3, needsAnnotation: 2, missing: 1, stale: 1, line: '3 changed flows · 1 without annotation · 1 stale' });

  const one = { ...SUMMARY, flows: { changed: 1, needsAnnotation: 0, missing: 0, stale: 0 } };
  const s1 = await createCodemap({ env: { ...fake.env, FAKE_OUT: JSON.stringify(one) } }).summary('/wt', 'aaa');
  assert.equal(s1.flows.line, '1 changed flow · 0 without annotation · 0 stale');
});

test('annotationNote names the worktree and exact base, and says to do nothing when no segment needs annotation', () => {
  const note = createCodemap({ env: fakeCodemap().env }).annotationNote('/wt', 'abc123');
  assert.match(note, /codemap flows --repo \/wt --base abc123/);
  assert.match(note, /before .*\[\[turn:/);
  assert.match(note, /needsAnnotation/);
  assert.match(note, /codemap annotate --help/);
  assert.match(note, /do nothing/i);
});

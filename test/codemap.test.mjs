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

test('annotationNote works from the worktree, names the base and the reference branch, and says how to annotate', () => {
  const codemap = createCodemap({ env: fakeCodemap().env });
  const note = codemap.annotationNote('/a path/wt', 'abc123', 'develop');
  assert.match(note, /codemap flows --repo \. --base abc123/);
  assert.doesNotMatch(note, /a path/);
  assert.match(note, /codemap annotate --repo \. --base abc123/);
  assert.match(note, /before your final message with the turn marker/i);
  assert.match(note, /needsAnnotation/);
  assert.match(note, /codemap annotate --help/);
  assert.match(note, /stdin or --file/);
  assert.match(note, /do nothing/i);
  assert.match(note, /merged develop during this turn.*git merge-base develop HEAD.*instead/);
  assert.doesNotMatch(codemap.annotationNote('/wt', 'abc123', null), /merge-base/);
});

// A stand-in codemap with `flows --json` and `render`: flows prints $FLOWS_JSON, render writes an SVG naming its segment
// to --out, or fails with $RENDER_ERR for the segment named in $RENDER_FAIL.
function renderingCodemap(flows) {
  const fake = fakeCodemap();
  fs.writeFileSync(path.join(fake.dir, 'flows.json'), JSON.stringify(flows));
  fs.writeFileSync(path.join(fake.dir, 'codemap'), `#!/bin/sh
echo "$*" >> "${fake.dir}/calls.log"
case "$1" in
  flows) cat "${fake.dir}/flows.json" ;;
  render)
    seg=""; out=""
    while [ $# -gt 0 ]; do case "$1" in --segment) seg="$2";; --out) out="$2";; esac; shift; done
    if [ "$seg" = "$RENDER_FAIL" ]; then echo "codemap: render exploded for $seg" >&2; exit 1; fi
    printf '<svg xmlns="http://www.w3.org/2000/svg"><text>%s</text></svg>' "$seg" > "$out" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  return fake;
}
const seg = (id, over = {}) => ({ id, label: `Label of ${id}`, shapeHash: `h-${id}`, needsAnnotation: false, annotation: 'missing', ...over });
const FLOWS = (segments) => ({ base: { commit: 'aaa' }, after: { commit: 'bbb', dirty: false }, counts: {}, segments });

test('thumbnails render the first 3 flows, those asking for annotation first, each with its svg', async () => {
  const fake = renderingCodemap(FLOWS([
    seg('a', { annotation: 'current' }),
    seg('b', { needsAnnotation: true }),
    seg('c', { annotation: 'current' }),
    seg('d', { annotation: 'stale' }),
    seg('e', { needsAnnotation: true, annotation: 'current' }),
  ]));
  const { items } = await createCodemap({ env: fake.env }).thumbnails('/wt', 'aaa');
  assert.deepEqual(items.map(i => i.id), ['b', 'd', 'a']);
  assert.match(items[0].svg, /<text>b<\/text>/);
  assert.equal(items[0].label, 'Label of b');
  assert.equal(items[0].error, undefined);
  assert.equal(fake.calls()[0], 'flows --repo /wt --base aaa --json');
  const renders = fake.calls().filter(c => c.startsWith('render'));
  assert.equal(renders.length, 3);
  assert.match(renders[0], /^render --repo \/wt --base aaa --segment \w --out \S+\.svg$/);
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('ticket-viewer-thumb-')), [], 'temp files are removed');
});

test('a failed render shows its error on that thumbnail and does not stop the others', async () => {
  const fake = renderingCodemap(FLOWS([seg('a'), seg('b')]));
  const { items } = await createCodemap({ env: { ...fake.env, RENDER_FAIL: 'a' } }).thumbnails('/wt', 'aaa');
  assert.equal(items[0].svg, undefined);
  assert.equal(items[0].error, 'codemap: render exploded for a');
  assert.match(items[1].svg, /<text>b<\/text>/);
});

test('thumbnails are cached by what changes with the code, and render again when it does', async () => {
  const fake = renderingCodemap(FLOWS([seg('a')]));
  const codemap = createCodemap({ env: fake.env });
  const rendersOf = () => fake.calls().filter(c => c.startsWith('render')).length;
  await codemap.thumbnails('/wt', 'aaa');
  await codemap.thumbnails('/wt', 'aaa');
  assert.equal(rendersOf(), 1, 'same shape, same annotation: cached');
  fs.writeFileSync(path.join(fake.dir, 'flows.json'), JSON.stringify(FLOWS([seg('a', { shapeHash: 'changed' })])));
  await codemap.thumbnails('/wt', 'aaa');
  assert.equal(rendersOf(), 2, 'the code changed');
  fs.writeFileSync(path.join(fake.dir, 'flows.json'), JSON.stringify(FLOWS([seg('a', { shapeHash: 'changed', annotation: 'current', words: { title: 'Words', steps: {} } })])));
  await codemap.thumbnails('/wt', 'aaa');
  assert.equal(rendersOf(), 3, 'the annotation was written');
});

test('failed renders are not cached, so a retry runs again', async () => {
  const fake = renderingCodemap(FLOWS([seg('a')]));
  const codemap = createCodemap({ env: { ...fake.env, RENDER_FAIL: 'a' } });
  await codemap.thumbnails('/wt', 'aaa');
  await codemap.thumbnails('/wt', 'aaa');
  assert.equal(fake.calls().filter(c => c.startsWith('render')).length, 2);
});

test('thumbnails reject with codemap\'s message when flows fails, and old output without flows is an error', async () => {
  const fake = fakeCodemap();
  await assert.rejects(createCodemap({ env: { ...fake.env, FAKE_EXIT: '1', FAKE_ERR: 'codemap: nope' } }).thumbnails('/wt', 'aaa'), { message: 'codemap: nope' });
  await assert.rejects(createCodemap({ env: { ...fake.env, FAKE_OUT: '{}' } }).thumbnails('/wt', 'aaa'), /flows --json/);
});

test('a changed argument or label alone draws the flow again', async () => {
  const withStep = label => FLOWS([{ ...seg('a'), steps: [{ kind: 'call', id: 'a/0', label }] }]);
  const fake = renderingCodemap(withStep('Save(x)'));
  const codemap = createCodemap({ env: fake.env });
  await codemap.thumbnails('/wt', 'aaa');
  fs.writeFileSync(path.join(fake.dir, 'flows.json'), JSON.stringify(withStep('Save(y)')));
  await codemap.thumbnails('/wt', 'aaa');
  assert.equal(fake.calls().filter(c => c.startsWith('render')).length, 2);
});

test('concurrent requests share one flows call, and renders run one at a time', async () => {
  const fake = renderingCodemap(FLOWS([seg('a'), seg('b'), seg('c')]));
  const log = path.join(fake.dir, 'overlap.log');
  fs.writeFileSync(path.join(fake.dir, 'codemap'), `#!/bin/sh
echo "$*" >> "${fake.dir}/calls.log"
case "$1" in
  flows) sleep 0.2; cat "${fake.dir}/flows.json" ;;
  render)
    echo start >> "${log}"; sleep 0.1; echo end >> "${log}"
    while [ $# -gt 0 ]; do case "$1" in --out) out="$2";; esac; shift; done
    echo '<svg/>' > "$out" ;;
esac
`, { mode: 0o755 });
  const codemap = createCodemap({ env: fake.env });
  const [a, b] = await Promise.all([codemap.thumbnails('/wt', 'aaa'), codemap.thumbnails('/wt', 'aaa')]);
  assert.equal(fake.calls().filter(c => c.startsWith('flows')).length, 1);
  assert.equal(a.items.length, 3);
  assert.deepEqual(b, a);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['start', 'end', 'start', 'end', 'start', 'end']);
});

test('output over the limit is reported as such, not as a timeout', async () => {
  const fake = fakeCodemap();
  const codemap = createCodemap({ env: { ...fake.env, FAKE_OUT: 'x'.repeat(5000) }, maxOutputBytes: 1000 });
  await assert.rejects(codemap.summary('/wt', 'aaa'), e => /printed more than/.test(e.message) && !/timed out/.test(e.message));
});

test('a timeout kills codemap\'s whole process group, not just codemap', async () => {
  const fake = renderingCodemap(FLOWS([seg('a')]));
  const pidFile = path.join(fake.dir, 'child.pid');
  fs.writeFileSync(path.join(fake.dir, 'codemap'), `#!/bin/sh
case "$1" in flows) cat "${fake.dir}/flows.json" ;; render) sleep 30 & echo $! > "${pidFile}"; wait ;; esac
`, { mode: 0o755 });
  const { items } = await createCodemap({ env: fake.env, renderTimeoutMs: 300 }).thumbnails('/wt', 'aaa');
  assert.match(items[0].error, /timed out after/);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  let alive = true;
  for (let i = 0; i < 50 && alive; i++) {
    try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 20)); } catch { alive = false; }
  }
  assert.equal(alive, false, 'the extractor stand-in was killed too');
});

test('a descendant that outlives the kill and keeps the pipes open does not hang the request; the next one starts a new job', async () => {
  const fake = renderingCodemap(FLOWS([seg('a')]));
  const pidFile = path.join(fake.dir, 'holder.pid');
  fs.writeFileSync(path.join(fake.dir, 'codemap'), `#!/bin/sh
echo "$*" >> "${fake.dir}/calls.log"
case "$1" in
  flows) cat "${fake.dir}/flows.json" ;;
  render) setsid sleep 30 & echo $! > "${pidFile}"; wait ;;
esac
`, { mode: 0o755 });
  const codemap = createCodemap({ env: fake.env, renderTimeoutMs: 200 });
  try {
    const first = await Promise.race([codemap.thumbnails('/wt', 'aaa'), new Promise(r => setTimeout(() => r('hung'), 3000))]);
    assert.notEqual(first, 'hung', 'the request settles');
    assert.match(first.items[0].error, /timed out after/);
    await codemap.thumbnails('/wt', 'aaa');
    assert.equal(fake.calls().filter(c => c.startsWith('flows')).length, 2, 'a new job ran');
  } finally {
    try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* gone */ }
  }
});

test('a render that takes too long fails with a timeout message instead of holding the panel', async () => {
  const fake = renderingCodemap(FLOWS([seg('a')]));
  fs.writeFileSync(path.join(fake.dir, 'codemap'), `#!/bin/sh
case "$1" in flows) cat "${fake.dir}/flows.json" ;; render) sleep 5 ;; esac
`, { mode: 0o755 });
  const { items } = await createCodemap({ env: fake.env, renderTimeoutMs: 150 }).thumbnails('/wt', 'aaa');
  assert.match(items[0].error, /timed out/);
});

test('view can open on one segment', async () => {
  const fake = fakeCodemap();
  await createCodemap({ env: fake.env }).view('/wt', 'aaa', 'm:A.B(int)');
  assert.deepEqual(fake.calls(), ['view --repo /wt --base aaa --segment=m:A.B(int)']);
});

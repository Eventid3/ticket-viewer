import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { procProcesses, tlsScheme } from '../lib/processes.mjs';

const tmp = prefix => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

// A /proc look-alike: per-process cwd and fd symlinks, cmdline, stat, and net/tcp.
function fakeProc() {
  const root = tmp('proc-');
  fs.mkdirSync(path.join(root, 'net'));
  const tcp = ['  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'];
  fs.writeFileSync(path.join(root, 'net', 'tcp6'), tcp[0] + '\n');
  return {
    root,
    add(pid, { cwd, argv, pgid = pid, state = 'S', sockets = [] }) {
      const dir = path.join(root, String(pid));
      fs.mkdirSync(path.join(dir, 'fd'), { recursive: true });
      fs.symlinkSync(cwd, path.join(dir, 'cwd'));
      fs.writeFileSync(path.join(dir, 'cmdline'), argv.join('\0') + '\0');
      fs.writeFileSync(path.join(dir, 'stat'), `${pid} (${path.basename(argv[0])} x) ${state} 1 ${pgid} ${pgid} 0 -1`);
      sockets.forEach((inode, i) => fs.symlinkSync(`socket:[${inode}]`, path.join(dir, 'fd', String(10 + i))));
    },
    listen(inode, port, st = '0A') {
      tcp.push(`   ${tcp.length - 1}: 0100007F:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`);
      fs.writeFileSync(path.join(root, 'net', 'tcp'), tcp.join('\n') + '\n');
    },
  };
}

test('finds processes whose working folder is inside a folder, with pid, group, command and listening ports', () => {
  const wt = tmp('wt-');
  fs.mkdirSync(path.join(wt, 'src'));
  const proc = fakeProc();
  proc.add(100, { cwd: path.join(wt, 'src'), argv: ['dotnet', 'run'], sockets: [555, 556] });
  proc.add(101, { cwd: wt, argv: ['node', 'server.js'], pgid: 100 });
  proc.add(102, { cwd: `${wt}-other`, argv: ['vim'] });
  proc.add(103, { cwd: '/', argv: ['init'] });
  proc.listen(555, 5000);
  proc.listen(556, 40000, '01'); // an outgoing connection, not a listener

  const found = procProcesses(proc.root).find([wt]);
  assert.deepEqual(found[wt], [
    { pid: 100, pgid: 100, command: 'dotnet run', ports: [5000] },
    { pid: 101, pgid: 100, command: 'node server.js', ports: [] },
  ]);
});

test('leaves out Claude Code sessions and everything in their process groups', () => {
  const wt = tmp('wt-');
  const proc = fakeProc();
  proc.add(200, { cwd: wt, argv: ['claude bg-pty-host --bg-pty-host x.sock'] }); // a rewritten process title
  proc.add(201, { cwd: wt, argv: ['/home/u/.local/share/claude/versions/2.1.289', '--session-id', 'abc'] });
  proc.add(202, { cwd: wt, argv: ['node', 'mcp-server.js'], pgid: 201 });
  proc.add(203, { cwd: wt, argv: ['npm', 'run', 'dev'] });
  proc.add(204, { cwd: wt, argv: ['node', 'dead.js'], state: 'Z' });
  assert.deepEqual(procProcesses(proc.root).find([wt])[wt].map(p => p.pid), [203]);
});

test('skips processes it cannot read', () => {
  const wt = tmp('wt-');
  const proc = fakeProc();
  proc.add(300, { cwd: wt, argv: ['sleep', '100'] });
  fs.mkdirSync(path.join(proc.root, '301')); // exited between readdir and readlink
  fs.writeFileSync(path.join(proc.root, 'net', 'tcp'), '');
  assert.deepEqual(procProcesses(proc.root).find([wt])[wt].map(p => p.pid), [300]);
});

test('is unavailable without /proc', () => {
  assert.equal(procProcesses(path.join(os.tmpdir(), 'no-such-proc')), null);
});

test('finds a real server in a folder and kills its whole process group', { skip: !fs.existsSync('/proc/self/cwd') }, async () => {
  const wt = tmp('wt-');
  // A parent that starts a listening child, like `dotnet watch` and its app.
  const child = `require('http').createServer().listen(0, () => {}); setInterval(() => {}, 1000)`;
  const parent = spawn(process.execPath, ['-e', `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`],
    { cwd: wt, detached: true, stdio: 'ignore' });
  const lister = procProcesses();
  let found = [];
  for (let i = 0; i < 50 && !(found.length === 2 && found.some(p => p.ports.length)); i++) {
    await new Promise(r => setTimeout(r, 100));
    found = lister.find([wt])[wt];
  }
  assert.equal(found.length, 2);
  assert.ok(found.every(p => p.pgid === parent.pid));
  assert.ok(found.some(p => p.ports.length === 1));

  await lister.kill(parent.pid);
  assert.deepEqual(lister.find([wt])[wt], []);
});

const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));

function selfSignedCert() {
  const dir = tmp('cert-');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
  return { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) };
}
const hasOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('a port that completes a TLS handshake is https, even with a self-signed certificate', { skip: !hasOpenssl }, async t => {
  const server = https.createServer(selfSignedCert(), (_req, res) => res.end());
  t.after(() => { server.closeAllConnections(); server.close(); });
  assert.equal(await tlsScheme(await listen(server)), 'https');
});

test('a plain http port, a silent port and a closed port are http', async t => {
  const plain = http.createServer((_req, res) => res.end());
  const silent = net.createServer(() => {}); // accepts and never answers
  t.after(() => { plain.closeAllConnections(); plain.close(); silent.close(); });
  assert.equal(await tlsScheme(await listen(plain)), 'http');
  assert.equal(await tlsScheme(await listen(silent), { timeoutMs: 200 }), 'http');
  const gone = net.createServer();
  const closed = await listen(gone);
  await new Promise(r => gone.close(r));
  assert.equal(await tlsScheme(closed), 'http');
});

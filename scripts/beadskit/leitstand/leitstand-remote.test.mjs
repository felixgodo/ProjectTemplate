// node --test scripts/beadskit/leitstand/leitstand-remote.test.mjs
// Prüft nur `install --dry-run`: die Dienst-Dateien für Linux (systemd) und den Helfer (zwei Rechner).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'leitstand-remote');
const home = mkdtempSync(join(tmpdir(), 'leitstand-remote-test-'));
after(() => rmSync(home, { recursive: true, force: true }));

const install = (args, env = {}) => spawnSync(script, ['install', '--dry-run', ...args], {
  encoding: 'utf8',
  env: { ...process.env, BEADSKIT_HOME: home, LEITSTAND_PUBLIC_URL: 'https://l.example.org/100%', ...env },
});

test('Linux: systemd-Units für Leitstand und Rückkanal, KillMode=process, maskierte Werte', () => {
  rmSync(join(home, 'hosts.conf'), { force: true });
  const r = install([], { BK_UNAME: 'Linux' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /eu\.beadskit\.leitstand\.server\.service\n\[Unit\]/);
  assert.match(r.stdout, /ExecStart="[^"]*node" "[^"]*scripts\/beadskit\/leitstand\/inbox\.mjs"/);
  assert.match(r.stdout, /ExecStart="[^"]*ssh" "-N" .*"-R" "127\.0\.0\.1:13738:127\.0\.0\.1:3738" "server"/);
  assert.match(r.stdout, /KillMode=process/);
  assert.match(r.stdout, /Restart=always/);
  // % ist in systemd ein Platzhalter
  assert.match(r.stdout, /"LEITSTAND_PUBLIC_URL=https:\/\/l\.example\.org\/100%%"/);
  assert.doesNotMatch(r.stdout, /caffeinate|\.awake\.|\.link\./);
});

test('Helfer: nur ssh -L zum Leitrechner aus hosts.conf, nicht auf dem Leitrechner selbst', () => {
  writeFileSync(join(home, 'hosts.conf'), 'LEADER=pc\nHOSTS="mac pc"\nSELF=mac\nHOST_pc_SSH=felix@pc\n');
  const r = install(['--helper'], { BK_UNAME: 'Linux' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /eu\.beadskit\.leitstand\.link\.service/);
  assert.match(r.stdout, /"-L" "127\.0\.0\.1:3738:127\.0\.0\.1:3738" "felix@pc"/);
  assert.doesNotMatch(r.stdout, /\.server\.service|\.tunnel\.service/);
  writeFileSync(join(home, 'hosts.conf'), 'LEADER=pc\nSELF=pc\n');
  const self = install(['--helper'], { BK_UNAME: 'Linux' });
  assert.equal(self.status, 1);
  assert.match(self.stderr, /Leitrechner/);
  rmSync(join(home, 'hosts.conf'));
  assert.equal(install(['--helper'], { BK_UNAME: 'Linux' }).status, 1);
});

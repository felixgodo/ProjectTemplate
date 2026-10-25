// node --test scripts/beadskit/ci/runner-server.test.mjs
// Prüft die erzeugte compose.yml über `setup --dry-run`, ohne Server und ohne GitHub
// (RUNNER_COUNT und RUNNER_REPO gesetzt, das Token wird im Trockenlauf nicht geholt), dazu
// add/delete/stop mit falschen ssh und gh im PATH.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'runner-server');

function dryRun(env = {}) {
  return spawnSync('sh', [SCRIPT, 'setup', '--dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, RUNNER_COUNT: '2', RUNNER_REPO: 'owner/repo', RUNNER_LABEL: 'demo', ...env },
  });
}

test('Runner bekommen ein niedriges cpu_shares, damit der Host Vorrang hat', () => {
  const r = dryRun();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /x-runner: &runner[\s\S]*\n {2}cpus: 2\n {2}cpu_shares: 128\n/);
  // beide Runner erben den Anker
  assert.match(r.stdout, /runner-1:\n {4}<<: \*runner/);
  assert.match(r.stdout, /runner-2:\n {4}<<: \*runner/);
});

test('MySQL für DB-Tests läuft ebenfalls mit niedrigem cpu_shares', () => {
  const r = dryRun({ RUNNER_MYSQL: '8.0' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /mysql:\n[\s\S]*?\n {4}cpus: 1\n {4}cpu_shares: 128\n/);
});

test('RUNNER_CPU_SHARES ist einstellbar', () => {
  const r = dryRun({ RUNNER_CPU_SHARES: '256' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\n {2}cpu_shares: 256\n/);
});

for (const bad of ['0', '1', '-5', 'abc', '01']) {
  test(`RUNNER_CPU_SHARES=${bad} wird abgelehnt`, () => {
    const r = dryRun({ RUNNER_CPU_SHARES: bad });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /RUNNER_CPU_SHARES ungültig/);
  });
}

test('Runner und MySQL liegen in der gemeinsamen CI-Slice, setup schreibt und setzt sie', () => {
  const r = dryRun({ RUNNER_MYSQL: '8.0', RUNNER_CI_CPUS: '3', RUNNER_CI_MEM: '16G' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /x-runner: &runner[\s\S]*\n {2}cgroup_parent: beadskit-ci\.slice\n/);
  assert.match(r.stdout, /mysql:\n[\s\S]*?\n {4}cgroup_parent: beadskit-ci\.slice\n/);
  assert.match(r.stdout, /cat >\/etc\/systemd\/system\/beadskit-ci\.slice/);
  assert.match(r.stdout, /\nCPUQuota=300%\n/);
  assert.match(r.stdout, /\nMemoryMax=16G\n/);
  assert.match(r.stdout, /\nMemoryHigh=14745M\n/);
  assert.match(r.stdout, /systemctl set-property --runtime beadskit-ci\.slice CPUQuota=300% /);
});

for (const [name, bad] of [['RUNNER_CI_CPUS', '0'], ['RUNNER_CI_CPUS', '2.5'], ['RUNNER_CI_MEM', '16X'], ['RUNNER_CI_MEM', 'G'], ['RUNNER_CI_MEM', '1G2']]) {
  test(`${name}=${bad} wird abgelehnt`, () => {
    const r = dryRun({ [name]: bad });
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`${name} ungültig`));
  });
}

// Falsche ssh und gh im PATH: ssh nennt die Runner aus compose.yml (RUNNERS) und schreibt, was es
// per stdin bekommt, nach LOG; gh liefert nichts (kein Runner bei GitHub registriert)
function withFakes(args, runners) {
  const dir = mkdtempSync(join(tmpdir(), 'runner-server-'));
  const log = join(dir, 'remote.log');
  writeFileSync(join(dir, 'ssh'), `#!/bin/sh
case "$*" in
  *"sed -n"*compose.yml*) printf '%s\\n' $RUNNERS ;;
  *"bash -s") cat >>"$LOG" ;;
  *) echo "ssh $*" >>"$LOG" ;;
esac
`);
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(dir, 'ssh'), 0o755);
  chmodSync(join(dir, 'gh'), 0o755);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, RUNNERS: runners, LOG: log, RUNNER_REPO: 'owner/repo', RUNNER_LABEL: 'demo' };
  delete env.RUNNER_COUNT;
  const r = spawnSync('sh', [SCRIPT, ...args], { encoding: 'utf8', env });
  let remote = '';
  try { remote = readFileSync(log, 'utf8'); } catch { /* nichts gesendet */ }
  rmSync(dir, { recursive: true, force: true });
  return { ...r, remote };
}

test('delete n löscht genau diesen Runner, die anderen behalten ihre Nummern', () => {
  const r = withFakes(['delete', '2', '--force'], '1 2 3');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.remote, /docker compose stop runner-2\n/);
  assert.match(r.remote, /docker volume rm -f demo-runner_runner-2\n/);
  assert.match(r.remote, /\n {2}runner-1:\n/);
  assert.match(r.remote, /\n {2}runner-3:\n/);
  assert.doesNotMatch(r.remote, /\n {2}runner-2:/);
  assert.match(r.stdout, /demo-runner-2 gelöscht/);
});

test('delete ohne Nummer nimmt die höchste, auch bei Lücken', () => {
  const r = withFakes(['delete', '--force'], '1 3 5');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.remote, /docker compose stop runner-5\n/);
  assert.match(r.remote, /\n {2}runner-3:\n/);
});

test('delete einer unbekannten Nummer und des letzten Runners wird abgelehnt', () => {
  const missing = withFakes(['delete', '4', '--force'], '1 3');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Runner 4 gibt es nicht/);
  assert.equal(missing.remote, '');
  const last = withFakes(['delete', '3', '--force'], '3');
  assert.equal(last.status, 1);
  assert.match(last.stderr, /letzte Runner bleibt/);
  assert.equal(withFakes(['delete', 'x'], '1 2').status, 2);
});

test('add füllt die kleinste Lücke', () => {
  const r = withFakes(['add'], '1 3');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.remote, /docker compose up -d --no-recreate runner-2\n/);
  assert.match(r.remote, /\n {2}runner-1:\n[\s\S]*\n {2}runner-2:\n[\s\S]*\n {2}runner-3:\n/);
  assert.match(r.stdout, /demo-runner-2 hinzugefügt/);
});

test('stop prüft die Nummer gegen die vorhandenen Runner', () => {
  const r = withFakes(['stop', '2', '--force'], '1 3');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Runner 2 gibt es nicht/);
  const ok = withFakes(['stop', '3', '--force'], '1 3');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.remote, /docker compose stop runner-3/);
});

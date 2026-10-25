// node --test scripts/beadskit/ci/runner-server.test.mjs
// Prüft die erzeugte compose.yml über `setup --dry-run`, ohne Server und ohne GitHub
// (RUNNER_COUNT und RUNNER_REPO gesetzt, das Token wird im Trockenlauf nicht geholt).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

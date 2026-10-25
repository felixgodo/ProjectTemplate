// node --test scripts/beadskit/ci/runner-pool.test.mjs
// Prüft die Entscheidungen des Pool-Dienstes (`runner-pool-daemon plan`), eine Runde mit
// falschem curl/docker im PATH und das erzeugte Server-Skript (`runner-pool setup --dry-run`).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(HERE, 'runner-pool-daemon');
const POOL = join(HERE, 'runner-pool');

function plan(state) {
  const r = spawnSync('bash', [DAEMON, 'plan'], { input: JSON.stringify(state), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const job = (repo, label, created) => ({ repo, label, created });
const base = { slots: 4, now: 10_000, idleMax: 600, queued: [], containers: [], runners: [] };

test('plan: älteste Jobs zuerst über alle Repos, kleinste freie Plätze', () => {
  const p = plan({ ...base, slots: 2, queued: [
    job('o/b', 'b', '2026-10-25T10:00:03Z'),
    job('o/a', 'a', '2026-10-25T10:00:01Z'),
    job('o/a', 'a', '2026-10-25T10:00:02Z'),
  ] });
  assert.deepEqual(p.start, [{ repo: 'o/a', label: 'a', slot: 1 }, { repo: 'o/a', label: 'a', slot: 2 }]);
  assert.deepEqual(p.stop, []);
});

test('plan: ein freier Runner desselben Labels nimmt den Job, ein fremder nicht', () => {
  const p = plan({ ...base, queued: [job('o/a', 'a', '1'), job('o/b', 'b', '2')],
    containers: [{ name: 'pool-a-1', label: 'a', repo: 'o/a', slot: '1', started: 9_900 }],
    runners: [{ repo: 'o/a', name: 'pool-a-1', status: 'online', busy: false, id: 1 }] });
  assert.deepEqual(p.start, [{ repo: 'o/b', label: 'b', slot: 2 }]);
});

test('plan: belegte Plätze zählen, ein beschäftigter Runner nimmt keinen weiteren Job', () => {
  const p = plan({ ...base, slots: 2, queued: [job('o/a', 'a', '1'), job('o/a', 'a', '2')],
    containers: [{ name: 'pool-a-1', label: 'a', repo: 'o/a', slot: '2', started: 1 }],
    runners: [{ repo: 'o/a', name: 'pool-a-1', status: 'online', busy: true, id: 1 }] });
  assert.deepEqual(p.start, [{ repo: 'o/a', label: 'a', slot: 1 }]);
  assert.deepEqual(p.stop, []);
});

test('plan: ein Runner ohne Job wird nach idleMax beendet und sein Platz neu vergeben', () => {
  const p = plan({ ...base, slots: 1, queued: [job('o/b', 'b', '1')],
    containers: [{ name: 'pool-a-1', label: 'a', repo: 'o/a', slot: '1', started: 10_000 - 600 }],
    runners: [{ repo: 'o/a', name: 'pool-a-1', status: 'online', busy: false, id: 7 }] });
  assert.deepEqual(p.stop, [{ name: 'pool-a-1', repo: 'o/a', id: 7 }]);
  assert.deepEqual(p.start, [{ repo: 'o/b', label: 'b', slot: 1 }]);
});

test('plan: ein gerade gestarteter Runner (noch nicht bei GitHub) gilt als frei', () => {
  const p = plan({ ...base, queued: [job('o/a', 'a', '1')],
    containers: [{ name: 'pool-a-1', label: 'a', repo: 'o/a', slot: '1', started: 9_990 }] });
  assert.deepEqual(p.start, []);
  assert.deepEqual(p.stop, []);
});

test('plan: Pool-Runner bei GitHub ohne Container werden abgemeldet, nur offline', () => {
  const p = plan({ ...base,
    containers: [{ name: 'pool-a-2', label: 'a', repo: 'o/a', slot: '1', started: 9_990 }],
    runners: [
      { repo: 'o/a', name: 'pool-a-1', status: 'offline', busy: false, id: 1 },
      { repo: 'o/a', name: 'pool-a-2', status: 'offline', busy: false, id: 2 },
      { repo: 'o/a', name: 'pool-a-3', status: 'online', busy: false, id: 3 },
    ] });
  assert.deepEqual(p.forget, [{ repo: 'o/a', id: 1, name: 'pool-a-1' }]);
});

test('plan: ohne freie Plätze startet nichts', () => {
  const p = plan({ ...base, slots: 1, queued: [job('o/a', 'a', '1')],
    containers: [{ name: 'pool-b-1', label: 'b', repo: 'o/b', slot: '1', started: 1 }],
    runners: [{ repo: 'o/b', name: 'pool-b-1', status: 'online', busy: true, id: 1 }] });
  assert.deepEqual(p.start, []);
});

// Falsches curl (Antwort je URL aus FIXTURES/<pfad>.json) und docker (ps leer, run protokolliert)
function round(fixtures, conf) {
  const dir = mkdtempSync(join(tmpdir(), 'runner-pool-'));
  const fx = join(dir, 'fx');
  mkdirSync(fx);
  for (const [name, body] of Object.entries(fixtures)) writeFileSync(join(fx, name), JSON.stringify(body));
  const log = join(dir, 'log');
  writeFileSync(join(dir, 'curl'), `#!/bin/bash
url=\${@: -1}; path=\${url#*api.test/}; key=\${path//\\//_}; key=\${key%%\\?*}
echo "curl $*" >>"$LOG"
cat "$FX/$key" 2>/dev/null || echo '{}'
`);
  writeFileSync(join(dir, 'docker'), '#!/bin/bash\necho "docker $*" >>"$LOG"\n');
  chmodSync(join(dir, 'curl'), 0o755);
  chmodSync(join(dir, 'docker'), 0o755);
  writeFileSync(join(dir, 'pool.conf'), conf);
  writeFileSync(join(dir, 'token'), 'ghp_test\n');
  const r = spawnSync('bash', [DAEMON, 'once'], { encoding: 'utf8', env: {
    ...process.env, PATH: `${dir}:${process.env.PATH}`, FX: fx, LOG: log, GH_API: 'https://api.test',
    POOL_CONF: join(dir, 'pool.conf'), POOL_TOKEN_FILE: join(dir, 'token'), POOL_STATE: join(dir, 'state.json'),
  } });
  const out = { ...r, log: readFileSync(log, 'utf8'), state: JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) };
  rmSync(dir, { recursive: true, force: true });
  return out;
}

test('Runde: wartender Job → JIT-Runner im Pool-Container mit Slice, Grenzen und Platz-Volumes', () => {
  const r = round({
    'repos_o_a_actions_runs': { workflow_runs: [{ id: 11, head_branch: 'fix/x', display_title: 'Fix X' }] },
    'repos_o_a_actions_runs_11_jobs': { jobs: [
      { status: 'queued', labels: ['self-hosted', 'a'], created_at: '2026-10-25T10:00:00Z' },
      { status: 'queued', labels: ['ubuntu-latest'], created_at: '2026-10-25T10:00:00Z' },
    ] },
    'repos_o_a_actions_runners': { runners: [] },
    'repos_o_a_actions_runners_generate-jitconfig': { encoded_jit_config: 'JITCFG' },
  }, 'REPOS="o/a:a"\nSLOTS=2\nCPUS=1.5\nMEM=4g\n');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.log, /curl .*-X POST -d \{"name":"pool-a-[0-9]+-1","runner_group_id":1,"labels":\["self-hosted","Linux","X64","a"\]/);
  const run = r.log.split('\n').find((l) => l.startsWith('docker run'));
  assert.ok(run, r.log);
  for (const part of ['--rm', '--cgroup-parent beadskit-ci.slice', '--cpus 1.5', '--memory 4g', '--network beadskit-ci',
    '--label beadskit.pool=a', '--label beadskit.repo=o/a', '--label beadskit.slot=1',
    '-v beadskit-pool-tool-1:/home/runner/_work/_tool', '-v beadskit-pool-cache-1:/home/runner/.cache', '-e JIT=JITCFG']) {
    assert.ok(run.includes(part), `${part} fehlt in: ${run}`);
  }
  // nur ein Job passt zu den Labels
  assert.equal(r.log.split('\n').filter((l) => l.startsWith('docker run')).length, 1);
  assert.deepEqual(r.state.queued, { a: 1 });
  assert.equal(r.state.slots, 2);
});

test('Runde: ungültiger REPOS-Eintrag bricht ab', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-pool-'));
  writeFileSync(join(dir, 'pool.conf'), 'REPOS="o/a:A;rm"\n');
  const r = spawnSync('bash', [DAEMON, 'once'], { encoding: 'utf8',
    env: { ...process.env, POOL_CONF: join(dir, 'pool.conf'), POOL_TOKEN_FILE: '/dev/null' } });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /REPOS-Eintrag ungültig/);
});

// Projekte für setup --dry-run: je ein Verzeichnis mit beads.project.sh und Workflow
function projects(list) {
  const dir = mkdtempSync(join(tmpdir(), 'runner-pool-p-'));
  const paths = list.map(({ slug, repo, apt = '', mysql = '', selfHosted = true }) => {
    const p = join(dir, slug);
    mkdirSync(join(p, '.github/workflows'), { recursive: true });
    writeFileSync(join(p, 'beads.project.sh'),
      `BK_SLUG="${slug}"\nRUNNER_REPO="${repo}"\nRUNNER_APT="${apt}"\nRUNNER_MYSQL="${mysql}"\n`);
    writeFileSync(join(p, '.github/workflows/ci.yml'), `jobs:\n  t:\n    runs-on: ${selfHosted ? '[self-hosted, x]' : 'ubuntu-latest'}\n`);
    return p;
  });
  return { dir, paths };
}

function setupDry(list, env = {}) {
  const { dir, paths } = projects(list);
  const r = spawnSync('sh', [POOL, 'setup', '--dry-run'], { encoding: 'utf8',
    env: { ...process.env, POOL_PROJECTS: paths.join(' '), ...env } });
  rmSync(dir, { recursive: true, force: true });
  return r;
}

test('setup: Repos mit self-hosted, Pakete aller Projekte, MySQL, Slice und Dienst', () => {
  const r = setupDry([
    { slug: 'spot', repo: 'o/spot', apt: 'libnss3 libgbm1', mysql: '8.0' },
    { slug: 'regiehub', repo: 'o/BrightHub', apt: 'ffmpeg libnss3' },
    { slug: 'press', repo: 'o/press', selfHosted: false },
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\nREPOS="o\/spot:spot o\/BrightHub:regiehub"\n/);
  assert.match(r.stdout, /fonts-dejavu-core ffmpeg libgbm1 libnss3 /);
  assert.match(r.stdout, /--network-alias mysql[\s\S]*mysql:8\.0/);
  assert.match(r.stdout, /cat >\/etc\/systemd\/system\/beadskit-ci\.slice/);
  assert.match(r.stdout, /\nSlice=beadskit-ci\.slice\n/);
  assert.match(r.stdout, /chown -R runner:runner \/home\/runner\/_work \/home\/runner\/\.cache/);
  assert.match(r.stdout, /\nSLOTS=\$\{slots:-4\}\n/);
  assert.equal(spawnSync('bash', ['-n'], { input: r.stdout.replace(/^# ssh.*\n/, '') }).status, 0);
});

test('setup: ohne RUNNER_MYSQL wird die CI-MySQL entfernt, RUNNER_POOL_SLOTS gilt beim ersten Mal', () => {
  const r = setupDry([{ slug: 'a', repo: 'o/a' }], { RUNNER_POOL_SLOTS: '3' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /docker rm -f beadskit-ci-mysql/);
  assert.doesNotMatch(r.stdout, /--network-alias mysql/);
  assert.match(r.stdout, /\nSLOTS=\$\{slots:-3\}\n/);
});

test('setup: ungültige Pakete, Labels und Einstellungen werden abgelehnt', () => {
  assert.match(setupDry([{ slug: 'a', repo: 'o/a', apt: 'ffmpeg;rm' }]).stderr, /RUNNER_APT-Paket ungültig/);
  assert.match(setupDry([{ slug: 'A_b', repo: 'o/a' }]).stderr, /Repo\/Label ungültig/);
  assert.match(setupDry([{ slug: 'a', repo: 'o/a' }], { RUNNER_POOL_SLOTS: '9' }).stderr, /RUNNER_POOL_SLOTS ungültig/);
  assert.match(setupDry([{ slug: 'a', repo: 'o/a' }], { RUNNER_MEM: '6 g' }).stderr, /RUNNER_MEM ungültig/);
  assert.match(setupDry([{ slug: 'a', repo: 'o/a', selfHosted: false }]).stderr, /Kein Projekt/);
});

test('size und set-token prüfen ihre Eingaben, bevor sie den Server ansprechen', () => {
  const env = { ...process.env, RUNNER_SSH_HOST: 'nicht-vorhanden.invalid' };
  for (const n of ['0', '9', 'x']) {
    const r = spawnSync('sh', [POOL, 'size', n], { encoding: 'utf8', env });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Plätze: 1–8/);
  }
  const t = spawnSync('sh', [POOL, 'set-token'], { encoding: 'utf8', env, input: 'kein-token\n' });
  assert.equal(t.status, 1);
  assert.match(t.stderr, /nicht nach einem GitHub-Token/);
});

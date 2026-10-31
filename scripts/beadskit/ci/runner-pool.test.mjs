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
function round(fixtures, conf, limits, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'runner-pool-'));
  const fx = join(dir, 'fx');
  mkdirSync(fx);
  for (const [name, body] of Object.entries(fixtures)) writeFileSync(join(fx, name), JSON.stringify(body));
  const log = join(dir, 'log');
  writeFileSync(join(dir, 'curl'), `#!/bin/bash
url=\${@: -1}; path=\${url#*api.test/}; key=\${path//\\//_}; key=\${key%%\\?*}
echo "curl $*" >>"$LOG"
[ -z "$GH_FAIL" ] || [[ $path != "$GH_FAIL"* ]] || exit 22
cat "$FX/$key" 2>/dev/null || echo '{}'
`);
  writeFileSync(join(dir, 'docker'), '#!/bin/bash\necho "docker $*" >>"$LOG"\n');
  chmodSync(join(dir, 'curl'), 0o755);
  chmodSync(join(dir, 'docker'), 0o755);
  writeFileSync(join(dir, 'pool.conf'), conf);
  writeFileSync(join(dir, 'token'), 'ghp_test\n');
  if (limits !== undefined) writeFileSync(join(dir, 'projects.json'), typeof limits === 'string' ? limits : JSON.stringify(limits));
  const r = spawnSync('bash', [DAEMON, 'once'], { encoding: 'utf8', env: {
    ...process.env, PATH: `${dir}:${process.env.PATH}`, FX: fx, LOG: log, GH_API: 'https://api.test',
    POOL_CONF: join(dir, 'pool.conf'), POOL_TOKEN_FILE: join(dir, 'token'), POOL_STATE: join(dir, 'state.json'), POOL_LIMITS: join(dir, 'projects.json'),
    POOL_PRIO: join(dir, 'prio'), ...env, PATH: `${dir}:${env.BIN ? `${env.BIN}:` : ''}${process.env.PATH}`,
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
  assert.match(r.log, /curl .*-X POST -d \{"name":"pool-server-a-[0-9]{10}-1","runner_group_id":1,"labels":\["self-hosted","Linux","X64","a"\]/);
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

test('Runde: Lauf auf pending mit wartenden Jobs bekommt einen Runner und gilt nach STALE als hängend', () => {
  const recent = new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
  const r = round({
    'repos_o_a_actions_runs': { workflow_runs: [
      { id: 40, status: 'pending', head_branch: 'main', display_title: 'Merge', pull_requests: [] },
      { id: 41, status: 'queued', head_branch: 'fix/y', display_title: 'Fix Y', pull_requests: [] },
    ] },
    'repos_o_a_actions_runs_40_jobs': { jobs: [
      { status: 'queued', name: 'Module', labels: ['self-hosted', 'a', 'run-40'], created_at: '2026-10-28T11:48:36Z' },
    ] },
    'repos_o_a_actions_runs_41_jobs': { jobs: [
      { status: 'queued', name: 'App', labels: ['self-hosted', 'a', 'run-41'], created_at: recent },
    ] },
    'repos_o_a_actions_runners': { runners: [] },
    'repos_o_a_actions_runners_generate-jitconfig': { encoded_jit_config: 'JITCFG' },
  }, 'REPOS="o/a:a"\nSLOTS=2\n');
  assert.equal(r.status, 0, r.stderr);
  for (const st of ['queued', 'in_progress', 'pending']) assert.match(r.log, new RegExp(`actions/runs\\?status=${st}&`));
  // jede Abfrage liefert hier beide Läufe: trotzdem je Lauf nur ein Runner
  assert.match(r.log, /docker run .*--label beadskit\.run=run-40 /);
  assert.equal(r.log.split('\n').filter((l) => l.startsWith('docker run')).length, 2);
  assert.deepEqual(r.state.queue.map((q) => [q.run, q.jobs, q.runStatus, q.stale]),
    [[40, 1, 'pending', true], [41, 1, 'queued', false]]);
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

test('Runde: ungültiges STALE bricht ab', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-pool-'));
  writeFileSync(join(dir, 'pool.conf'), 'REPOS="o/a:a"\nSTALE=10m\n');
  const r = spawnSync('bash', [DAEMON, 'once'], { encoding: 'utf8',
    env: { ...process.env, POOL_CONF: join(dir, 'pool.conf'), POOL_TOKEN_FILE: '/dev/null' } });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /STALE ungültig/);
});

// Projekte für setup --dry-run: je ein Verzeichnis mit beads.project.sh und Workflow
function projects(list) {
  const dir = mkdtempSync(join(tmpdir(), 'runner-pool-p-'));
  const paths = list.map(({ slug, repo, apt = '', mysql = '', mariadb = '', selfHosted = true }) => {
    const p = join(dir, slug);
    mkdirSync(join(p, '.github/workflows'), { recursive: true });
    writeFileSync(join(p, 'beads.project.sh'),
      `BK_SLUG="${slug}"\nRUNNER_REPO="${repo}"\nRUNNER_APT="${apt}"\nRUNNER_MYSQL="${mysql}"\nRUNNER_MARIADB="${mariadb}"\n`);
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

test('setup: CI-MariaDB, sobald ein Projekt RUNNER_MARIADB setzt, neben der MySQL', () => {
  const r = setupDry([
    { slug: 'spot', repo: 'o/spot', mysql: '8.0' },
    { slug: 'controlhub', repo: 'o/LicenseHub', mariadb: '11' },
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--name beadskit-ci-mariadb [^\n]*--network-alias mariadb[\s\S]*-e MARIADB_ROOT_PASSWORD=ci mariadb:11 /);
  assert.match(r.stdout, /--name beadskit-ci-mysql [^\n]*--network-alias mysql[\s\S]*-e MYSQL_ROOT_PASSWORD=ci mysql:8\.0 /);
  assert.match(r.stdout, /\nREPOS="o\/spot:spot o\/LicenseHub:controlhub"\n/);
  const none = setupDry([{ slug: 'a', repo: 'o/a' }]);
  assert.match(none.stdout, /docker rm -f beadskit-ci-mariadb/);
  assert.match(setupDry([{ slug: 'a', repo: 'o/a', mariadb: '11;x' }]).stderr, /RUNNER_MARIADB ungültig/);
});

test('plan: Grenze je Projekt zählt laufende und freie Container, andere Projekte nutzen die Plätze', () => {
  const p = plan({ ...base, limits: { a: { max: 1 } }, queued: [
    job('o/a', 'a', '1'), job('o/a', 'a', '2'), job('o/a', 'a', '3'), job('o/b', 'b', '4'),
  ] });
  assert.deepEqual(p.start, [{ repo: 'o/a', label: 'a', slot: 1 }, { repo: 'o/b', label: 'b', slot: 2 }]);
  // ein beschäftigter Container von a belegt die Grenze schon
  const full = plan({ ...base, limits: { a: { max: 1 } }, queued: [job('o/a', 'a', '1')],
    containers: [{ name: 'pool-a-1', label: 'a', repo: 'o/a', slot: '1', started: 1 }],
    runners: [{ repo: 'o/a', name: 'pool-a-1', status: 'online', busy: true, id: 1 }] });
  assert.deepEqual(full.start, []);
  // ein freier Container von a darf den Job trotz Grenze übernehmen
  const idle = plan({ ...base, limits: { a: { max: 1 } }, queued: [job('o/a', 'a', '1'), job('o/a', 'a', '2')],
    containers: [{ name: 'pool-a-1', label: 'a', repo: 'o/a', slot: '1', started: 9_900 }],
    runners: [{ repo: 'o/a', name: 'pool-a-1', status: 'online', busy: false, id: 1 }] });
  assert.deepEqual(idle.start, []);
  assert.deepEqual(idle.stop, []);
});

test('plan: pausiertes Projekt bekommt keinen Runner, freie Container enden sofort, Jobs laufen zu Ende', () => {
  const p = plan({ ...base, limits: { a: { paused: true, max: null } }, queued: [job('o/a', 'a', '1'), job('o/b', 'b', '2')],
    containers: [
      { name: 'pool-a-1', label: 'a', repo: 'o/a', slot: '1', started: 9_990 },
      { name: 'pool-a-2', label: 'a', repo: 'o/a', slot: '2', started: 1 },
    ],
    runners: [
      { repo: 'o/a', name: 'pool-a-1', status: 'online', busy: false, id: 1 },
      { repo: 'o/a', name: 'pool-a-2', status: 'online', busy: true, id: 2 },
    ] });
  assert.deepEqual(p.stop, [{ name: 'pool-a-1', repo: 'o/a', id: 1 }]);
  assert.deepEqual(p.start, [{ repo: 'o/b', label: 'b', slot: 1 }]);
});

test('plan: ohne limits wie bisher', () => {
  const q = [job('o/a', 'a', '1'), job('o/a', 'a', '2')];
  assert.deepEqual(plan({ ...base, queued: q }).start, plan({ ...base, queued: q, limits: {} }).start);
  assert.equal(plan({ ...base, queued: q }).start.length, 2);
});

test('Runde: Grenzen aus projects.json (Ungültiges fällt weg) wirken und stehen im Zustand', () => {
  const fx = {
    'repos_o_a_actions_runs': { workflow_runs: [{ id: 11, head_branch: 'x', display_title: 'X' }] },
    'repos_o_a_actions_runs_11_jobs': { jobs: [
      { status: 'queued', labels: ['self-hosted', 'a'], created_at: '2026-10-25T10:00:00Z' },
    ] },
    'repos_o_a_actions_runners': { runners: [] },
    'repos_o_a_actions_runners_generate-jitconfig': { encoded_jit_config: 'JITCFG' },
  };
  const conf = 'REPOS="o/a:a"\nSLOTS=2\n';
  const paused = round(fx, conf, { a: { paused: true }, 'B;x': { max: 2 }, c: { max: 99 } });
  assert.equal(paused.status, 0, paused.stderr);
  assert.ok(!paused.log.includes('docker run'), paused.log);
  assert.deepEqual(paused.state.limits, { a: { max: null, paused: true }, c: { max: null, paused: false } });
  const broken = round(fx, conf, 'kein json');
  assert.equal(broken.status, 0, broken.stderr);
  assert.ok(broken.log.includes('docker run'), broken.log);
  assert.deepEqual(broken.state.limits, {});
});

const rjob = (repo, label, created, run, runLabel = `run-${run}`) => ({ repo, label, created, run, runLabel });

test('plan: vorgezogene Läufe zuerst, auch vor älteren Jobs anderer Repos, in Reihenfolge der Liste', () => {
  const p = plan({ ...base, slots: 2, prio: [{ repo: 'o/b', run: 9 }, { repo: 'o/a', run: 5 }], queued: [
    rjob('o/a', 'a', '1', 4), rjob('o/a', 'a', '3', 5), rjob('o/b', 'b', '4', 9),
  ] });
  assert.deepEqual(p.start, [{ repo: 'o/b', label: 'b', slot: 1, run: 'run-9' }, { repo: 'o/a', label: 'a', slot: 2, run: 'run-5' }]);
  // ohne prio wie bisher nach Alter
  assert.deepEqual(plan({ ...base, slots: 1, queued: [rjob('o/a', 'a', '3', 5), rjob('o/a', 'a', '1', 4)] }).start,
    [{ repo: 'o/a', label: 'a', slot: 1, run: 'run-4' }]);
});

test('plan: ein Runner mit Run-Label nimmt nur Jobs seines Laufs, Jobs ohne Run-Label wie bisher', () => {
  const cont = { name: 'pool-a-1', label: 'a', repo: 'o/a', slot: '1', started: 9_990, run: 'run-5' };
  const p = plan({ ...base, queued: [rjob('o/a', 'a', '1', 4), rjob('o/a', 'a', '2', 5)], containers: [cont] });
  assert.deepEqual(p.start, [{ repo: 'o/a', label: 'a', slot: 2, run: 'run-4' }]);
  // ein Job ohne Run-Label nimmt keinen Run-Runner, ein Runner ohne Run-Label nimmt ihn
  const old = plan({ ...base, queued: [job('o/a', 'a', '1')], containers: [cont] });
  assert.deepEqual(old.start, [{ repo: 'o/a', label: 'a', slot: 2 }]);
  const plain = plan({ ...base, queued: [job('o/a', 'a', '1')],
    containers: [{ name: 'pool-a-2', label: 'a', repo: 'o/a', slot: '1', started: 9_990 }] });
  assert.deepEqual(plain.start, []);
});

test('plan: Run-Runner ohne wartenden Job seines Laufs endet nach grace, nicht erst nach idleMax', () => {
  const cont = (started) => ({ name: 'pool-a-1', label: 'a', repo: 'o/a', slot: '1', started, run: 'run-5' });
  const gh = [{ repo: 'o/a', name: 'pool-a-1', status: 'online', busy: false, id: 3 }];
  assert.deepEqual(plan({ ...base, grace: 60, containers: [cont(10_000 - 60)], runners: gh }).stop, [{ name: 'pool-a-1', repo: 'o/a', id: 3 }]);
  assert.deepEqual(plan({ ...base, grace: 60, containers: [cont(10_000 - 30)], runners: gh }).stop, []);
  // wartet noch ein Job des Laufs, bleibt er bis idleMax
  assert.deepEqual(plan({ ...base, grace: 60, queued: [rjob('o/a', 'a', '1', 5)], containers: [cont(10_000 - 300)], runners: gh }).stop, []);
  // beschäftigt: nie
  assert.deepEqual(plan({ ...base, grace: 60, containers: [cont(1)], runners: [{ ...gh[0], busy: true }] }).stop, []);
});

test('Runde: Run-Label an JIT und Container, Warteschlange je Lauf mit PR im Zustand, prio wird aufgeräumt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-pool-prio-'));
  const prioFile = join(dir, 'prio');
  writeFileSync(prioFile, 'o/a 12\no/a 99\no/z 5\no/weg 3\nkaputt\n');
  const r = round({
    'repos_o_a_actions_runs': { workflow_runs: [
      { id: 11, head_branch: 'fix/x', display_title: 'Fix X', pull_requests: [{ number: 31 }], html_url: 'https://github.com/o/a/actions/runs/11' },
      { id: 12, head_branch: 'fix/y', display_title: 'Fix\tY', pull_requests: [], html_url: 'https://github.com/o/a/actions/runs/12' },
    ] },
    'repos_o_a_actions_runs_11_jobs': { jobs: [
      { status: 'queued', name: 'Backend', labels: ['self-hosted', 'a', 'run-11'], created_at: '2026-10-25T10:00:00Z' },
      { status: 'queued', name: 'Admin', labels: ['self-hosted', 'a', 'run-11'], created_at: '2026-10-25T10:00:01Z' },
    ] },
    'repos_o_a_actions_runs_12_jobs': { jobs: [
      { status: 'queued', name: 'App', labels: ['self-hosted', 'a', 'run-12'], created_at: '2026-10-25T11:00:00Z' },
    ] },
    'repos_o_a_actions_runners': { runners: [] },
    'repos_o_a_actions_runners_generate-jitconfig': { encoded_jit_config: 'JITCFG' },
    'repos_o_z_actions_runners': { runners: [] },
  }, 'REPOS="o/a:a o/z:z"\nSLOTS=1\n', undefined, { POOL_PRIO: prioFile, GH_FAIL: 'repos/o/z/actions/runs' });
  assert.equal(r.status, 0, r.stderr);
  // run 12 ist vorgezogen, obwohl jünger
  assert.match(r.log, /"labels":\["self-hosted","Linux","X64","a","run-12"\]/);
  assert.match(r.log, /docker run .*--label beadskit\.run=run-12 /);
  assert.deepEqual(r.state.queue.map((q) => [q.run, q.pr, q.jobs, q.prio, q.runLabel, q.branch]),
    [[12, null, 1, true, true, 'fix/y'], [11, 31, 2, false, true, 'fix/x']]);
  assert.equal(r.state.queue[1].url, 'https://github.com/o/a/actions/runs/11');
  assert.equal(r.state.queue[1].created, '2026-10-25T10:00:00Z');
  // 99 ist abgeschlossen, Ungültiges und o/weg (nicht im Pool) fallen weg; o/z war nicht lesbar und bleibt
  assert.equal(readFileSync(prioFile, 'utf8'), 'o/a 12\no/z 5\n');
  rmSync(dir, { recursive: true, force: true });
});

// limit/pause/resume: falsches ssh führt das Server-Skript lokal aus, /etc/beadskit-ci → Testordner
function poolCmd(args, { repos = 'o/a:a o/b:spot-x', limits } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'runner-pool-l-'));
  const etc = join(dir, 'etc');
  mkdirSync(etc);
  writeFileSync(join(etc, 'pool.conf'), `REPOS="${repos}"\nSLOTS=4\n`);
  if (limits !== undefined) writeFileSync(join(etc, 'projects.json'), limits);
  writeFileSync(join(dir, 'ssh'), `#!/bin/bash\n[ "\${@: -2:1}" = bash ] || { echo "ssh $*" >>"$ETC/ssh.log"; exit 0; }\nsed "s#/etc/beadskit-ci#$ETC#g" | bash -s\n`);
  chmodSync(join(dir, 'ssh'), 0o755);
  const r = spawnSync('sh', [POOL, ...args], { encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ETC: etc } });
  let file = null;
  try { file = JSON.parse(readFileSync(join(etc, 'projects.json'), 'utf8')); } catch { /* fehlt */ }
  rmSync(dir, { recursive: true, force: true });
  return { ...r, file };
}

test('limit, pause, resume schreiben projects.json und lassen andere Projekte stehen', () => {
  const l = poolCmd(['limit', 'a', '2'], { limits: '{"spot-x":{"paused":true}}' });
  assert.equal(l.status, 0, l.stderr);
  assert.deepEqual(l.file, { 'spot-x': { paused: true }, a: { max: 2 } });
  const p = poolCmd(['pause', 'a'], { limits: '{"a":{"max":2}}' });
  assert.deepEqual(p.file, { a: { max: 2, paused: true } });
  // leere Einträge fallen weg, eine kaputte Datei wird ersetzt
  assert.deepEqual(poolCmd(['resume', 'a'], { limits: '{"a":{"paused":true}}' }).file, {});
  assert.deepEqual(poolCmd(['limit', 'spot-x', 'off'], { limits: 'kaputt' }).file, {});
  assert.deepEqual(poolCmd(['limit', 'a', '8']).file, { a: { max: 8 } });
});

test('limit, pause, resume prüfen Label und Plätze', () => {
  const unknown = poolCmd(['pause', 'zz']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /nicht im Pool/);
  // Präfix eines anderen Labels zählt nicht
  assert.equal(poolCmd(['pause', 'spot']).status, 1);
  for (const args of [['limit', 'a', '0'], ['limit', 'a', '9'], ['limit', 'a', 'x']]) {
    const r = poolCmd(args);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /1–8 oder off/);
  }
  for (const l of ['A', 'a;rm', 'a b', '', '-x']) assert.equal(poolCmd(['pause', l]).status, 2, l);
  assert.equal(poolCmd(['pause']).status, 2);
  assert.equal(poolCmd(['limit', 'a']).status, 2);
});

// status --json: Server-Skripte lokal, state.json des Dienstes im Testordner, docker/systemctl leer
function poolStatus({ state, limits, prio } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'runner-pool-s-'));
  const etc = join(dir, 'etc');
  const run = join(dir, 'run');
  mkdirSync(etc);
  mkdirSync(run);
  writeFileSync(join(etc, 'pool.conf'), 'REPOS="o/a:a"\nSLOTS=3\n');
  if (state !== undefined) writeFileSync(join(run, 'state.json'), JSON.stringify(state));
  if (limits !== undefined) writeFileSync(join(etc, 'projects.json'), limits);
  if (prio !== undefined) writeFileSync(join(etc, 'prio'), prio);
  writeFileSync(join(dir, 'ssh'), `#!/bin/bash\nsed -e "s#/etc/beadskit-ci#$ETC#g" -e "s#/run/beadskit-runner-pool#$RUN#g" | bash -s\n`);
  for (const f of ['docker', 'systemctl']) writeFileSync(join(dir, f), '#!/bin/sh\nexit 0\n');
  for (const f of ['ssh', 'docker', 'systemctl']) chmodSync(join(dir, f), 0o755);
  const r = spawnSync('sh', [POOL, 'status', '--json'], { encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ETC: etc, RUN: run } });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('status --json: Grenzen und vorgezogene Läufe sofort aus den Dateien, nicht aus der letzten Runde', () => {
  const state = { at: '2026-10-26T10:00:00Z', slots: 4, limits: { a: { max: 5, paused: false } },
    queue: [{ repo: 'o/a', label: 'a', run: 11, prio: true }, { repo: 'o/a', label: 'a', run: 12, prio: false }] };
  const s = poolStatus({ state, limits: '{"a":{"max":2,"paused":true},"B":{"max":1},"c":{"max":9}}', prio: 'o/a 12\nkaputt\n' });
  assert.equal(s.slots, 3);
  assert.deepEqual(s.limits, { a: { max: 2, paused: true }, c: { max: null, paused: false } });
  assert.deepEqual(s.queue.map((q) => [q.run, q.prio]), [[11, false], [12, true]]);
  // Datei fehlt oder ist kaputt: keine Grenzen, wie im Dienst
  assert.deepEqual(poolStatus({ state }).limits, {});
  assert.deepEqual(poolStatus({ state, limits: 'kaputt' }).limits, {});
  assert.deepEqual(poolStatus({ state }).queue.map((q) => q.prio), [false, false]);
  // Dienst ohne Grenzen (Setup fehlt) bleibt null, auch wenn die Datei schon da ist
  assert.equal(poolStatus({ state: { slots: 4 }, limits: '{"a":{"max":2}}' }).limits, null);
  assert.equal(poolStatus().limits, null);
});

test('prio: an den Anfang, verschieben, herausnehmen, leeren; Repo muss im Pool sein', () => {
  const read = (r) => r.prio;
  assert.equal(read(prioCmd(['prio', 'o/a', '5'], 'o/b 3\n')), 'o/a 5\no/b 3\n');
  assert.equal(read(prioCmd(['prio', 'o/b', '3'], 'o/a 5\no/b 3\n')), 'o/b 3\no/a 5\n');
  assert.equal(read(prioCmd(['prio', '--off', 'o/a', '5'], 'o/b 3\no/a 5\n')), 'o/b 3\n');
  assert.equal(read(prioCmd(['prio', '--clear'], 'o/b 3\n')), '');
  assert.equal(read(prioCmd(['prio', 'o/a', '5'])), 'o/a 5\n');
  const unknown = prioCmd(['prio', 'o/zz', '1']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /nicht im Pool/);
  // Präfix eines anderen Repos zählt nicht
  assert.equal(prioCmd(['prio', 'o/b-x', '1'], undefined, 'o/a:a o/b:b').status, 1);
});

test('prio prüft Repo und Run-ID, bevor es den Server anspricht', () => {
  for (const args of [['prio', 'o/a;rm', '1'], ['prio', 'spot', '1'], ['prio', 'o/a', 'x'], ['prio', 'o/a', '1;2'],
    ['prio', '--off', 'o/a', ''], ['prio'], ['prio', 'o/a'], ['prio', '--clear', 'x'], ['prio', '-x', 'o/a', '1']]) {
    const r = prioCmd(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.ssh, '', args.join(' '));
  }
});

// prio: wie poolCmd, aber mit prio-Datei; ssh protokolliert jeden Aufruf
function prioCmd(args, prio, repos = 'o/a:a o/b:b') {
  const dir = mkdtempSync(join(tmpdir(), 'runner-pool-q-'));
  const etc = join(dir, 'etc');
  mkdirSync(etc);
  writeFileSync(join(etc, 'pool.conf'), `REPOS="${repos}"\nSLOTS=4\n`);
  if (prio !== undefined) writeFileSync(join(etc, 'prio'), prio);
  writeFileSync(join(dir, 'ssh'), `#!/bin/bash\necho "ssh $*" >>"$ETC/ssh.log"\nsed "s#/etc/beadskit-ci#$ETC#g" | bash -s\n`);
  chmodSync(join(dir, 'ssh'), 0o755);
  const r = spawnSync('sh', [POOL, ...args], { encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ETC: etc } });
  const rd = (f) => { try { return readFileSync(join(etc, f), 'utf8'); } catch { return null; } };
  const out = { ...r, prio: rd('prio'), ssh: rd('ssh.log') ?? '' };
  rmSync(dir, { recursive: true, force: true });
  return out;
}

// Zwei Rechner: Runner des anderen Rechners tragen Labels, mit Zeitstempel im Namen
const NOW = 2_000_000_000;
const two = { ...base, now: NOW, host: 'server' };
const pcRunner = (over = {}) => ({ repo: 'o/a', name: `pool-pc-a-${NOW - 10}-1`, status: 'online', busy: false, id: 9,
  labels: ['self-hosted', 'Linux', 'X64', 'a', 'run-5'], ...over });

test('plan: freier Runner des anderen Rechners versorgt den Job seines Laufs, einen anderen nicht', () => {
  assert.deepEqual(plan({ ...two, queued: [rjob('o/a', 'a', '1', 5)], runners: [pcRunner()] }).start, []);
  assert.deepEqual(plan({ ...two, queued: [rjob('o/a', 'a', '1', 4)], runners: [pcRunner()] }).start,
    [{ repo: 'o/a', label: 'a', slot: 1, run: 'run-4' }]);
  // beschäftigt: versorgt nichts
  assert.equal(plan({ ...two, queued: [rjob('o/a', 'a', '1', 5)], runners: [pcRunner({ busy: true })] }).start.length, 1);
});

test('plan: gerade registrierter Runner des anderen Rechners zählt, einer vom abgestürzten Rechner nicht', () => {
  const fresh = pcRunner({ status: 'offline' });
  assert.deepEqual(plan({ ...two, queued: [rjob('o/a', 'a', '1', 5)], runners: [fresh] }).start, []);
  const dead = pcRunner({ status: 'offline', name: `pool-pc-a-${NOW - 500}-1` });
  assert.equal(plan({ ...two, queued: [rjob('o/a', 'a', '1', 5)], runners: [dead] }).start.length, 1);
});

test('plan: Grenze je Projekt gilt über beide Rechner', () => {
  const p = plan({ ...two, limits: { a: { max: 1 } }, queued: [rjob('o/a', 'a', '1', 4)], runners: [pcRunner({ busy: true })] });
  assert.deepEqual(p.start, []);
});

test('plan: ohne Grenze deckeln nur die eigenen Plätze, nicht die Runner des anderen Rechners', () => {
  const q = [4, 6, 7, 8, 9].map((r) => rjob('o/a', 'a', String(r), r));
  const busy = [1, 2, 3].map((k) => pcRunner({ busy: true, name: `pool-pc-a-${NOW - 10}-${k}`, id: k }));
  assert.equal(plan({ ...two, queued: q, runners: busy }).start.length, 4);
});

test('plan: fremde offline-Runner werden nie vergessen, eigene schon', () => {
  const p = plan({ ...two, runners: [
    pcRunner({ status: 'offline', name: 'pool-pc-a-1000000000-1', id: 1 }),
    { repo: 'o/a', name: 'pool-server-a-1000000000-1', status: 'offline', busy: false, id: 2 },
  ] });
  assert.deepEqual(p.forget, [{ repo: 'o/a', id: 2, name: 'pool-server-a-1000000000-1' }]);
});

test('plan: Drain startet nichts, beendet freie Runner sofort und lässt belegte laufen', () => {
  const p = plan({ ...two, drain: true, queued: [rjob('o/a', 'a', '1', 7)],
    containers: [
      { name: 'pool-server-a-1-1', label: 'a', repo: 'o/a', slot: '1', started: NOW - 5 },
      { name: 'pool-server-a-1-2', label: 'a', repo: 'o/a', slot: '2', started: 1 },
    ],
    runners: [
      { repo: 'o/a', name: 'pool-server-a-1-1', status: 'online', busy: false, id: 1 },
      { repo: 'o/a', name: 'pool-server-a-1-2', status: 'online', busy: true, id: 2 },
    ] });
  assert.deepEqual(p.start, []);
  assert.deepEqual(p.stop, [{ name: 'pool-server-a-1-1', repo: 'o/a', id: 1 }]);
});

const qfx = {
  'repos_o_a_actions_runs': { workflow_runs: [{ id: 11, head_branch: 'x', display_title: 'X' }] },
  'repos_o_a_actions_runs_11_jobs': { jobs: [{ status: 'queued', labels: ['self-hosted', 'a', 'run-11'], created_at: '2026-10-25T10:00:00Z' }] },
  'repos_o_a_actions_runners': { runners: [] },
  'repos_o_a_actions_runners_generate-jitconfig': { encoded_jit_config: 'JITCFG' },
};

test('Runde: hosts.json setzt Plätze und Drain nur für den eigenen Rechner, Name trägt den Rechner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-pool-h-'));
  const file = join(dir, 'hosts.json');
  writeFileSync(file, '{"server":{"drain":true},"pc":{"slots":3}}');
  const drained = round(qfx, 'REPOS="o/a:a"\nSLOTS=2\n', undefined, { POOL_HOSTS: file });
  assert.ok(!drained.log.includes('docker run'), drained.log);
  assert.equal(drained.state.drain, true);
  const pc = round(qfx, 'REPOS="o/a:a"\nSLOTS=2\nHOST=pc\n', undefined, { POOL_HOSTS: file });
  assert.match(pc.log, /docker run .*--name pool-pc-a-[0-9]{10}-1 /);
  assert.equal(pc.state.slots, 3);
  assert.equal(pc.state.host, 'pc');
  assert.equal(pc.state.drain, false);
  // kaputte Datei: keine Einschränkung
  writeFileSync(file, 'kaputt');
  assert.ok(round(qfx, 'REPOS="o/a:a"\nSLOTS=2\n', undefined, { POOL_HOSTS: file }).log.includes('docker run'));
  rmSync(dir, { recursive: true, force: true });
});

test('Runde: Satellit holt Steuerdateien, legt seinen Zustand ab und räumt prio nicht auf', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-pool-u-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'ssh'), `#!/bin/bash
echo "ssh $*" >>"$SSHLOG"
case "$*" in
  *mkdir*) cat >"$PUSHED" ;;
  *) [ -z "$SSH_DOWN" ] || exit 255
     printf '{"a":{"max":2}}\\n\\n---\\no/a 999\\n---\\n{"pc":{"drain":true}}\\n' ;;
esac
`);
  chmodSync(join(bin, 'ssh'), 0o755);
  const env = { BIN: bin, SSHLOG: join(dir, 'ssh.log'), PUSHED: join(dir, 'pushed.json'),
    POOL_LIMITS: join(dir, 'projects.json'), POOL_PRIO: join(dir, 'prio'), POOL_HOSTS: join(dir, 'hosts.json') };
  const conf = 'REPOS="o/a:a"\nSLOTS=2\nHOST=pc\nUPSTREAM=server\n';
  const r = round(qfx, conf, undefined, env);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.log.includes('docker run'), 'Drain der Zentrale gilt auf dem Satelliten');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'pushed.json'), 'utf8')).limits, { a: { max: 2, paused: false } });
  assert.equal(readFileSync(join(dir, 'prio'), 'utf8'), 'o/a 999\n');
  // Zentrale weg: letzte Kopie gilt weiter, die Runde läuft durch
  const down = round(qfx, conf, undefined, { ...env, SSH_DOWN: '1' });
  assert.equal(down.status, 0, down.stderr);
  assert.ok(!down.log.includes('docker run'), 'letzte Kopie (Drain) gilt');
  rmSync(dir, { recursive: true, force: true });
});

test('setup --host: user-Dienst, Satellit-Konfiguration, Netztrennung, kein Schreiben nach /etc außer im root-Teil', () => {
  const { dir, paths } = projects([{ slug: 'spot', repo: 'o/spot', mysql: '8.0' }]);
  const r = spawnSync('sh', [POOL, 'setup', '--host', 'pc', '--dry-run'], { encoding: 'utf8',
    env: { ...process.env, POOL_PROJECTS: paths.join(' '), HOME: dir } });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\nHOST=pc\nUPSTREAM=server\n/);
  assert.match(r.stdout, /\nPOLL=30\n/);
  assert.match(r.stdout, /CPUQuota=800%/);
  assert.match(r.stdout, /MemoryMax=18G/);
  assert.match(r.stdout, /docker network create --subnet 172\.30\.77\.0\/24 beadskit-ci/);
  assert.match(r.stdout, /iptables -A BEADSKIT-CI -d "\$n" -j REJECT/);
  assert.match(r.stdout, /systemctl --user restart beadskit-runner-pool\.service/);
  assert.equal(spawnSync('bash', ['-n'], { input: r.stdout.replace(/^# ssh.*\n/, '') }).status, 0);
  const user = r.stdout.slice(r.stdout.indexOf('\nROOT\n'));
  assert.doesNotMatch(user, /cat >\/etc\//);
});

test('drain und size --host prüfen ihre Eingaben, bevor sie den Server ansprechen', () => {
  for (const args of [['drain'], ['drain', 'pc', 'x'], ['drain', 'P;c'], ['drain', '-x'], ['size', '3', '--host', 'A b'], ['size', '3', 'pc']]) {
    const r = poolCmd(args);
    assert.equal(r.status, 2, args.join(' '));
  }
  assert.equal(spawnSync('sh', [POOL, 'setup', '--host', 'server', '--dry-run'], { encoding: 'utf8' }).status, 2);
});

function hostCmd(args, { hosts, known } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'runner-pool-d-'));
  const etc = join(dir, 'etc');
  const run = join(dir, 'run');
  mkdirSync(etc);
  mkdirSync(join(run, 'hosts'), { recursive: true });
  if (hosts !== undefined) writeFileSync(join(etc, 'hosts.json'), hosts);
  if (known) writeFileSync(join(run, 'hosts', `${known}.json`), '{}');
  writeFileSync(join(dir, 'ssh'), `#!/bin/bash\nsed -e "s#/etc/beadskit-ci#$ETC#g" -e "s#/run/beadskit-runner-pool#$RUN#g" | bash -s\n`);
  chmodSync(join(dir, 'ssh'), 0o755);
  const r = spawnSync('sh', [POOL, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ETC: etc, RUN: run } });
  let file = null;
  try { file = JSON.parse(readFileSync(join(etc, 'hosts.json'), 'utf8')); } catch { /* fehlt */ }
  rmSync(dir, { recursive: true, force: true });
  return { ...r, file };
}

test('drain und size --host schreiben hosts.json, unbekannte Rechner werden abgelehnt', () => {
  assert.deepEqual(hostCmd(['drain', 'pc'], { known: 'pc' }).file, { pc: { drain: true } });
  assert.deepEqual(hostCmd(['drain', 'server']).file, { server: { drain: true } });
  assert.deepEqual(hostCmd(['drain', 'pc', '--off'], { hosts: '{"pc":{"drain":true,"slots":3}}' }).file, { pc: { slots: 3 } });
  assert.deepEqual(hostCmd(['drain', 'pc', '--off'], { hosts: '{"pc":{"drain":true}}' }).file, {});
  assert.deepEqual(hostCmd(['size', '6', '--host', 'pc'], { known: 'pc' }).file, { pc: { slots: 6 } });
  const typo = hostCmd(['drain', 'pcc']);
  assert.equal(typo.status, 1);
  assert.match(typo.stderr, /nicht im Pool/);
});

test('status --json: Rechner mit Drain sofort aus der Datei, Satellit offline nach 90 s, Runner zusammengeführt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-pool-t-'));
  const etc = join(dir, 'etc');
  const run = join(dir, 'run');
  mkdirSync(etc);
  mkdirSync(join(run, 'hosts'), { recursive: true });
  writeFileSync(join(etc, 'pool.conf'), 'REPOS="o/a:a"\nSLOTS=3\n');
  writeFileSync(join(etc, 'hosts.json'), '{"pc":{"drain":true,"slots":5}}');
  writeFileSync(join(etc, 'beadskit-runner-pool.service'), '');
  const iso = (ago) => new Date(Date.now() - ago * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  writeFileSync(join(run, 'state.json'), JSON.stringify({ at: iso(1), host: 'server', slots: 3,
    runners: [{ name: 'pool-server-a-1-1', busy: true, label: 'a' }] }));
  const pc = (ago) => JSON.stringify({ at: iso(ago), host: 'pc', slots: 4, runners: [{ name: 'pool-pc-a-1-1', busy: true, label: 'a', cpu: 50, mem: 1024 }] });
  writeFileSync(join(dir, 'ssh'), `#!/bin/bash\nsed -e "s#/etc/systemd/system#$ETC#g" -e "s#/etc/beadskit-ci#$ETC#g" -e "s#/run/beadskit-runner-pool#$RUN#g" | bash -s\n`);
  for (const f of ['docker', 'systemctl']) writeFileSync(join(dir, f), '#!/bin/sh\n[ "$1 $2" = "is-active beadskit-runner-pool.service" ] && echo active\nexit 0\n');
  for (const f of ['ssh', 'docker', 'systemctl']) chmodSync(join(dir, f), 0o755);
  const status = () => {
    const r = spawnSync('sh', [POOL, 'status', '--json'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ETC: etc, RUN: run } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  writeFileSync(join(run, 'hosts', 'pc.json'), pc(5));
  const s = status();
  assert.deepEqual(s.hosts.map((h) => [h.name, h.drain, h.slots, h.online, h.busy]), [['server', false, 3, true, 1], ['pc', true, 5, true, 1]]);
  assert.deepEqual(s.runners.map((r) => [r.name, r.host, r.stale, r.cpu]),
    [['pool-server-a-1-1', 'server', false, null], ['pool-pc-a-1-1', 'pc', false, 50]]);
  writeFileSync(join(run, 'hosts', 'pc.json'), pc(120));
  const off = status();
  assert.equal(off.hosts[1].online, false);
  assert.equal(off.runners[1].stale, true);
  rmSync(dir, { recursive: true, force: true });
});

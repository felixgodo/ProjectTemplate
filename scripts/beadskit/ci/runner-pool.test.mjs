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
    POOL_PRIO: join(dir, 'prio'), ...env,
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
  writeFileSync(prioFile, 'o/a 12\no/a 99\no/z 5\nkaputt\n');
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
  }, 'REPOS="o/a:a"\nSLOTS=1\n', undefined, { POOL_PRIO: prioFile });
  assert.equal(r.status, 0, r.stderr);
  // run 12 ist vorgezogen, obwohl jünger
  assert.match(r.log, /"labels":\["self-hosted","Linux","X64","a","run-12"\]/);
  assert.match(r.log, /docker run .*--label beadskit\.run=run-12 /);
  assert.deepEqual(r.state.queue.map((q) => [q.run, q.pr, q.jobs, q.prio, q.runLabel, q.branch]),
    [[12, null, 1, true, true, 'fix/y'], [11, 31, 2, false, true, 'fix/x']]);
  assert.equal(r.state.queue[1].url, 'https://github.com/o/a/actions/runs/11');
  assert.equal(r.state.queue[1].created, '2026-10-25T10:00:00Z');
  // 99 ist abgeschlossen, Ungültiges fällt weg; o/z wurde nicht gelesen und bleibt
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

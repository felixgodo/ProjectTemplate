// node --test scripts/beadskit/workers.test.mjs
// Ruft scripts/beadskit/workers in einem Wegwerf-Repo mit eigener beads.project.sh (code plus
// Workspace clubs, zweites Repo) und einem gefälschten `claude` auf dem PATH auf.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'workers');

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'workers-test-')));
after(() => rmSync(dir, { recursive: true, force: true }));

// Wie das echte claude: stop/logs/attach scheitern an einem Namen, den mehrere Sessions tragen
writeFileSync(join(dir, 'claude'), `#!/bin/sh
case $1 in
  agents) cat "$FAKE_AGENTS" ;;
  stop|logs|attach)
    echo "$1 $2" >>"$FAKE_LOG"
    n=$(jq --arg r "$2" '[.[] | select(.id == $r or .name == $r)] | length' "$FAKE_AGENTS")
    [ "$n" = 1 ] || { echo "No job matching '$2'." >&2; exit 1; }
    echo "stopped $2" ;;
esac
`);
chmodSync(join(dir, 'claude'), 0o755);

const PROJECT = `BK_NAME="Spot"
BK_SLUG="spot"
BK_MODULES="admin app side"
BK_WORKSPACES="clubs"
BK_WS_clubs_NAME="Clubs"
BK_WS_clubs_ROLES="club-search club-add club-settings club-test"
BK_WS_clubs_START="club-search=1 club-add=1 club-settings=2 club-test=1"
BK_WS_clubs_PHASES="place:Anlegen settings test:Test"
BK_REPOS="side:../side"
bk_prompt() {
  case $1 in
    club-search) echo "/loop 30m /spot-club-search" ;;
    club-add|club-settings) echo "/loop 10m /spot-$1" ;;
    club-test) echo "/loop 15m /spot-club-test" ;;
  esac
}
bk_color() { case $1 in club-add) echo "230 120 30" ;; esac; }
`;

// Eigenes Repo mit Worktrees fix-3 und club-add-1: die Drain-Markierungen liegen in dessen
// Common-Dir, nicht im echten Repo, wo laufende Worker sie sehen würden.
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
let repo = null;
function testRepo() {
  if (repo) return repo;
  const r = join(dir, 'repo');
  mkdirSync(join(r, 'scripts/beadskit'), { recursive: true });
  copyFileSync(script, join(r, 'scripts/beadskit/workers'));
  writeFileSync(join(r, 'beads.project.sh'), PROJECT);
  // bdw-Ersatz: show liefert Labels aus FAKE_LABELS
  writeFileSync(join(r, 'scripts/beadskit/bdw'), '#!/bin/sh\n[ "$1" = show ] && printf \'[{"id":"%s","labels":%s}]\' "$2" "${FAKE_LABELS:-[]}"\n');
  chmodSync(join(r, 'scripts/beadskit/bdw'), 0o755);
  git(dir, 'init', '-q', r);
  git(r, 'add', '.');
  git(r, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  mkdirSync(join(dir, 'side'));
  for (const name of ['fix-3', 'club-add-1']) git(r, 'worktree', 'add', '-q', join(r, '.claude/worktrees', name));
  const marker = join(git(r, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim(), 'spot-workers-drain');
  const log = join(dir, 'log');
  const workers = (cwd, args, agents = [], extra = {}) => {
    const agentsFile = join(dir, 'repo-agents.json');
    writeFileSync(agentsFile, JSON.stringify(agents));
    writeFileSync(log, '');
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_AGENTS: agentsFile, FAKE_LOG: log,
      BEADSKIT_HOME: join(dir, 'home'), ...extra };
    delete env.npm_config_bg;
    delete env.npm_config_dry_run;
    const res = spawnSync(join(cwd, 'scripts/beadskit/workers'), args, { cwd, encoding: 'utf8', env });
    return { ...res, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
  };
  repo = { root: r, marker, workers, wt: (name) => join(r, '.claude/worktrees', name) };
  return repo;
}
const clearMarkers = ({ marker }) => {
  for (const s of ['', '-fix', '-verify', '-search', '-regress', '-club-search', '-club-add', '-club-settings', '-club-test']) {
    rmSync(`${marker}${s}`, { force: true });
  }
};

const live = (id, name) => ({ id, pid: 100, kind: 'background', name, status: 'idle', cwd: testRepo().wt(name) });
// Gestoppte Session: claude agents führt sie weiter, ohne Prozess, im Repo-Wurzelordner
const stale = (id, name) => ({ id, pid: null, kind: 'background', name, status: null, cwd: testRepo().root });
const run = (agents, ...args) => testRepo().workers(testRepo().root, args, agents);

test('stop --all stoppt über die Session-ID, auch wenn eine gestoppte Session gleich heißt', () => {
  const r = run([stale('old00001', 'fix-4'), live('aaaa0001', 'fix-4'), live('bbbb0002', 'verify-3')], 'stop', '--all');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls.sort(), ['stop aaaa0001', 'stop bbbb0002']);
});

test('stop --all macht nach einem Fehler mit den übrigen weiter und meldet ihn', () => {
  // Zwei laufende Sessions mit derselben ID: die erste scheitert im Fake, die dritte muss trotzdem drankommen
  const r = run([live('dup00001', 'fix-1'), live('dup00001', 'fix-2'), live('cccc0003', 'fix-3')], 'stop', '--all');
  assert.equal(r.status, 1);
  assert.deepEqual(r.calls, ['stop dup00001', 'stop dup00001', 'stop cccc0003']);
  assert.match(r.stderr, /nicht gestoppt: fix-1 fix-2/);
});

test('stop --all ohne Worker tut nichts', () => {
  const r = run([stale('old00001', 'fix-4')], 'stop', '--all');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, []);
});

test('stop, logs und attach eines Workers nehmen die Session-ID', () => {
  const agents = [stale('old00001', 'fix-4'), live('aaaa0001', 'fix-4')];
  for (const cmd of ['stop', 'logs', 'attach']) {
    const r = run(agents, cmd, 'fix-4');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.calls, [`${cmd} aaaa0001`]);
  }
});

test('drain-check meldet globalen und Rollen-Drain, Rolle aus dem Worktree-Namen', () => {
  const { marker, workers, wt: w } = testRepo();
  clearMarkers(testRepo());
  const fix3 = w('fix-3');
  const check = (...args) => {
    const r = workers(fix3, ['drain-check', ...args]);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };

  assert.equal(check(), 'kein Drain');
  writeFileSync(`${marker}-verify`, '');
  assert.equal(check(), 'kein Drain');
  assert.equal(check('verify'), 'DRAIN (Rolle verify)');
  writeFileSync(`${marker}-fix`, '');
  assert.equal(check(), 'DRAIN (Rolle fix)');
  rmSync(`${marker}-fix`);
  writeFileSync(marker, '');
  assert.equal(check(), 'DRAIN (alle Worker)');
  // drain --off räumt alles weg, auch die Rollenmarkierung
  assert.equal(workers(fix3, ['drain', '--off']).status, 0);
  assert.equal(check('verify'), 'kein Drain');
});

test('drain-check im Worktree club-add-1 nimmt die Rolle club-add, drain --ws clubs markiert alle Club-Rollen', () => {
  const { marker, workers, wt: w } = testRepo();
  clearMarkers(testRepo());
  const club = w('club-add-1');
  const check = () => workers(club, ['drain-check']).stdout.trim();
  assert.equal(check(), 'kein Drain');
  writeFileSync(`${marker}-club-add`, '');
  assert.equal(check(), 'DRAIN (Rolle club-add)');
  assert.equal(workers(club, ['drain', 'club-add', '--off']).status, 0);
  assert.equal(check(), 'kein Drain');

  const r = workers(club, ['drain', '--ws', 'clubs']);
  assert.equal(r.status, 0, r.stderr);
  for (const role of ['club-search', 'club-add', 'club-settings', 'club-test']) {
    assert.equal(existsSync(`${marker}-${role}`), true, role);
  }
  assert.equal(existsSync(`${marker}-fix`), false);
  assert.equal(existsSync(marker), false);
  assert.equal(check(), 'DRAIN (Rolle club-add)');
  assert.equal(workers(w('fix-3'), ['drain-check']).stdout.trim(), 'kein Drain');
  assert.equal(workers(club, ['drain', '--ws', 'clubs', '--off']).status, 0);
  assert.equal(check(), 'kein Drain');
  assert.notEqual(workers(club, ['drain', '--ws', 'nix']).status, 0);
  assert.notEqual(workers(club, ['drain', 'club-nix']).status, 0);
});

const launches = (out) => out.split('\n').filter((l) => l.startsWith('iTerm-Tab '));

test('start --ws clubs --dry-run plant die vier Club-Rollen mit ihren Prompts', () => {
  const { root, workers } = testRepo();
  clearMarkers(testRepo());
  const r = workers(root, ['start', '--ws', 'clubs', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(launches(r.stdout), [
    "iTerm-Tab club-search-1: claude -w club-search-1 -n club-search-1 '/loop 30m /spot-club-search'",
    "iTerm-Tab club-add-1: claude -w club-add-1 -n club-add-1 '/loop 10m /spot-club-add'",
    "iTerm-Tab club-settings-1: claude -w club-settings-1 -n club-settings-1 '/loop 10m /spot-club-settings'",
    "iTerm-Tab club-settings-2: claude -w club-settings-2 -n club-settings-2 '/loop 10m /spot-club-settings'",
    "iTerm-Tab club-test-1: claude -w club-test-1 -n club-test-1 '/loop 15m /spot-club-test'",
  ]);
  // laufende Worker werden übersprungen, Workspace aus den Rollen abgeleitet, --bg ohne iTerm
  const busy = workers(root, ['start', 'club-add=2', 'club-settings=0', '--dry-run', '--bg'],
    [{ id: 'x', pid: 1, kind: 'background', name: 'club-add-1', status: 'idle', cwd: join(realpathSync(root), '.claude/worktrees/club-add-1') }]);
  assert.equal(busy.status, 0, busy.stderr);
  assert.match(busy.stdout, /club-add-1 läuft schon, übersprungen/);
  assert.match(busy.stdout, /claude --bg -w club-add-2 -n club-add-2 '\/loop 10m \/spot-club-add'/);
  assert.doesNotMatch(busy.stdout, /club-settings-|fix-/);
});

test('start ohne --ws startet nur code mit den bisherigen Standards, Rollen anderer Workspaces abgelehnt', () => {
  const { root, workers } = testRepo();
  clearMarkers(testRepo());
  const r = workers(root, ['start', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(launches(r.stdout).map((l) => l.split(':')[0]), [
    'iTerm-Tab fix-1', 'iTerm-Tab fix-2', 'iTerm-Tab search-1', 'iTerm-Tab verify-1',
  ]);
  assert.match(r.stdout, /'\/loop 10m \/spot-fix'/);
  const mixed = workers(root, ['start', 'fix=1', 'club-add=1', '--dry-run']);
  assert.equal(mixed.status, 2);
  assert.match(mixed.stderr, /Workspace/);
  assert.equal(workers(root, ['start', '--ws', 'clubs', 'fix=1', '--dry-run']).status, 2);
  assert.equal(workers(root, ['start', '--ws', 'nix', '--dry-run']).status, 2);
});

test('start --ws clubs hebt nur den Club-Drain auf, ein globaler bleibt für code als Rollen-Drain', () => {
  const { root, marker, workers } = testRepo();
  clearMarkers(testRepo());
  writeFileSync(marker, '');
  writeFileSync(`${marker}-club-test`, '');
  // Markierungen ändert erst der echte Lauf; Anzahl 0 je Rolle, damit nichts gestartet wird
  const zero = ['club-search=0', 'club-add=0', 'club-settings=0', 'club-test=0'];
  const dry = workers(root, ['start', '--ws', 'clubs', ...zero, '--dry-run']);
  assert.match(dry.stdout, /würde für Workspace clubs entfernt: alle/);
  assert.equal(existsSync(marker), true);
  const r = workers(root, ['start', '--ws', 'clubs', ...zero]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(`${marker}-club-test`), false);
  for (const role of ['fix', 'search', 'verify', 'regress']) assert.equal(existsSync(`${marker}-${role}`), true, role);
  clearMarkers(testRepo());
});

test('add --ws prüft die Rollen, add verweigert bei Rollen-Drain', () => {
  const { root, marker, workers } = testRepo();
  clearMarkers(testRepo());
  const r = workers(root, ['add', 'club-test', '--ws', 'clubs', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(launches(r.stdout), ["iTerm-Tab club-test-1: claude -w club-test-1 -n club-test-1 '/loop 15m /spot-club-test'"]);
  assert.equal(workers(root, ['add', 'fix', '--ws', 'clubs', '--dry-run']).status, 2);
  writeFileSync(`${marker}-club-test`, '');
  const d = workers(root, ['add', 'club-test', '--dry-run']);
  assert.equal(d.status, 1);
  assert.match(d.stderr, /Drain aktiv für club-test/);
  clearMarkers(testRepo());
});

test('config: Workspaces, Rollen, Prompts, Farben und Repos als JSON; Projekt wird registriert', () => {
  const { root, workers } = testRepo();
  const r = workers(root, ['config']);
  assert.equal(r.status, 0, r.stderr);
  const c = JSON.parse(r.stdout);
  assert.equal(c.slug, 'spot');
  assert.deepEqual(c.workspaces.map((w) => [w.key, w.name, w.phases.map((p) => p.title ?? p.key), w.roles.length]), [
    ['code', 'Code', ['fix', 'verify', 'merge'], 4],
    ['clubs', 'Clubs', ['Anlegen', 'settings', 'Test'], 4],
  ]);
  assert.equal(c.prompts['club-add'], '/loop 10m /spot-club-add');
  assert.equal(c.prompts.fix, '/loop 10m /spot-fix');
  assert.deepEqual(c.colors['club-add'], [230, 120, 30]);
  assert.deepEqual(c.colors['club-test'], [120, 120, 120]);
  assert.equal(c.start['club-settings'], 2);
  assert.deepEqual(c.repos.map((x) => x.key), ['.', 'side']);
  assert.equal(c.repos[1].path, join(dir, 'side'));
  assert.equal(c.runners, false);
  assert.match(c.autorestart, /spot-workers-autorestart$/);
  assert.equal(readFileSync(join(dir, 'home/projects.txt'), 'utf8').trim(), root);
});

test('repo-for: modul:<repo> aus BK_REPOS führt ins zweite Repo, sonst das Projekt', () => {
  const { root, workers } = testRepo();
  const side = workers(root, ['repo-for', 'spot-1'], [], { FAKE_LABELS: '["modul:side","phase:fix"]' });
  assert.equal(side.status, 0, side.stderr);
  assert.equal(side.stdout.trim(), join(dir, 'side'));
  const own = workers(root, ['repo-for', 'spot-2'], [], { FAKE_LABELS: '["modul:app"]' });
  assert.equal(own.stdout.trim(), root);
});

test('beads.project.sh: ungültige Rollen und Workspaces brechen ab', () => {
  const r = join(dir, 'bad');
  mkdirSync(join(r, 'scripts/beadskit'), { recursive: true });
  copyFileSync(script, join(r, 'scripts/beadskit/workers'));
  git(dir, 'init', '-q', r);
  const env = { ...process.env, BEADSKIT_HOME: join(dir, 'home') };
  const tryCfg = (text) => {
    writeFileSync(join(r, 'beads.project.sh'), text);
    return spawnSync(join(r, 'scripts/beadskit/workers'), ['config'], { cwd: r, encoding: 'utf8', env });
  };
  assert.match(tryCfg('BK_ROLES="fix x;y"\n').stderr, /Rollenname/);
  assert.match(tryCfg('BK_WORKSPACES="Clubs"\n').stderr, /Workspace-Name/);
  assert.match(tryCfg('BK_WORKSPACES="clubs"\n').stderr, /ohne Rollen/);
  assert.match(tryCfg('BK_WORKSPACES="clubs"\nBK_WS_clubs_ROLES="fix"\n').stderr, /doppelt/);
  assert.equal(tryCfg('BK_ROLES="fix verify"\n').status, 0);
});

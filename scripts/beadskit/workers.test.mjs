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
  // bdw-Ersatz: show liefert Labels aus FAKE_LABELS, list und merge-slot FAKE_LIST/FAKE_SLOT,
  // kv einen Speicher in der JSON-Datei FAKE_KV; FAKE_BDW_FAIL lässt jeden Aufruf scheitern
  // (beads antwortet nicht)
  writeFileSync(join(r, 'scripts/beadskit/bdw'), `#!/bin/sh
[ -z "$FAKE_BDW_FAIL" ] || exit 1
case $1 in
  show) printf '[{"id":"%s","labels":%s}]' "$2" "\${FAKE_LABELS:-[]}" ;;
  list) printf '%s' "\${FAKE_LIST:-[]}" ;;
  merge-slot) [ -n "$FAKE_SLOT" ] && printf '%s' "$FAKE_SLOT" || printf '{"available":true}' ;;
  kv)
    [ -f "$FAKE_KV" ] || echo '{}' >"$FAKE_KV"
    case $2 in
      list) cat "$FAKE_KV" ;;
      set) jq --arg k "$3" --arg v "$4" '.[$k] = $v' "$FAKE_KV" >"$FAKE_KV.tmp" && mv "$FAKE_KV.tmp" "$FAKE_KV" ;;
      clear) jq --arg k "$3" 'del(.[$k])' "$FAKE_KV" >"$FAKE_KV.tmp" && mv "$FAKE_KV.tmp" "$FAKE_KV" ;;
    esac ;;
esac
`);
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
      BEADSKIT_HOME: join(dir, 'home'), BK_TERM: 'iterm', ...extra };
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

test('restart: kein Neustart bei Claim, Merge-Slot oder wenn beads nicht antwortet', () => {
  const { root, workers } = testRepo();
  clearMarkers(testRepo());
  const agents = [live('aaaa0001', 'fix-3')];
  const restart = (extra) => workers(root, ['restart', 'fix-3', '--dry-run'], agents, extra);
  const ok = restart({});
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /claude stop aaaa0001/);
  const claimed = restart({ FAKE_LIST: '[{"id":"spot-1","assignee":"fix-3"}]' });
  assert.equal(claimed.status, 1);
  assert.match(claimed.stderr, /spot-1 in Arbeit/);
  const slot = restart({ FAKE_SLOT: '{"available":false,"holder":"fix-3"}' });
  assert.equal(slot.status, 1);
  assert.match(slot.stderr, /hält den Merge-Slot/);
  const down = restart({ FAKE_BDW_FAIL: '1' });
  assert.equal(down.status, 1);
  assert.match(down.stderr, /beads antwortet nicht/);
  // Claims lesbar, nur der Merge-Slot nicht
  const noSlot = restart({ FAKE_SLOT: 'kaputt' });
  assert.equal(noSlot.status, 1);
  assert.match(noSlot.stderr, /Merge-Slot unbekannt/);
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

// ---- Terminal iTerm (Mac) ----
// osascript-Ersatz: kopiert die Befehlsliste (Argument 2) nach FAKE_LOG, wie sie iTerm tippen würde
const itermBin = join(dir, 'itermbin');
mkdirSync(itermBin);
writeFileSync(join(itermBin, 'osascript'), '#!/bin/sh\ncat "$2" >>"$FAKE_LOG"\n');
chmodSync(join(itermBin, 'osascript'), 0o755);

test('iTerm: Startzeile mit \\033 und \\a als Text, keine Steuerzeichen (echo von /bin/sh)', () => {
  const { root, workers } = testRepo();
  clearMarkers(testRepo());
  const r = workers(root, ['start', 'fix=1', 'search=0', 'verify=0'], [], { PATH: `${itermBin}:${dir}:${process.env.PATH}` });
  assert.equal(r.status, 0, r.stderr);
  const line = r.calls.find((c) => c.includes('claude -w fix-1'));
  assert.ok(line, r.calls.join('\n'));
  assert.ok(line.startsWith("printf '\\033]6;1;bg;red;brightness;"), line);
  assert.ok(line.includes('\\a'), line);
  assert.doesNotMatch(line, /[\x07\x1b]/);
  assert.ok(line.endsWith(`cd '${root}' && claude -w fix-1 -n fix-1 '/loop 10m /spot-fix'`), line);
});

// ---- Terminal tmux (Linux) ----
// Fakes für tmux und ps: tmux protokolliert jeden Aufruf in FAKE_LOG; has-session gelingt nur
// mit FAKE_TMUX_UP, new-window -P gibt %9 aus, list-panes liefert das Pane %3 mit /dev/pts/7.
// ps -o tty= gibt FAKE_TTY aus.
const fakeBin = join(dir, 'fakebin');
mkdirSync(fakeBin);
writeFileSync(join(fakeBin, 'tmux'), `#!/bin/sh
echo "tmux $*" >>"$FAKE_LOG"
case $1 in
  has-session) [ -n "$FAKE_TMUX_UP" ] ;;
  new-window) echo %9 ;;
  list-panes) echo "/dev/pts/7 %3" ;;
esac
`);
writeFileSync(join(fakeBin, 'ps'), '#!/bin/sh\nprintf \'%s\\n\' "$FAKE_TTY"\n');
chmodSync(join(fakeBin, 'tmux'), 0o755);
chmodSync(join(fakeBin, 'ps'), 0o755);
const tmuxEnv = (extra = {}) => ({ PATH: `${fakeBin}:${dir}:${process.env.PATH}`, BK_TERM: 'tmux', BK_UNAME: 'Linux', ...extra });
const tmuxCalls = (calls) => calls.filter((c) => c.startsWith('tmux ')).map((c) => c.slice(5));

test('tmux: start legt die Session an und öffnet je Worker ein Fenster mit Farbe und Startbefehl', () => {
  const { root, workers } = testRepo();
  clearMarkers(testRepo());
  const dry = workers(root, ['start', 'fix=1', 'search=0', 'verify=0', '--dry-run'], [], tmuxEnv());
  assert.match(dry.stdout, /^tmux-Fenster fix-1: claude -w fix-1 -n fix-1 '\/loop 10m \/spot-fix'$/m);

  const r = workers(root, ['start', 'fix=1', 'search=0', 'verify=0'], [], tmuxEnv());
  assert.equal(r.status, 0, r.stderr);
  const calls = tmuxCalls(r.calls);
  assert.deepEqual(calls.slice(0, 3), [
    'has-session -t =bk-spot',
    `new-session -d -s bk-spot -n shell -c ${root}`,
    `new-window -d -P -F #{pane_id} -t =bk-spot: -n fix-1 -c ${root}`,
  ]);
  assert.ok(calls.includes('set-option -w -t %9 window-status-style bg=#c83c3c'), calls.join('\n'));
  assert.ok(calls.includes(`send-keys -t %9 -l -- cd '${root}' && claude -w fix-1 -n fix-1 '/loop 10m /spot-fix'`), calls.join('\n'));
  assert.equal(calls.at(-1), 'send-keys -t %9 Enter');
  assert.match(r.stdout, /starte fix-1 \(tmux-Fenster\)/);

  // laufende Session wird weiterverwendet
  const again = workers(root, ['add', 'search'], [], tmuxEnv({ FAKE_TMUX_UP: '1' }));
  assert.equal(again.status, 0, again.stderr);
  assert.equal(tmuxCalls(again.calls).some((c) => c.startsWith('new-session')), false);
  assert.ok(tmuxCalls(again.calls).includes(`new-window -d -P -F #{pane_id} -t =bk-spot: -n search-1 -c ${root}`));
});

test('tmux: send tippt in das Pane mit dem TTY des Workers, ohne Terminal Abbruch', () => {
  const { root, workers } = testRepo();
  const term = [{ id: 's1', pid: 4242, kind: 'interactive', name: 'fix-3', status: 'busy', cwd: testRepo().wt('fix-3') }];
  const r = workers(root, ['send', 'fix-3', '--', '/compact'], term, tmuxEnv({ FAKE_TTY: 'pts/7' }));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(tmuxCalls(r.calls), ['list-panes -a -F #{pane_tty} #{pane_id}', 'send-keys -t %3 -l -- /compact', 'send-keys -t %3 Enter']);
  // procps zeigt ? für Prozesse ohne Terminal
  const none = workers(root, ['send', 'fix-3', '--', 'hallo'], term, tmuxEnv({ FAKE_TTY: '?' }));
  assert.equal(none.status, 1);
  assert.match(none.stderr, /kein Terminal zur PID 4242/);
  // TTY ohne passendes Pane (und kein iTerm unter Linux)
  const other = workers(root, ['send', 'fix-3', '--', 'hallo'], term, tmuxEnv({ FAKE_TTY: 'pts/8' }));
  assert.equal(other.status, 1);
  assert.match(other.stderr, /kein Terminal mit \/dev\/pts\/8/);
});

test('tmux: restart beendet die Session und tippt den Startbefehl ins selbe Fenster', () => {
  const { root, workers } = testRepo();
  clearMarkers(testRepo());
  // eigener Elternprozess (sh endet sofort), damit der beendete sleep kein Zombie von node bleibt
  const pid = Number(execFileSync('sh', ['-c', 'sleep 60 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).trim());
  const term = [{ id: 's1', pid, kind: 'interactive', name: 'fix-3', status: 'idle', cwd: testRepo().wt('fix-3') }];
  const r = workers(root, ['restart', 'fix-3'], term, tmuxEnv({ FAKE_TTY: 'pts/7' }));
  assert.equal(r.status, 0, r.stderr);
  assert.throws(() => process.kill(pid, 0));
  assert.deepEqual(tmuxCalls(r.calls).filter((c) => c.startsWith('send-keys')), [
    `send-keys -t %3 -l -- cd '${root}' && claude -w fix-3 -n fix-3 '/loop 10m /spot-fix'`, 'send-keys -t %3 Enter',
  ]);
  assert.match(r.stdout, /fix-3 im Terminal \/dev\/pts\/7 neu gestartet/);
});

// ---- Zwei Rechner (hosts.conf) ----
const pcHome = join(dir, 'home-pc');
mkdirSync(pcHome);
writeFileSync(join(pcHome, 'hosts.conf'), `LEADER=pc
HOSTS="mac pc"
SELF=pc
BK_HOST_BASE=100
HOST_mac_ROLES="fix search"
`);
const macHome = join(dir, 'home-mac');
mkdirSync(macHome);
writeFileSync(join(macHome, 'hosts.conf'), readFileSync(join(pcHome, 'hosts.conf'), 'utf8').replace('SELF=pc', 'SELF=mac').replace('BK_HOST_BASE=100', 'BK_HOST_BASE=0'));
const kvFile = join(dir, 'kv.json');
const pc = (extra = {}) => ({ BEADSKIT_HOME: pcHome, FAKE_KV: kvFile, ...extra });
const mac = (extra = {}) => ({ BEADSKIT_HOME: macHome, FAKE_KV: kvFile, ...extra });
const kv = () => JSON.parse(readFileSync(kvFile, 'utf8'));

test('zwei Rechner: Nummern ab BK_HOST_BASE, HOST_<h>_ROLES begrenzt die Vorgabe', () => {
  const { root, workers } = testRepo();
  rmSync(kvFile, { force: true });
  const r = workers(root, ['start', '--dry-run'], [], pc());
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(launches(r.stdout).map((l) => l.split(':')[0]), [
    'iTerm-Tab fix-101', 'iTerm-Tab fix-102', 'iTerm-Tab search-101', 'iTerm-Tab verify-101',
  ]);
  // Mac: verify gehört nicht zu HOST_mac_ROLES, startet ohne Angabe also nicht
  const m = workers(root, ['start', '--dry-run'], [], mac());
  assert.deepEqual(launches(m.stdout).map((l) => l.split(':')[0]), ['iTerm-Tab fix-1', 'iTerm-Tab fix-2', 'iTerm-Tab search-1']);
  // ausdrücklich genannt: startet, mit Hinweis
  const v = workers(root, ['start', 'verify=1', 'fix=0', 'search=0', '--dry-run'], [], mac());
  assert.deepEqual(launches(v.stdout).map((l) => l.split(':')[0]), ['iTerm-Tab verify-1']);
  assert.match(v.stderr, /verify soll laut hosts.conf nicht auf mac laufen/);
  // add nimmt die nächste freie Nummer des Rechners
  const add = workers(root, ['add', 'fix', '--dry-run'], [live('a1', 'fix-101')], pc());
  assert.deepEqual(launches(add.stdout), ["iTerm-Tab fix-102: claude -w fix-102 -n fix-102 '/loop 10m /spot-fix'"]);
});

test('zwei Rechner: Drain in bd kv, global, je Rolle und je Rechner', () => {
  const { root, workers, wt } = testRepo();
  clearMarkers(testRepo());
  rmSync(kvFile, { force: true });
  const check = (env) => workers(wt('fix-3'), ['drain-check'], [], env).stdout.trim();
  assert.equal(check(pc()), 'kein Drain');

  assert.equal(workers(root, ['drain', '--host', 'mac'], [], pc()).status, 0);
  assert.deepEqual(kv(), { 'beadskit.drain@mac': '1' });
  assert.equal(check(mac()), 'DRAIN (Rechner mac)');
  assert.equal(check(pc()), 'kein Drain');

  assert.equal(workers(root, ['drain', 'fix'], [], mac()).status, 0);
  assert.equal(check(pc()), 'DRAIN (Rolle fix)');
  assert.equal(workers(root, ['add', 'fix', '--dry-run'], [], pc()).status, 1);

  assert.equal(workers(root, ['drain'], [], pc()).status, 0);
  assert.equal(check(pc()), 'DRAIN (alle Worker)');
  // keine Dateien im Git-Verzeichnis
  assert.equal(existsSync(testRepo().marker), false);
  const ls = workers(root, ['ls'], [], pc());
  assert.match(ls.stdout, /Rechner: pc \(Leitrechner pc, Worker ab <rolle>-101\)/);
  assert.match(ls.stdout, /Drain aktiv für Rechner mac/);

  assert.equal(workers(root, ['drain', '--off'], [], mac()).status, 0);
  assert.deepEqual(kv(), {});
  assert.equal(check(mac()), 'kein Drain');

  // start hebt den Drain dieses Rechners auf
  workers(root, ['drain', '--host', 'pc'], [], mac());
  const st = workers(root, ['start', 'fix=0', 'search=0', 'verify=0'], [], pc());
  assert.equal(st.status, 0, st.stderr);
  assert.deepEqual(kv(), {});

  // beads antwortet nicht: drain-check sagt kein Drain (Exit 0), drain selbst scheitert
  const down = workers(wt('fix-3'), ['drain-check'], [], pc({ FAKE_BDW_FAIL: '1' }));
  assert.equal(down.status, 0);
  assert.equal(down.stdout.trim(), 'kein Drain');
  assert.equal(workers(root, ['drain'], [], pc({ FAKE_BDW_FAIL: '1' })).status, 1);
  // --host nur mit hosts.conf und bekanntem Rechner
  assert.equal(workers(root, ['drain', '--host', 'pc']).status, 2);
  assert.equal(workers(root, ['drain', '--host', 'nas'], [], pc()).status, 2);
});

test('zwei Rechner: autorestart in bd kv, config mit Rechner-Angaben', () => {
  const { root, workers } = testRepo();
  rmSync(kvFile, { force: true });
  assert.equal(workers(root, ['autorestart', '--over', '300k'], [], pc()).status, 0);
  assert.deepEqual(kv(), { 'beadskit.autorestart': '300000' });
  assert.match(workers(root, ['ls'], [], mac()).stdout, /Auto-Neustart ab 300k/);
  const c = JSON.parse(workers(root, ['config'], [], pc()).stdout);
  assert.deepEqual([c.host, c.leader, c.hosts, c.hostBase, c.markers, c.tmuxSession], ['pc', 'pc', ['mac', 'pc'], 100, 'kv', 'bk-spot']);
  assert.equal(workers(root, ['autorestart', '--off'], [], pc()).status, 0);
  assert.deepEqual(kv(), {});
  const single = JSON.parse(workers(root, ['config']).stdout);
  assert.deepEqual([single.leader, single.markers, single.hostBase], [null, 'file', 0]);
});

test('bdw: im Worktree immer das .beads/ des Haupt-Checkouts, Actor aus dem Worktree', () => {
  const r = join(dir, 'bdwrepo');
  mkdirSync(join(r, 'scripts/beadskit'), { recursive: true });
  copyFileSync(join(here, 'bdw'), join(r, 'scripts/beadskit/bdw'));
  mkdirSync(join(r, '.beads'));
  writeFileSync(join(r, '.beads/metadata.json'), '{}');
  git(dir, 'init', '-q', r);
  git(r, 'add', '.');
  git(r, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const wt = join(r, '.claude/worktrees/fix-7');
  git(r, 'worktree', 'add', '-q', wt);
  // Ersatz für bd: gibt aus, welche Datenbank und welcher Actor ankämen
  const bin = join(dir, 'bdbin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'bd'), '#!/bin/sh\necho "$BEADS_DIR|$BEADS_ACTOR"\n');
  chmodSync(join(bin, 'bd'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  delete env.BEADS_DIR;
  delete env.BEADS_ACTOR;
  const out = (cwd, extra = {}) => execFileSync(join(cwd, 'scripts/beadskit/bdw'), ['list'], { cwd, encoding: 'utf8', env: { ...env, ...extra } }).trim();
  assert.equal(out(wt), `${realpathSync(r)}/.beads|fix-7`);
  assert.equal(out(r), `${realpathSync(r)}/.beads|bdwrepo`);
  // ausdrücklich gesetzt gewinnt
  assert.equal(out(wt, { BEADS_DIR: '/x/.beads', BEADS_ACTOR: 'user' }), '/x/.beads|user');
});

test('stop beendet auch Terminal-Worker: SIGTERM, dann das tmux-Fenster; aktive nur mit --force', () => {
  const { root, workers } = testRepo();
  const spawnSleep = () => Number(execFileSync('sh', ['-c', 'sleep 60 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).trim());
  const term = (name, pid, status = 'idle') => ({ id: `t-${name}`, pid, kind: 'interactive', name, status, cwd: testRepo().wt(name) });
  // tmux kennt das Fenster fix-3 (list-windows gibt den Namen aus)
  const env = tmuxEnv({ FAKE_TMUX_WINDOWS: 'fix-3' });
  writeFileSync(join(fakeBin, 'tmux'), `#!/bin/sh
echo "tmux $*" >>"$FAKE_LOG"
case $1 in
  has-session) [ -n "$FAKE_TMUX_UP" ] ;;
  new-window) echo %9 ;;
  list-panes) echo "/dev/pts/7 %3" ;;
  list-windows) printf '%s\\n' $FAKE_TMUX_WINDOWS ;;
esac
`);
  const busy = workers(root, ['stop', '--all'], [term('fix-3', 1, 'busy')], env);
  assert.equal(busy.status, 1);
  assert.match(busy.stderr, /noch aktiv: fix-3/);

  const pid = spawnSleep();
  const r = workers(root, ['stop', 'fix-3'], [term('fix-3', pid)], env);
  assert.equal(r.status, 0, r.stderr);
  assert.throws(() => process.kill(pid, 0));
  assert.ok(tmuxCalls(r.calls).includes('kill-window -t =bk-spot:=fix-3'), r.calls.join('\n'));

  // --all mischt Hintergrund- und Terminal-Worker
  const pid2 = spawnSleep();
  const all = workers(root, ['stop', '--all'], [live('aaaa0001', 'fix-4'), term('club-add-1', pid2)], env);
  assert.equal(all.status, 0, all.stderr);
  assert.ok(all.calls.includes('stop aaaa0001'));
  assert.throws(() => process.kill(pid2, 0));
  assert.match(all.stdout, /stoppe club-add-1/);
});

test('screen und press: Bildschirm des tmux-Panes, eine Taste ohne Enter, nur erlaubte Tasten', () => {
  const { root, workers } = testRepo();
  writeFileSync(join(fakeBin, 'tmux'), `#!/bin/sh
echo "tmux $*" >>"$FAKE_LOG"
case $1 in
  list-panes) echo "/dev/pts/7 %3" ;;
  capture-pane) printf ' Do you want to proceed?\\n ❯ 1. Yes\\n   2. No\\n\\n\\n\\n' ;;
esac
`);
  const term = [{ id: 's1', pid: 4242, kind: 'interactive', name: 'fix-3', status: 'waiting', cwd: testRepo().wt('fix-3') }];
  const env = tmuxEnv({ FAKE_TTY: 'pts/7' });
  const sc = workers(root, ['screen', 'fix-3'], term, env);
  assert.equal(sc.status, 0, sc.stderr);
  assert.equal(sc.stdout, ' Do you want to proceed?\n ❯ 1. Yes\n   2. No\n');
  assert.ok(tmuxCalls(sc.calls).includes('capture-pane -p -J -t %3'));
  assert.equal(workers(root, ['screen', 'fix-3', '--lines', '1'], term, env).stdout, '   2. No\n');

  const pr = workers(root, ['press', 'fix-3', '2'], term, env);
  assert.equal(pr.status, 0, pr.stderr);
  assert.ok(tmuxCalls(pr.calls).includes('send-keys -t %3 2'));
  assert.match(pr.stdout, /2 an fix-3 gesendet/);
  assert.equal(workers(root, ['press', 'fix-3', 'x'], term, env).status, 2);
  assert.equal(workers(root, ['press', 'fix-3', '2; rm'], term, env).status, 2);
  // Hintergrund-Worker haben kein Terminal
  const bg = workers(root, ['screen', 'fix-4'], [live('aaaa0001', 'fix-4')], env);
  assert.equal(bg.status, 1);
  assert.match(bg.stderr, /Hintergrund/);
});

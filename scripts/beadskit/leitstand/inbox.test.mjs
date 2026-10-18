// node --test scripts/beadskit/leitstand/inbox.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  groupIssues, isOwnHost, isSameOrigin, loginLimiter, metrics, normalizeConfig, parseCookies, parseProjectList,
  parseWorkers, planCreate, planDecision, planIssueAction, planWorkerAction, prSummary, publicConfig, safeEqual,
  signSession, today, verifySession, workerRe,
} from './inbox.mjs';
import { summarizeTranscript, toolSummary, transcriptPath } from './sessions.mjs';

const D = '2026-10-16';
const SPOT_MODULES = ['admin', 'app', 'backend', 'cli', 'ops', 'press', 'repo'];

test('Freigeben entfernt human und hängt die Entscheidung an', () => {
  assert.deepEqual(planDecision({ id: 'spot-8zr', action: 'release', text: '  nur bei 0 Events ' }, D), [
    ['update', 'spot-8zr', '--remove-label', 'human', '--append-notes', `User-Entscheidung ${D}: nur bei 0 Events`],
  ]);
});

test('Freigeben, Notiz und Schließen brauchen Text', () => {
  for (const action of ['release', 'note', 'close']) {
    assert.throws(() => planDecision({ id: 'spot-8zr', action, text: '  ' }, D));
  }
});

test('Zurückstellen geht auch ohne Text, mit Text zuerst die Notiz', () => {
  assert.deepEqual(planDecision({ id: 'spot-n5o', action: 'defer', text: '' }, D), [['defer', 'spot-n5o']]);
  assert.deepEqual(planDecision({ id: 'spot-n5o', action: 'defer', text: 'später' }, D), [
    ['update', 'spot-n5o', '--append-notes', `User-Entscheidung ${D}: später`],
    ['defer', 'spot-n5o'],
  ]);
});

test('Schließen nutzt den Text als Grund', () => {
  assert.deepEqual(planDecision({ id: 'spot-wxt.1', action: 'close', text: 'erledigt' }, D), [
    ['close', 'spot-wxt.1', '--reason', `User-Entscheidung ${D}: erledigt`],
  ]);
});

test('ungültige ID, Aktion oder Länge werden abgelehnt', () => {
  assert.throws(() => planDecision({ id: '--force', action: 'note', text: 'x' }), /Issue-ID/);
  assert.throws(() => planDecision({ id: 'spot-1; rm', action: 'note', text: 'x' }), /Issue-ID/);
  assert.throws(() => planDecision({ id: 'spot-1', action: 'delete', text: 'x' }), /Aktion/);
  assert.throws(() => planDecision({ id: 'spot-1', action: 'note', text: 'x'.repeat(4001) }), /zu lang/);
});

test('Text mit Optionen bleibt ein einzelnes Argument', () => {
  const [[, , , note]] = planDecision({ id: 'spot-1', action: 'note', text: '--remove-label phase:fix' }, D);
  assert.equal(note, `User-Entscheidung ${D}: --remove-label phase:fix`);
});

const NOW = Date.parse('2026-10-16T12:00:00Z');

test('groupIssues: human vor Phase (auch ohne Phase), Bereit/In Arbeit nach Status, Erledigt 24 h', () => {
  const cols = groupIssues([
    { id: 'a-1', status: 'open', labels: ['phase:fix', 'human'], priority: 2 },
    { id: 'a-2', status: 'open', labels: ['phase:fix'], priority: 3 },
    { id: 'a-3', status: 'in_progress', labels: ['phase:fix'], priority: 1, lease_expires_at: '2026-10-16T11:00:00Z' },
    { id: 'a-4', status: 'open', labels: ['phase:verify'], priority: 2 },
    { id: 'a-5', status: 'open', labels: ['phase:merge', 'phase:verify'], priority: 2 },
    { id: 'a-6', status: 'open', labels: ['phase:fix', 'tests'], priority: 2 },
    { id: 'a-7', status: 'closed', labels: ['phase:fix'], priority: 2, closed_at: '2026-10-16T08:00:00Z' },
    { id: 'a-10', status: 'closed', labels: ['phase:fix'], priority: 2, closed_at: '2026-10-14T08:00:00Z' },
    { id: 'a-8', status: 'deferred', labels: ['phase:fix', 'human'], priority: 2 },
    { id: 'a-11', status: 'open', labels: ['human'], priority: 1 },
    { id: 'a-12', status: 'in_progress', labels: ['phase:fix', 'tests'], priority: 2, lease_expires_at: '2026-10-16T13:00:00Z' },
    { id: 'spot-merge-slot', status: 'in_progress', labels: [], priority: 0 },
    { id: 'rh-merge-slot', status: 'open', labels: [], priority: 0 },
    { id: 'a-13', status: 'open', labels: ['gt:slot'], priority: 0 },
    { id: 'a-14', status: 'pinned', labels: [], priority: 0 },
    { id: 'a-9', issue_type: 'epic', status: 'open', labels: ['phase:fix'], priority: 2 },
  ], NOW);
  assert.deepEqual(Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, v.map((i) => i.id)])), {
    human: ['a-11', 'a-1'], ready: ['a-6', 'a-2'], fix: ['a-3', 'a-12'], verify: ['a-4'], merge: ['a-5'],
    done: ['a-7'], deferred: ['a-8'],
  });
  assert.equal(cols.fix[0].stale, true);
  assert.equal(cols.fix[1].stale, false);
  const m = metrics(cols, [{ mergedAt: '2026-10-16T09:00:00Z' }, { mergedAt: '2026-10-10T09:00:00Z' }], NOW);
  assert.equal(m.stale, 1);
  assert.equal(m.done24h, 1);
  assert.equal(m.mergedToday, 1);
  assert.deepEqual(groupIssues(null, NOW).ready, []);
});

test('planIssueAction: Verschieben entfernt nur vorhandene Phasen und human', () => {
  const cur = { labels: ['phase:fix', 'human', 'modul:cli'], status: 'open' };
  assert.deepEqual(planIssueAction({ id: 'spot-1', action: 'move', to: 'verify' }, cur, D), [
    ['update', 'spot-1', '--remove-label', 'human', '--remove-label', 'phase:fix', '--add-label', 'phase:verify',
      '--append-notes', `User-Entscheidung ${D}: verschoben nach phase:verify`],
  ]);
  assert.deepEqual(planIssueAction({ id: 'spot-1', action: 'move', to: 'ready', text: 'nochmal' }, { labels: ['phase:fix'], status: 'closed' }, D), [
    ['reopen', 'spot-1'],
    ['update', 'spot-1', '--append-notes', `User-Entscheidung ${D}: verschoben nach phase:fix. nochmal`],
  ]);
  assert.deepEqual(planIssueAction({ id: 'spot-1', action: 'move', to: 'human' }, { labels: [], status: 'deferred' }, D), [
    ['undefer', 'spot-1'],
    ['update', 'spot-1', '--add-label', 'human', '--append-notes', `User-Entscheidung ${D}: braucht Entscheidung`],
  ]);
  assert.deepEqual(planIssueAction({ id: 'spot-1', action: 'move', to: 'deferred' }, cur, D), [['defer', 'spot-1']]);
  assert.deepEqual(planIssueAction({ id: 'spot-1', action: 'move', to: 'deferred' }, { status: 'closed' }, D), [
    ['reopen', 'spot-1'], ['defer', 'spot-1'],
  ]);
  assert.deepEqual(planIssueAction({ id: 'spot-1', action: 'move', to: 'done', text: 'doppelt' }, cur, D), [
    ['close', 'spot-1', '--reason', `User-Entscheidung ${D}: doppelt`],
  ]);
  assert.throws(() => planIssueAction({ id: 'spot-1', action: 'move', to: 'done' }, cur, D), /Grund/);
  assert.throws(() => planIssueAction({ id: 'spot-1', action: 'move', to: 'fix' }, cur, D), /Ziel/);
});

test('planIssueAction: Priorität und Unclaim', () => {
  assert.deepEqual(planIssueAction({ id: 'spot-1', action: 'priority', value: 0 }), [['update', 'spot-1', '--priority', '0']]);
  assert.throws(() => planIssueAction({ id: 'spot-1', action: 'priority', value: '1; x' }), /Priorität/);
  assert.throws(() => planIssueAction({ id: 'spot-1', action: 'priority', value: 5 }), /Priorität/);
  assert.deepEqual(planIssueAction({ id: 'spot-1', action: 'unclaim' }, { status: 'in_progress', assignee: 'fix-2' }), [
    ['unclaim', 'spot-1', '--force', '--if-assignee', 'fix-2'],
  ]);
  assert.throws(() => planIssueAction({ id: 'spot-1', action: 'unclaim' }, { status: 'open' }), /nicht geclaimt/);
  assert.throws(() => planIssueAction({ id: '--force', action: 'unclaim' }, { status: 'in_progress', assignee: 'x' }), /Issue-ID/);
});

test('planCreate: Werte als --flag=wert, Labels aus Modul und human', () => {
  assert.deepEqual(planCreate({ title: '  --force  Titel  ', description: '', priority: 1, modul: 'cli', human: true }, SPOT_MODULES), [
    ['create', '--title=--force Titel', '--description=--force Titel', '--priority=1', '--type=bug', '--labels=phase:fix,modul:cli,human'],
  ]);
  assert.throws(() => planCreate({ title: 'kurz' }), /Titel/);
  assert.throws(() => planCreate({ title: 'langer Titel', modul: 'x,human' }, SPOT_MODULES), /Modul/);
  assert.throws(() => planCreate({ title: 'langer Titel', modul: 'cli' }), /Modul/);   // Projekt ohne Module
  assert.throws(() => planCreate({ title: 'langer Titel', type: 'epic' }), /Typ/);
});

test('planWorkerAction: nur bekannte Rollen und Worker-Namen', () => {
  assert.deepEqual(planWorkerAction({ action: 'add', role: 'fix' }), ['add', 'fix']);
  assert.deepEqual(planWorkerAction({ action: 'drain', role: 'all' }), ['drain']);
  assert.deepEqual(planWorkerAction({ action: 'drain', role: 'verify', off: true }), ['drain', 'verify', '--off']);
  assert.deepEqual(planWorkerAction({ action: 'stop', name: 'fix-2', force: true }), ['stop', 'fix-2', '--force']);
  assert.throws(() => planWorkerAction({ action: 'add', role: '--iterm' }), /Rolle/);
  assert.throws(() => planWorkerAction({ action: 'stop', name: '--all' }), /Worker/);
  assert.throws(() => planWorkerAction({ action: 'restart', role: 'fix' }), /Aktion/);
  assert.deepEqual(planWorkerAction({ action: 'start', counts: { fix: 3, verify: 1 } }),
    ['start', 'fix=3', 'search=0', 'verify=1', 'regress=0']);
  assert.throws(() => planWorkerAction({ action: 'start', counts: { fix: 9 } }), /0–8/);
  assert.throws(() => planWorkerAction({ action: 'start', counts: { fix: '1 --iterm' } }), /0–8/);
});

test('planWorkerAction: Rollen kommen aus dem Projekt', () => {
  const roles = ['fix', 'verify'];
  assert.deepEqual(planWorkerAction({ action: 'start', counts: { fix: 1, search: 4 } }, roles), ['start', 'fix=1', 'verify=0']);
  assert.throws(() => planWorkerAction({ action: 'add', role: 'search' }, roles), /Rolle/);
  assert.throws(() => planWorkerAction({ action: 'stop', name: 'search-1' }, roles), /Worker/);
  assert.ok(workerRe(['fix', 'x|y', 'audit']).test('audit-3'));
  assert.equal(workerRe(['fix', 'x|y']).test('y-1'), false);
});

test('parseProjectList: Pfade ohne Kommentare, Leerzeilen und Dubletten', () => {
  assert.deepEqual(parseProjectList('/a\n\n# alt\n /b \n/a\n'), ['/a', '/b']);
  assert.deepEqual(parseProjectList(''), []);
});

test('normalizeConfig: Vorgaben, ungültige Werte fallen weg, publicConfig ohne Pfade', () => {
  assert.equal(normalizeConfig(null), null);
  assert.equal(normalizeConfig({ root: '/r', slug: 'Böse Slug' }), null);
  const c = normalizeConfig({ root: '/r', slug: 'regiehub', name: 'RegieHub', base: 'release-2.1.0',
    roles: ['fix', 'verify', 'x;rm'], modules: ['server', 'admin', '../x'], drain: '/r/.git/regiehub-workers-drain' });
  assert.deepEqual(c.roles, ['fix', 'verify']);
  assert.deepEqual(c.modules, ['server', 'admin']);
  assert.equal(c.base, 'release-2.1.0');
  assert.deepEqual(normalizeConfig({ root: '/r', slug: 's' }).roles, ['fix', 'search', 'verify', 'regress']);
  const pub = publicConfig(c);
  assert.equal('root' in pub || 'drain' in pub, false);
  assert.equal(pub.slug, 'regiehub');
});

test('prSummary: CI-Zustand aus den Checks, übersprungene ausgeblendet', () => {
  const check = (status, conclusion, name = 'x') => ({ __typename: 'CheckRun', status, conclusion, name });
  assert.equal(prSummary({ statusCheckRollup: [check('COMPLETED', 'SUCCESS'), check('COMPLETED', 'SKIPPED')] }).ci, 'pass');
  assert.equal(prSummary({ statusCheckRollup: [check('COMPLETED', 'SUCCESS'), check('IN_PROGRESS', '')] }).ci, 'pending');
  assert.equal(prSummary({ statusCheckRollup: [check('IN_PROGRESS', ''), check('COMPLETED', 'FAILURE')] }).ci, 'fail');
  assert.equal(prSummary({ statusCheckRollup: [] }).ci, 'none');
  const s = prSummary({ number: 1, statusCheckRollup: [check('COMPLETED', 'SKIPPED', 'a'), check('COMPLETED', 'SUCCESS', 'b')] });
  assert.deepEqual(s.checks.map((c) => c.name), ['b']);
  assert.equal('statusCheckRollup' in s, false);
});

test('parseWorkers nimmt nur Sessions in den Worktrees, sortiert numerisch', () => {
  const wt = '/repo/.claude/worktrees';
  const ws = parseWorkers([
    { cwd: `${wt}/fix-10`, kind: 'background', status: 'busy', sessionId: 's1', name: 'fix-10', pid: 5, startedAt: 0 },
    { cwd: `${wt}/fix-2/spot-app`, kind: 'interactive', status: 'idle' },
    { cwd: '/repo', kind: 'interactive', status: 'busy' },
    { cwd: `${wt}/add-worker`, kind: 'interactive', status: 'busy' },
  ], wt);
  assert.deepEqual(ws.map((w) => [w.name, w.role, w.kind, w.status]), [
    ['fix-2', 'fix', 'terminal', 'idle'],
    ['fix-10', 'fix', 'background', 'busy'],
  ]);
  assert.equal(ws[1].sessionId, 's1');
  assert.equal(ws[1].session, 'fix-10');
  assert.deepEqual(parseWorkers(null, wt), []);
  assert.deepEqual(parseWorkers([{ cwd: `${wt}/audit-1`, status: 'busy' }, { cwd: `${wt}/fix-1`, status: 'busy' }], wt, ['audit'])
    .map((w) => w.name), ['audit-1']);
});

test('transcriptPath ersetzt Sonderzeichen wie Claude, lehnt fremde Session-IDs ab', () => {
  assert.equal(
    transcriptPath('/Users/a/spot-mm/.claude/worktrees/fix-1', '31166300-f799-45a1-b727-2cbc7401fcb7', '/h'),
    '/h/.claude/projects/-Users-a-spot-mm--claude-worktrees-fix-1/31166300-f799-45a1-b727-2cbc7401fcb7.jsonl',
  );
  assert.equal(transcriptPath('/x', '../../etc/passwd', '/h'), null);
});

test('summarizeTranscript: Branch, Tools, Text, PR, Kontext und Warteschlange', () => {
  const cwd = '/wt/fix-1';
  const lines = [
    '{"kaputt',
    JSON.stringify({ type: 'user', timestamp: '2026-10-16T10:00:00Z', gitBranch: 'fix/spot-1' }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-16T10:01:00Z', message: {
      model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 90, output_tokens: 7 },
      content: [{ type: 'text', text: 'Ich prüfe den Test.' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'Tests ausführen' } }],
    } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-16T10:02:00Z', message: {
      model: '<synthetic>', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: `${cwd}/src/a.ts` } }],
    } }),
    JSON.stringify({ type: 'pr-link', prNumber: 70, prUrl: 'https://x/70', timestamp: '2026-10-16T10:03:00Z' }),
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'bitte aufhören', timestamp: '2026-10-16T10:04:00Z' }),
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'zweite', timestamp: '2026-10-16T10:04:30Z' }),
    JSON.stringify({ type: 'queue-operation', operation: 'remove', content: 'zweite', timestamp: '2026-10-16T10:05:00Z' }),
  ];
  const s = summarizeTranscript(lines, { cwd });
  assert.equal(s.branch, 'fix/spot-1');
  assert.equal(s.model, 'claude-opus-5-5');
  assert.equal(s.contextTokens, 1100);
  assert.equal(s.outputTokens, 7);
  assert.equal(s.lastAt, '2026-10-16T10:05:00Z');
  assert.deepEqual(s.tools.map((t) => [t.name, t.summary]), [['Edit', 'src/a.ts'], ['Bash', 'Tests ausführen']]);
  assert.equal(s.lastText, 'Ich prüfe den Test.');
  assert.deepEqual(s.prs, [{ number: 70, url: 'https://x/70' }]);
  assert.deepEqual(s.pending.map((p) => p.text), ['bitte aufhören']);
  assert.equal(toolSummary('Bash', { command: 'x'.repeat(300) }).length, 140);
});

test('Schreiben nur mit eigenem Origin und Header, Host muss passen', () => {
  const ok = { origin: 'http://127.0.0.1:3738', 'x-beads-inbox': '1' };
  assert.equal(isSameOrigin(ok, 3738), true);
  assert.equal(isSameOrigin({ ...ok, origin: 'https://evil.example' }, 3738), false);
  assert.equal(isSameOrigin({ origin: ok.origin }, 3738), false);
  assert.equal(isOwnHost({ host: '127.0.0.1:3738' }, 3738), true);
  assert.equal(isOwnHost({ host: 'evil.example:3738' }, 3738), false);
});

test('Fernzugang: öffentlicher Host und Origin nur, wenn konfiguriert', () => {
  const pub = 'https://leitstand.felix-go.de';
  assert.equal(isOwnHost({ host: 'leitstand.felix-go.de' }, 3738, pub), true);
  assert.equal(isOwnHost({ host: 'leitstand.felix-go.de' }, 3738, ''), false);
  const h = { 'x-beads-inbox': '1', origin: pub };
  assert.equal(isSameOrigin(h, 3738, pub), true);
  assert.equal(isSameOrigin({ ...h, origin: 'http://leitstand.felix-go.de' }, 3738, pub), false);
  assert.equal(isSameOrigin(h, 3738, ''), false);
});

test('Sitzungs-Cookie: gültig bis Ablauf, an das Token gebunden, nicht fälschbar', () => {
  const token = 'a'.repeat(40);
  const exp = NOW + 1000;
  const v = signSession(token, exp);
  assert.equal(verifySession(token, v, NOW), true);
  assert.equal(verifySession(token, v, exp + 1), false);
  assert.equal(verifySession('b'.repeat(40), v, NOW), false);
  assert.equal(verifySession(token, `${exp + 99999}.${v.split('.')[1]}`, NOW), false);
  assert.equal(verifySession(token, 'x', NOW), false);
  assert.equal(verifySession(null, v, NOW), false);
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.deepEqual(parseCookies('a=1; leitstand=x.y%3D; b'), { a: '1', leitstand: 'x.y=' });
});

test('loginLimiter sperrt nach zu vielen Fehlversuchen im Fenster', () => {
  const l = loginLimiter(3, 1000);
  for (let i = 0; i < 3; i++) l.fail(NOW + i);
  assert.equal(l.blocked(NOW + 10), true);
  assert.equal(l.blocked(NOW + 2000), false);
});

test('today formatiert lokal als YYYY-MM-DD', () => {
  assert.equal(today(new Date(2026, 0, 5)), '2026-01-05');
});

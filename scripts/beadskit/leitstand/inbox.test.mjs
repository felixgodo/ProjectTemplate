// node --test scripts/beadskit/leitstand/inbox.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildWorkspaces, cardExtras, clientIp, groupIssues, isOwnHost, isPagePath, isSameOrigin, labelSlug, loginGuard, metrics,
  normalizeConfig, normalizeExt, parseCookies, parseProjectList, projectPaths, parseMysql, parsePool, parseSlice, parseWorkers, planCreate, planDecision,
  planIssueAction, planRestarts, planRunnerAction, planWorkerAction, prSummary, publicConfig, readBody, repoOfIssue,
  RESTART_COOLDOWN_MS, safeEqual, signSession, today, verifySession, hashPassword, parsePasswordLine, verifyPassword,
  workerRe, wsOfIssue, parseHostsConf, mapRoot, shQuote, remoteCommand, mergeHostWorkers, parseMarkers, routeWorkerAction,
  parsePrompt, parseDecision, decisionOf, collectServers, collectSystems, QUICK, waitsOf,
} from './inbox.mjs';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chatTranscript, summarizeTranscript, toolSummary, transcriptPath } from './sessions.mjs';

// Projekt wie aus `workers config`: code plus ein zweiter Workspace clubs, zwei Repos
const CFG = normalizeConfig({
  root: '/repo', slug: 'spot', name: 'Spot', base: 'main',
  roles: ['fix', 'search', 'verify', 'regress', 'club-search', 'club-add', 'club-settings', 'club-test'],
  modules: ['admin', 'app', 'cli', 'side'],
  start: { fix: 2, search: 1, verify: 1, regress: 0, 'club-search': 1, 'club-add': 1, 'club-settings': 2, 'club-test': 1 },
  colors: { fix: [200, 60, 60], 'club-add': [230, 120, 30] },
  workspaces: [
    { key: 'code', name: 'Code', phases: [{ key: 'fix' }, { key: 'verify' }, { key: 'merge' }], roles: ['fix', 'search', 'verify', 'regress'] },
    { key: 'clubs', name: 'Clubs', phases: [{ key: 'place', title: 'Anlegen' }, { key: 'settings' }, { key: 'test', title: 'Test' }],
      roles: ['club-search', 'club-add', 'club-settings', 'club-test'] },
  ],
  repos: [{ key: '.', path: '/repo' }, { key: 'side', path: '/side' }],
  runners: true,
});
const EXT = normalizeExt({
  workspaces: {
    clubs: {
      split: [{ key: 'activate', label: 'aktivieren', title: 'zum Aktivieren' }],
      group: { prefix: 'stadt:', all: 'alle Städte' },
      create: { type: 'task', fields: [{ name: 'stadt', label: 'Stadt', prefix: 'stadt:' }] },
      roleLabels: { 'club-add': 'Anlegen' },
      cols: { settings: { color: '#1ea0aa', hint: 'SiteSetting einrichten' } },
    },
  },
});
const WS = buildWorkspaces(CFG, EXT);
const CODE = WS.code;
const CLUBS = WS.clubs;

const D = '2026-10-16';

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

test('planRunnerAction: Plätze 1–8, Pool und CI-MySQL an/aus, --force nur bei stop mysql', () => {
  assert.deepEqual(planRunnerAction({ action: 'size', n: 3 }), ['size', '3']);
  for (const n of [0, 9, '3', 1.5, undefined]) assert.throws(() => planRunnerAction({ action: 'size', n }), /1–8/);
  assert.deepEqual(planRunnerAction({ action: 'start' }), ['start']);
  assert.deepEqual(planRunnerAction({ action: 'stop', force: true }), ['stop']);
  assert.deepEqual(planRunnerAction({ action: 'start', n: 'mysql', force: true }), ['start', 'mysql']);
  assert.deepEqual(planRunnerAction({ action: 'stop', n: 'mysql', force: true }), ['stop', 'mysql', '--force']);
  assert.deepEqual(planRunnerAction({ action: 'stop', n: 'mysql' }), ['stop', 'mysql']);
  assert.deepEqual(planRunnerAction({ action: 'start', n: 'mariadb' }), ['start', 'mariadb']);
  for (const n of [1, 'all', '--force']) assert.throws(() => planRunnerAction({ action: 'stop', n }), /Pool, mysql oder mariadb/);
  for (const action of ['add', 'delete', 'remove', 'setup']) assert.throws(() => planRunnerAction({ action }), /Aktion/);
  for (const action of ['logs', 'set-token', 'status']) assert.throws(() => planRunnerAction({ action }), /Aktion/);
});

test('planRunnerAction: je Projekt Grenze 1–8 oder off, Pause und Fortsetzen, nur gültige Labels', () => {
  assert.deepEqual(planRunnerAction({ action: 'limit', label: 'spot', n: 2 }), ['limit', 'spot', '2']);
  assert.deepEqual(planRunnerAction({ action: 'limit', label: 'spot', n: 'off' }), ['limit', 'spot', 'off']);
  assert.deepEqual(planRunnerAction({ action: 'pause', label: 'regie-hub2', n: 3, force: true }), ['pause', 'regie-hub2']);
  assert.deepEqual(planRunnerAction({ action: 'resume', label: 'spot' }), ['resume', 'spot']);
  for (const n of [0, 9, '2', 1.5, undefined, 'OFF']) {
    assert.throws(() => planRunnerAction({ action: 'limit', label: 'spot', n }), /1–8 oder off/);
  }
  for (const label of [undefined, '', 'Spot', 'a;rm', '--force', 'a b', 'x'.repeat(65), 3]) {
    assert.throws(() => planRunnerAction({ action: 'pause', label }), /Label/);
    assert.throws(() => planRunnerAction({ action: 'limit', label, n: 2 }), /Label/);
  }
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

test('summarizeTranscript: dequeue ohne Inhalt (/loop-Wakeup) nimmt die älteste Nachricht, popAll leert', () => {
  const q = (operation, content, at) => JSON.stringify({ type: 'queue-operation', operation, content, timestamp: at });
  const loop = [q('enqueue', '/spot-fix', '2026-10-27T22:10:11Z'), q('dequeue', undefined, '2026-10-27T22:10:12Z')];
  assert.deepEqual(summarizeTranscript(loop).pending, []);
  const two = [q('enqueue', 'a', '2026-10-27T22:00:00Z'), q('enqueue', 'b', '2026-10-27T22:00:01Z'), q('dequeue', undefined, '2026-10-27T22:00:02Z')];
  assert.deepEqual(summarizeTranscript(two).pending.map((p) => p.text), ['b']);
  assert.deepEqual(summarizeTranscript([...two, q('popAll', 'b', '2026-10-27T22:00:03Z')]).pending, []);
  assert.deepEqual(summarizeTranscript([q('dequeue', undefined, '2026-10-27T22:00:00Z')]).pending, []);
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

test('parseCookies ignoriert nicht dekodierbare Werte, auch fremde Cookies', () => {
  assert.deepEqual(parseCookies('other=50%; leitstand=1.x'), { leitstand: '1.x' });
  assert.deepEqual(parseCookies('leitstand=%'), {});
});

test('loginGuard: sperrt eine IP nach zu vielen Fehlversuchen, bremst global, ohne IP keine Sperre', () => {
  const g = loginGuard({ perIp: 3, windowMs: 1000, global: 5, delayMs: 500 });
  g.fail('1.2.3.4', NOW); g.fail('1.2.3.4', NOW + 1);
  assert.equal(g.blockedFor('1.2.3.4', NOW + 2), 0);
  g.fail('1.2.3.4', NOW + 2);
  assert.equal(g.blockedFor('1.2.3.4', NOW + 10), 990);  // bis der älteste Fehlversuch abläuft
  assert.equal(g.blockedFor('5.6.7.8', NOW + 10), 0);
  assert.equal(g.blockedFor('1.2.3.4', NOW + 1001), 0);
  assert.equal(g.delay(NOW + 10), 0);
  for (let i = 0; i < 10; i++) g.fail(null, NOW + 20 + i);
  assert.equal(g.blockedFor(null, NOW + 40), 0);  // ohne IP nie gesperrt
  assert.equal(g.delay(NOW + 40), 500);
  assert.equal(g.delay(NOW + 2000), 0);
  g.fail('9.9.9.9', NOW); g.fail('9.9.9.9', NOW); g.ok('9.9.9.9'); g.fail('9.9.9.9', NOW);
  assert.equal(g.blockedFor('9.9.9.9', NOW + 1), 0);  // Erfolg setzt die IP zurück
  const small = loginGuard({ perIp: 1, maxIps: 2 });
  ['a1', 'a2', 'a3'].forEach((ip) => small.fail(ip, NOW));
  assert.equal(small.blockedFor('a1', NOW), 0);  // älteste IP verdrängt
  assert.ok(small.blockedFor('a3', NOW) > 0);
});

test('clientIp: X-Real-IP nur über Loopback, sonst null', () => {
  const r = (addr, ip) => ({ socket: { remoteAddress: addr }, headers: ip ? { 'x-real-ip': ip } : {} });
  assert.equal(clientIp(r('127.0.0.1', '203.0.113.5')), '203.0.113.5');
  assert.equal(clientIp(r('::1', '2001:db8::1')), '2001:db8::1');
  assert.equal(clientIp(r('127.0.0.1')), null);
  assert.equal(clientIp(r('10.0.0.2', '203.0.113.5')), null);
  assert.equal(clientIp(r('127.0.0.1', 'x; drop')), null);
});

test('today formatiert lokal als YYYY-MM-DD', () => {
  assert.equal(today(new Date(2026, 0, 5)), '2026-01-05');
});

// Request-Ersatz: liefert die Buffer nacheinander wie node:http
async function* chunked(...parts) { yield* parts; }

test('readBody: Umlaut über zwei Chunks verteilt bleibt erhalten', async () => {
  const bytes = Buffer.from(JSON.stringify({ text: 'Gründe – „ok“' }));
  const cut = bytes.indexOf(Buffer.from('ü')) + 1;  // mitten im ü
  assert.deepEqual(await readBody(chunked(bytes.subarray(0, cut), bytes.subarray(cut))), { text: 'Gründe – „ok“' });
});

test('readBody: Limit zählt Bytes, nicht Zeichen', async () => {
  const body = Buffer.from(JSON.stringify({ text: 'ä'.repeat(10) }));  // 10 Zeichen, 20 Bytes
  await assert.rejects(readBody(chunked(body), body.length - 1), { code: 413 });
  assert.deepEqual(await readBody(chunked(body), body.length), { text: 'ä'.repeat(10) });
});

test('readBody: kein JSON gibt 400', async () => {
  await assert.rejects(readBody(chunked(Buffer.from('{kaputt'))), { code: 400 });
});

test('planRestarts: nur idle Worker ohne Claim, Slot, Drain und Nachricht über der Schwelle', () => {
  const now = Date.parse('2026-10-18T22:00:00Z');
  const quiet = '2026-10-18T21:55:00Z';
  const w = (name, over = {}, act = {}) => ({
    name, status: 'idle', drained: false, issues: [],
    activity: { contextTokens: 400_000, lastAt: quiet, pending: [], ...act }, ...over,
  });
  const workers = [
    w('fix-1'),
    w('fix-2', { status: 'busy' }),
    w('fix-3', { issues: [{ id: 'spot-x' }] }),
    w('verify-1'),
    w('verify-2', { drained: true }),
    w('fix-4', {}, { contextTokens: 150_000 }),
    w('fix-5', {}, { pending: [{ text: 'hallo' }] }),
    w('fix-6', {}, { lastAt: '2026-10-18T21:59:30Z' }),
    w('fix-7', { activity: null }),
    w('fix-8', {}, { lastAt: null }),
  ];
  assert.deepEqual(planRestarts(workers, { threshold: 200_000, slotHolder: 'verify-1', now }), ['fix-1']);
  assert.deepEqual(planRestarts(workers, { threshold: null, now }), []);
  // Cooldown je Worker, danach wieder erlaubt
  const lastRestart = new Map([['fix-1', now - 60_000]]);
  assert.deepEqual(planRestarts(workers, { threshold: 200_000, slotHolder: 'verify-1', lastRestart, now }), []);
  lastRestart.set('fix-1', now - RESTART_COOLDOWN_MS - 1);
  assert.deepEqual(planRestarts(workers, { threshold: 200_000, slotHolder: 'verify-1', lastRestart, now }), ['fix-1']);
  assert.deepEqual(planRestarts(null, { threshold: 200_000, now }), []);
});

test('chatTranscript: Nachrichten, Runden, Tool-Aufrufe mit Ergebnis, Meta und Blobs ausgelassen', () => {
  const at = (s) => `2026-10-19T00:00:${String(s).padStart(2, '0')}Z`;
  const lines = [
    { type: 'api-request-blob', body: 'x'.repeat(100) },
    { type: 'system', subtype: 'scheduled_task_fire', prompt: '/spot-fix', timestamp: at(1) },
    { type: 'user', message: { content: '<command-message>spot-fix</command-message>\n<command-name>/spot-fix</command-name>' }, timestamp: at(2) },
    { type: 'user', isMeta: true, message: { content: [{ type: 'text', text: 'Skill-Inhalt' }] }, timestamp: at(3) },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'geheim' }, { type: 'text', text: 'Ich prüfe die Queue.' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'bdw ready', description: 'Bereite Issues' } }] }, timestamp: at(4) },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'Fehler' }] }] }, timestamp: at(5) },
    { type: 'user', message: { content: 'bitte stopp' }, timestamp: at(6) },
    { type: 'user', message: { content: '<task-notification><summary>Hintergrund fertig</summary></task-notification>' }, timestamp: at(7) },
    { type: 'system', subtype: 'compact_boundary', timestamp: at(8) },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'Subagent' }] }, timestamp: at(9) },
  ].map((e) => JSON.stringify(e));
  const c = chatTranscript(['kaputt', ...lines]);
  assert.deepEqual(c.map((e) => e.kind), ['round', 'assistant', 'tool', 'user', 'note', 'note']);
  assert.equal(c[0].text, '/spot-fix');
  assert.equal(c[1].text, 'Ich prüfe die Queue.');
  assert.equal(c[2].summary, 'Bereite Issues');
  assert.equal(c[2].result, 'Fehler');
  assert.equal(c[2].error, true);
  assert.equal(c[3].text, 'bitte stopp');
  assert.match(c[4].text, /Hintergrund fertig/);
  assert.equal(c[5].text, 'Kontext zusammengefasst');
  assert.equal(chatTranscript(lines, { limit: 2 }).length, 2);
});

test('Passwort-Login: scrypt-Zeile erzeugen, lesen, prüfen', async () => {
  const line = await hashPassword('admin', 'richtig-langes-pw', Buffer.alloc(16, 7));
  assert.match(line, /^admin:scrypt\$32768\$8\$1\$[\w-]+\$[\w-]+$/);
  const entry = parsePasswordLine(line);
  assert.equal(entry.user, 'admin');
  assert.equal(await verifyPassword(entry, 'admin', 'richtig-langes-pw'), true);
  assert.equal(await verifyPassword(entry, ' Admin ', 'richtig-langes-pw'), true);
  assert.equal(await verifyPassword(entry, 'admin', 'richtig-langes-pX'), false);
  assert.equal(await verifyPassword(entry, 'root', 'richtig-langes-pw'), false);
  assert.equal(await verifyPassword(entry, 'admin', 123), false);
  assert.equal(await verifyPassword(null, 'admin', 'richtig-langes-pw'), false);
  // Unicode-Normalisierung: ä als ein oder zwei Codepoints
  const u = parsePasswordLine(await hashPassword('admin', 'm\u00e4dchen-passwort'));
  assert.equal(await verifyPassword(u, 'admin', 'ma\u0308dchen-passwort'), true);
  await assert.rejects(hashPassword('admin', 'zu-kurz'), /12 Zeichen/);
  await assert.rejects(hashPassword('Admin x', 'richtig-langes-pw'), /Benutzername/);
  assert.equal(parsePasswordLine('admin:klartext'), null);
  assert.equal(parsePasswordLine(line.replace('$32768$', '$1048577$')), null);
  assert.equal(parsePasswordLine(line.replace('$32768$', '$4294967296$')), null);
  assert.equal(parsePasswordLine(''), null);
});

test('isPagePath: Seite auch mit ?p= und ?ws=', () => {
  assert.equal(isPagePath('/?ws=clubs'), true);
  assert.equal(isPagePath('/?p=spot&ws=clubs'), true);
  assert.equal(isPagePath('/index.html'), true);
  assert.equal(isPagePath('/api/state?ws=clubs'), false);
  assert.equal(isPagePath(undefined), false);
});

test('groupIssues: human vor Phase (auch ohne Phase), Bereit/In Arbeit nach Status, Bereit freigegebene zuerst, Erledigt 24 h', () => {
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
    { id: 'a-13', status: 'open', labels: ['gt:slot'], priority: 0 },
    { id: 'a-14', status: 'pinned', labels: [], priority: 0 },
    { id: 'a-9', issue_type: 'epic', status: 'open', labels: ['phase:fix'], priority: 2 },
    { id: 'a-15', status: 'open', labels: ['modul:x'], priority: 0 },
  ], CODE, WS, NOW);
  assert.deepEqual(Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, v.map((i) => i.id)])), {
    human: ['a-11', 'a-1'], ready: ['a-6', 'a-2', 'a-15'], fix: ['a-3', 'a-12'], verify: ['a-4'], merge: ['a-5'],
    done: ['a-7'], deferred: ['a-8'],
  });
  assert.equal(cols.fix[0].stale, true);
  assert.equal(cols.fix[1].stale, false);
  const m = metrics(cols, CODE, [{ mergedAt: '2026-10-16T09:00:00Z' }, { mergedAt: '2026-10-10T09:00:00Z' }], NOW);
  assert.equal(m.stale, 1);
  assert.equal(m.done24h, 1);
  assert.equal(m.mergedToday, 1);
  assert.equal(m.working, 2);
  assert.equal(m.open, 3);
  assert.equal(m.released, 2);
  assert.deepEqual(groupIssues(null, CODE, WS, NOW).ready, []);
});

test('planIssueAction: Verschieben entfernt nur vorhandene Phasen und human', () => {
  const cur = { labels: ['phase:fix', 'human', 'modul:cli'], status: 'open' };
  assert.deepEqual(planIssueAction({ id: 'spot-1', action: 'move', to: 'verify' }, cur, CODE, D), [
    ['update', 'spot-1', '--remove-label', 'human', '--remove-label', 'phase:fix', '--add-label', 'phase:verify',
      '--append-notes', `User-Entscheidung ${D}: verschoben nach phase:verify`],
  ]);
  assert.deepEqual(planIssueAction({ id: 'spot-1', action: 'move', to: 'ready', text: 'nochmal' }, { labels: ['phase:fix'], status: 'closed' }, CODE, D), [
    ['reopen', 'spot-1'],
    ['update', 'spot-1', '--append-notes', `User-Entscheidung ${D}: verschoben nach phase:fix. nochmal`],
  ]);
  assert.deepEqual(planIssueAction({ id: 'spot-1', action: 'move', to: 'human' }, { labels: [], status: 'deferred' }, CODE, D), [
    ['undefer', 'spot-1'],
    ['update', 'spot-1', '--add-label', 'human', '--append-notes', `User-Entscheidung ${D}: braucht Entscheidung`],
  ]);
  assert.deepEqual(planIssueAction({ id: 'spot-1', action: 'move', to: 'deferred' }, cur, CODE, D), [['defer', 'spot-1']]);
  assert.deepEqual(planIssueAction({ id: 'spot-1', action: 'move', to: 'deferred' }, { status: 'closed' }, CODE, D), [
    ['reopen', 'spot-1'], ['defer', 'spot-1'],
  ]);
  assert.deepEqual(planIssueAction({ id: 'spot-1', action: 'move', to: 'done', text: 'doppelt' }, cur, CODE, D), [
    ['close', 'spot-1', '--reason', `User-Entscheidung ${D}: doppelt`],
  ]);
  assert.throws(() => planIssueAction({ id: 'spot-1', action: 'move', to: 'done' }, cur, CODE, D), /Grund/);
  assert.throws(() => planIssueAction({ id: 'spot-1', action: 'move', to: 'fix' }, cur, CODE, D), /Ziel/);
});

test('planIssueAction: Priorität und Unclaim', () => {
  assert.deepEqual(planIssueAction({ id: 'spot-1', action: 'priority', value: 0 }, {}, CODE), [['update', 'spot-1', '--priority', '0']]);
  assert.throws(() => planIssueAction({ id: 'spot-1', action: 'priority', value: '1; x' }, {}, CODE), /Priorität/);
  assert.throws(() => planIssueAction({ id: 'spot-1', action: 'priority', value: 5 }, {}, CODE), /Priorität/);
  assert.deepEqual(planIssueAction({ id: 'spot-1', action: 'unclaim' }, { status: 'in_progress', assignee: 'fix-2' }, CODE), [
    ['unclaim', 'spot-1', '--force', '--if-assignee', 'fix-2'],
  ]);
  assert.throws(() => planIssueAction({ id: 'spot-1', action: 'unclaim' }, { status: 'open' }, CODE), /nicht geclaimt/);
  assert.throws(() => planIssueAction({ id: '--force', action: 'unclaim' }, { status: 'in_progress', assignee: 'x' }, CODE), /Issue-ID/);
});

test('planCreate: Werte als --flag=wert, Labels aus Modul und human', () => {
  assert.deepEqual(planCreate({ title: '  --force  Titel  ', description: '', priority: 1, modul: 'cli', human: true }, CODE, CFG.modules), [
    ['create', '--title=--force Titel', '--description=--force Titel', '--priority=1', '--type=bug', '--labels=phase:fix,modul:cli,human'],
  ]);
  assert.throws(() => planCreate({ title: 'kurz' }, CODE, CFG.modules), /Titel/);
  assert.throws(() => planCreate({ title: 'langer Titel', modul: 'x,human' }, CODE, CFG.modules), /Modul/);
  assert.throws(() => planCreate({ title: 'langer Titel', type: 'epic' }, CODE, CFG.modules), /Typ/);
});

test('planWorkerAction: nur bekannte Rollen und Worker-Namen', () => {
  const p = (body) => planWorkerAction(body, WS);
  assert.deepEqual(p({ action: 'add', role: 'fix' }), ['add', 'fix']);
  assert.deepEqual(p({ action: 'drain', role: 'all' }), ['drain']);
  assert.deepEqual(p({ action: 'drain', role: 'verify', off: true }), ['drain', 'verify', '--off']);
  assert.deepEqual(p({ action: 'stop', name: 'fix-2', force: true }), ['stop', 'fix-2', '--force']);
  assert.throws(() => p({ action: 'add', role: '--iterm' }), /Rolle/);
  assert.throws(() => p({ action: 'stop', name: '--all' }), /Worker/);
  assert.deepEqual(p({ action: 'stop', name: 'all' }), ['stop', '--all']);
  assert.deepEqual(p({ action: 'stop', name: 'all', force: true }), ['stop', '--all', '--force']);
  assert.throws(() => p({ action: 'restart', role: 'fix' }), /Worker/);
  assert.throws(() => p({ action: 'restart', name: 'fix-1 --force' }), /Worker/);
  assert.throws(() => p({ action: 'reboot', name: 'fix-1' }), /Aktion/);
  assert.deepEqual(p({ action: 'restart', name: 'verify-3' }), ['restart', 'verify-3']);
  assert.deepEqual(p({ action: 'restart', name: 'fix-1', force: true }), ['restart', 'fix-1', '--force']);
  assert.deepEqual(p({ action: 'autorestart', threshold: 200000 }), ['autorestart', '--over', '200000']);
  assert.deepEqual(p({ action: 'autorestart', off: true }), ['autorestart', '--off']);
  assert.throws(() => p({ action: 'autorestart', threshold: 10000 }), /Schwelle/);
  assert.throws(() => p({ action: 'autorestart', threshold: '200000 --off' }), /Schwelle/);
  assert.deepEqual(p({ action: 'start', counts: { fix: 3, verify: 1 } }),
    ['start', '--ws', 'code', 'fix=3', 'search=0', 'verify=1', 'regress=0']);
  assert.throws(() => p({ action: 'start', counts: { fix: 9 } }), /0–8/);
  assert.throws(() => p({ action: 'start', counts: { fix: '1 --iterm' } }), /0–8/);
  assert.ok(workerRe(['fix', 'x|y', 'audit']).test('audit-3'));
  assert.equal(workerRe(['fix', 'x|y']).test('y-1'), false);
});

test('planWorkerAction send: eine Zeile ohne Steuerzeichen, nur gültige Worker', () => {
  const p = (body) => planWorkerAction(body, WS);
  assert.deepEqual(p({ action: 'send', name: 'fix-1', text: ' bitte /compact\n' }), ['send', 'fix-1', '--', 'bitte /compact']);
  assert.deepEqual(p({ action: 'send', name: 'fix-1', text: 'a\r\nb\u001b[2Jc' }), ['send', 'fix-1', '--', 'a b[2Jc']);
  assert.deepEqual(p({ action: 'send', name: 'fix-1', text: '--force' }), ['send', 'fix-1', '--', '--force']);
  assert.throws(() => p({ action: 'send', name: 'fix-1', text: ' \n ' }), /kein Text/);
  assert.throws(() => p({ action: 'send', name: 'fix-1', text: 'x'.repeat(4001) }), /zu lang/);
  assert.throws(() => p({ action: 'send', name: '--all', text: 'hi' }), /Worker/);
});

test('parsePool: Dienst, Plätze, Pool-Runner nach Platz, wartende Jobs, verwirft Ungültiges', () => {
  const p = parsePool({
    service: 'active', token: true, slots: 4, at: '2026-10-25T22:00:00Z',
    repos: [{ repo: 'o/spot', label: 'spot' }, { repo: 1 }],
    queued: { spot: 2, regiehub: 0, x: 'viele' },
    runners: [
      { name: 'pool-regiehub-1-2', label: 'regiehub', repo: 'o/BrightHub', slot: '2', busy: false, github: 'online', cpu: 3.5, mem: 7e8 },
      { name: 'pool-spot-1-1', label: 'spot', repo: 'o/spot', slot: '1', busy: true, github: 'online', job: {
        name: 'Backend', branch: 'fix/x', title: 'Fix', url: 'javascript:x', started: '2026-10-25T21:59:00Z' } },
      { name: 'spot-runner-1' }, null,
    ],
    mysql: { container: 'running', cpu: 1, mem: 2 },
    mariadb: { container: 'exited' },
    slice: { cpuPct: 120, cpus: 4, mem: 3e9 },
  });
  assert.deepEqual(p.mariadb, { container: 'exited', cpu: null, mem: null });
  assert.equal(p.service, 'active');
  assert.equal(p.slots, 4);
  assert.deepEqual(p.repos, [{ repo: 'o/spot', label: 'spot' }]);
  assert.deepEqual(p.queued, { spot: 2 });
  assert.deepEqual(p.runners.map((r) => [r.name, r.slot, r.busy]), [['pool-spot-1-1', 1, true], ['pool-regiehub-1-2', 2, false]]);
  assert.equal(p.runners[0].job.url, null);
  assert.equal(p.runners[0].cpu, null);
  assert.equal(p.runners[1].mem, 7e8);
  assert.deepEqual(p.mysql, { container: 'running', cpu: 1, mem: 2 });
  assert.deepEqual(p.slice, { cpuPct: 120, cpus: 4, mem: 3e9 });
  const empty = parsePool(null);
  assert.deepEqual([empty.service, empty.token, empty.slots, empty.runners, empty.mysql, empty.mariadb], ['missing', false, null, [], null, null]);
  assert.equal(parsePool({ slots: 12 }).slots, null);
  assert.equal(empty.limits, null);
});

test('parsePool: Grenzen je Projekt, null solange der Server sie nicht kennt', () => {
  const p = parsePool({ limits: {
    spot: { max: 2, paused: false }, regiehub: { paused: true }, 'A;x': { max: 1 }, c: { max: 12, paused: 'ja' }, d: 3,
  } });
  assert.deepEqual(p.limits, { spot: { max: 2, paused: false }, regiehub: { max: null, paused: true }, c: { max: null, paused: false } });
  assert.deepEqual(parsePool({ limits: {} }).limits, {});
  assert.equal(parsePool({ limits: [] }).limits, null);
  assert.equal(parsePool({}).limits, null);
});

test('parsePool: Warteschlange in Reihenfolge des Dienstes, verwirft Ungültiges', () => {
  const p = parsePool({ queue: [
    { repo: 'o/spot', label: 'spot', run: 42, pr: 1013, branch: 'fix/x', title: 'Fix', url: 'https://github.com/o/spot/actions/runs/42',
      jobs: 3, created: '2026-10-26T10:00:00Z', prio: true, runLabel: true, runStatus: 'pending', stale: true },
    { repo: 'o/BrightHub', label: 'regiehub', run: 7, pr: '', branch: 'main', url: 'javascript:x', jobs: 0, prio: 'ja', runStatus: 3, stale: 'ja' },
    { repo: 'o/spot;rm', run: 1 }, { repo: 'o/spot', run: '42' }, { repo: 'o/spot', run: -1 }, null,
  ] });
  assert.deepEqual(p.queue, [
    { repo: 'o/spot', label: 'spot', run: 42, pr: 1013, branch: 'fix/x', title: 'Fix', url: 'https://github.com/o/spot/actions/runs/42',
      jobs: 3, created: '2026-10-26T10:00:00Z', prio: true, runLabel: true, runStatus: 'pending', stale: true },
    { repo: 'o/BrightHub', label: 'regiehub', run: 7, pr: null, branch: 'main', title: '', url: null,
      jobs: 1, created: null, prio: false, runLabel: false, runStatus: '', stale: false },
  ]);
  assert.deepEqual(parsePool({}).queue, []);
  assert.deepEqual(parsePool({ queue: {} }).queue, []);
});

test('planRunnerAction: prio zieht einen Lauf vor oder nimmt ihn heraus, prüft Repo und Run-ID', () => {
  assert.deepEqual(planRunnerAction({ action: 'prio', repo: 'o/spot-mm', run: 123 }), ['prio', 'o/spot-mm', '123']);
  assert.deepEqual(planRunnerAction({ action: 'prio', repo: 'o/spot', run: 9, off: true }), ['prio', '--off', 'o/spot', '9']);
  for (const repo of ['spot', 'o/spot;rm', '--clear', 'o/a/b', undefined]) {
    assert.throws(() => planRunnerAction({ action: 'prio', repo, run: 1 }), /Repo/);
  }
  for (const run of [0, -3, 1.5, '12', undefined, 2 ** 60]) {
    assert.throws(() => planRunnerAction({ action: 'prio', repo: 'o/spot', run }), /Run-ID/);
  }
});

test('parseMysql: Zustand, CPU und RAM der CI-MySQL, null ohne', () => {
  assert.deepEqual(parseMysql({ container: 'running', cpu: 6.2, mem: 8e8, x: 1 }), { container: 'running', cpu: 6.2, mem: 8e8 });
  assert.deepEqual(parseMysql({ cpu: 'x' }), { container: 'missing', cpu: null, mem: null });
  assert.equal(parseMysql(null), null);
});

test('parseSlice: Zahlen der CI-Slice, null ohne Messwerte', () => {
  assert.deepEqual(parseSlice({ cpuPct: 389.2, cpus: 4, mem: 9e9, x: 1 }), { cpuPct: 389.2, cpus: 4, mem: 9e9 });
  assert.deepEqual(parseSlice({ cpuPct: 12, cpus: null, mem: 'viel' }), { cpuPct: 12, cpus: null, mem: null });
  assert.equal(parseSlice({ cpuPct: null, cpus: null, mem: null }), null);
  assert.equal(parseSlice(null), null);
  assert.equal(parseSlice('x'), null);
});

test('parseWorkers nimmt nur Sessions in den Worktrees, mit Rolle und Workspace, sortiert numerisch', () => {
  const wt = '/repo/.claude/worktrees';
  const ws = parseWorkers([
    { cwd: `${wt}/fix-10`, kind: 'background', status: 'busy', sessionId: 's1', name: 'fix-10', pid: 5, startedAt: 0 },
    { cwd: `${wt}/fix-2/spot-app`, kind: 'interactive', status: 'idle' },
    { cwd: '/repo', kind: 'interactive', status: 'busy' },
    { cwd: `${wt}/add-worker`, kind: 'interactive', status: 'busy' },
    { cwd: `${wt}/club-add-1`, kind: 'interactive', status: 'busy' },
    { cwd: `${wt}/club-x-1`, kind: 'background', status: 'idle' },
  ], wt, WS);
  assert.deepEqual(ws.map((w) => [w.name, w.role, w.ws, w.kind, w.status]), [
    ['club-add-1', 'club-add', 'clubs', 'terminal', 'busy'],
    ['fix-2', 'fix', 'code', 'terminal', 'idle'],
    ['fix-10', 'fix', 'code', 'background', 'busy'],
  ]);
  assert.equal(ws[2].sessionId, 's1');
  assert.equal(ws[2].session, 'fix-10');
  assert.deepEqual(parseWorkers(null, wt, WS), []);
});

test('parseProjectList: Pfade ohne Kommentare, Leerzeilen und Dubletten', () => {
  assert.deepEqual(parseProjectList('/a\n\n# alt\n /b \n/a\n'), ['/a', '/b']);
  assert.deepEqual(parseProjectList(''), []);
});

test('projectPaths: eigenes Root nur als eingerichtetes Projekt, ohne Dublette', () => {
  assert.deepEqual(projectPaths(['/a'], '/self', true), ['/self', '/a']);
  assert.deepEqual(projectPaths(['/a'], '/self', false), ['/a']);
  assert.deepEqual(projectPaths(['/self', '/a'], '/self', true), ['/self', '/a']);
  assert.deepEqual(projectPaths(['/a'], null, true), ['/a']);
});

test('normalizeConfig: Vorgaben, ungültige Werte fallen weg, publicConfig ohne Pfade', () => {
  assert.equal(normalizeConfig(null), null);
  assert.equal(normalizeConfig({ root: '/r', slug: 'Böse Slug' }), null);
  const c = normalizeConfig({ root: '/r', slug: 'regiehub', name: 'RegieHub', base: 'release-2.1.0',
    roles: ['fix', 'verify', 'x;rm'], modules: ['server', 'admin', '../x'], drain: '/r/.git/regiehub-workers-drain' });
  assert.deepEqual(c.roles, ['fix', 'verify']);
  assert.deepEqual(c.modules, ['server', 'admin']);
  assert.equal(c.base, 'release-2.1.0');
  // ohne workspaces (beadskit 1.0): code aus den Rollen, Repo nur das Projekt, keine Runner
  assert.deepEqual(c.workspaces, [{ key: 'code', name: 'Code', roles: ['fix', 'verify'],
    phases: [{ key: 'fix', title: null }, { key: 'verify', title: null }, { key: 'merge', title: null }] }]);
  assert.deepEqual(c.repos, [{ key: '.', path: '/r' }]);
  assert.equal(c.runners, false);
  assert.deepEqual(normalizeConfig({ root: '/r', slug: 's' }).roles, ['fix', 'search', 'verify', 'regress']);
  const pub = publicConfig(CFG);
  assert.equal('root' in pub || 'drain' in pub || 'autorestart' in pub, false);
  assert.deepEqual(pub.repos, ['.', 'side']);
  // Workspaces mit kaputten Phasen oder fremden Rollen fallen weg
  const w = normalizeConfig({ root: '/r', slug: 's', roles: ['fix', 'a'], workspaces: [
    { key: 'code', phases: [{ key: 'fix' }], roles: ['fix'] },
    { key: 'Böse', phases: [{ key: 'x' }], roles: ['a'] },
    { key: 'leer', phases: [], roles: ['a'] },
    { key: 'fremd', phases: [{ key: 'x' }], roles: ['nicht-da'] },
  ] });
  assert.deepEqual(w.workspaces.map((x) => x.key), ['code']);
});

test('buildWorkspaces: Spalten, Ziele, Kennzahlen und Texte aus Config und Projektdatei', () => {
  assert.deepEqual(CODE.cols.map(([k, t]) => [k, t]), [['ready', 'Bereit'], ['fix', 'In Arbeit'], ['verify', 'Verify'], ['merge', 'Merge'], ['done', 'Erledigt']]);
  assert.deepEqual(CODE.moveTargets, ['ready', 'verify', 'merge', 'human', 'deferred', 'done']);
  assert.equal(CODE.readyPhase, 'fix');
  assert.equal(CODE.colors.fix, 'var(--fix)');
  assert.equal(CODE.prs, true);
  assert.equal(CODE.group.prefix, 'modul:');
  assert.ok(CODE.kpis.some(([k]) => k === 'mergedToday'));
  assert.deepEqual(CODE.kpis.slice(1, 3), [['open', 'bereit'], ['released', 'bereit: Fix']]);
  assert.deepEqual(CLUBS.cols.map(([k, t]) => [k, t]), [['ready', 'Bereit'], ['place', 'Anlegen'], ['settings', 'Settings'], ['test', 'Test'], ['done', 'Erledigt']]);
  assert.deepEqual(CLUBS.cols[2].slice(2), ['#1ea0aa', 'SiteSetting einrichten']);
  assert.deepEqual(CLUBS.moveTargets, ['ready', 'settings', 'test', 'human', 'deferred', 'done']);
  assert.equal(CLUBS.colors['club-add'], 'rgb(230 120 30)');
  assert.equal(CLUBS.colors['club-test'], 'var(--muted)');
  assert.equal(CLUBS.roleLabels['club-add'], 'Anlegen');
  assert.equal(CLUBS.roleLabels['club-search'], 'Club search');
  assert.equal(CLUBS.prs, false);
  assert.deepEqual(CLUBS.split, [{ key: 'activate', label: 'aktivieren', title: 'zum Aktivieren' }]);
  assert.deepEqual(CLUBS.kpis.slice(0, 3).map(([k]) => k), ['human', 'activate', 'open']);
  assert.deepEqual(CLUBS.kpis[3], ['released', 'bereit: Anlegen']);
  assert.deepEqual(CLUBS.defaults, { 'club-search': 1, 'club-add': 1, 'club-settings': 2, 'club-test': 1 });
  // CSS aus der Projektdatei nur, wenn es eine Farbe ist
  const evil = buildWorkspaces(CFG, normalizeExt({ workspaces: { code: { colors: { fix: 'red;}</style><script>' }, cols: { ready: { color: 'url(x)' } } } } }));
  assert.equal(evil.code.colors.fix, 'var(--fix)');
  assert.equal(evil.code.cols[0][2], 'var(--ready)');
});

test('groupIssues: code ohne ws:clubs-Issues, clubs mit eigenen Spalten und split', () => {
  const issues = [
    { id: 'c-1', status: 'open', labels: ['phase:fix'], priority: 2 },
    { id: 'c-2', status: 'open', labels: ['phase:fix', 'ws:code'], priority: 2 },
    { id: 'k-1', status: 'open', labels: ['ws:clubs', 'phase:place', 'stadt:Bonn'], priority: 2 },
    { id: 'k-2', status: 'in_progress', labels: ['ws:clubs', 'phase:place'], priority: 2, lease_expires_at: '2026-10-16T11:00:00Z' },
    { id: 'k-3', status: 'in_progress', labels: ['ws:clubs', 'phase:settings'], priority: 2 },
    { id: 'k-4', status: 'open', labels: ['ws:clubs', 'phase:test'], priority: 2 },
    { id: 'k-5', status: 'open', labels: ['ws:clubs', 'phase:test', 'human'], priority: 1 },
    { id: 'k-6', status: 'open', labels: ['ws:clubs', 'phase:test', 'human', 'aktivieren'], priority: 2 },
    { id: 'k-7', status: 'closed', labels: ['ws:clubs'], priority: 2, closed_at: '2026-10-16T10:00:00Z' },
    { id: 'k-8', status: 'deferred', labels: ['ws:clubs', 'phase:place'], priority: 2 },
    { id: 'k-9', issue_type: 'epic', status: 'open', labels: ['ws:clubs'], priority: 2 },
  ];
  const ids = (cols) => Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, v.map((i) => i.id)]));
  assert.deepEqual(ids(groupIssues(issues, CODE, WS, NOW)), {
    human: [], ready: ['c-1', 'c-2'], fix: [], verify: [], merge: [], done: [], deferred: [],
  });
  const clubs = groupIssues(issues, CLUBS, WS, NOW);
  assert.deepEqual(ids(clubs), {
    human: ['k-5'], activate: ['k-6'], ready: ['k-1'], place: ['k-2'], settings: ['k-3'], test: ['k-4'],
    done: ['k-7'], deferred: ['k-8'],
  });
  const m = metrics(clubs, CLUBS, [], NOW);
  assert.equal(m.human, 1);
  assert.equal(m.activate, 1);
  assert.equal(m.place, 1);
  assert.equal(m.released, 1);
  assert.equal(m.working, 1);
  assert.equal(m.stale, 1);
  assert.equal(wsOfIssue({ labels: ['ws:unbekannt'] }, WS), 'code');
  assert.equal(wsOfIssue({ labels: ['ws:__proto__'] }, WS), 'code');
  // jede Board-Spalte der Beschreibung hat eine Spalte im Ergebnis
  for (const def of Object.values(WS)) {
    const cols = groupIssues([], def, WS, NOW);
    for (const [k] of def.cols) assert.ok(Array.isArray(cols[k]), `${def.name}.${k}`);
    for (const s of def.split) assert.ok(Array.isArray(cols[s.key]), `${def.name}.${s.key}`);
  }
});

test('planIssueAction: in clubs ist Bereit phase:place, verschieben entfernt split-Labels', () => {
  const cur = { labels: ['ws:clubs', 'phase:test', 'human', 'aktivieren'], status: 'open' };
  assert.deepEqual(planIssueAction({ id: 'spot-1', action: 'move', to: 'ready' }, cur, CLUBS, D), [
    ['update', 'spot-1', '--remove-label', 'human', '--remove-label', 'aktivieren', '--remove-label', 'phase:test',
      '--add-label', 'phase:place', '--append-notes', `User-Entscheidung ${D}: verschoben nach phase:place`],
  ]);
  assert.deepEqual(planIssueAction({ id: 'spot-1', action: 'move', to: 'settings' }, { labels: ['ws:clubs', 'phase:place'] }, CLUBS, D), [
    ['update', 'spot-1', '--remove-label', 'phase:place', '--add-label', 'phase:settings',
      '--append-notes', `User-Entscheidung ${D}: verschoben nach phase:settings`],
  ]);
  assert.throws(() => planIssueAction({ id: 'spot-1', action: 'move', to: 'verify' }, { labels: ['ws:clubs'] }, CLUBS, D), /Ziel/);
  assert.throws(() => planIssueAction({ id: 'spot-1', action: 'move', to: 'settings' }, { labels: [] }, CODE, D), /Ziel/);
});

test('planWorkerAction: Rollen nur im eigenen Workspace', () => {
  const p = (body) => planWorkerAction(body, WS);
  assert.deepEqual(p({ action: 'start', ws: 'clubs', counts: { 'club-settings': 2, 'club-add': 1 } }),
    ['start', '--ws', 'clubs', 'club-search=0', 'club-add=1', 'club-settings=2', 'club-test=0']);
  assert.deepEqual(p({ action: 'add', ws: 'clubs', role: 'club-add' }), ['add', 'club-add']);
  assert.deepEqual(p({ action: 'drain', ws: 'clubs', role: 'club-test', off: true }), ['drain', 'club-test', '--off']);
  assert.deepEqual(p({ action: 'drain', ws: 'clubs', role: 'ws' }), ['drain', '--ws', 'clubs']);
  assert.deepEqual(p({ action: 'drain', ws: 'clubs', role: 'all' }), ['drain']);
  assert.throws(() => p({ action: 'add', role: 'club-add' }), /Rolle/);
  assert.throws(() => p({ action: 'add', ws: 'code', role: 'club-add' }), /Rolle/);
  assert.throws(() => p({ action: 'drain', ws: 'clubs', role: 'fix' }), /Rolle/);
  assert.throws(() => p({ action: 'add', ws: '__proto__', role: 'fix' }), /Workspace/);
  assert.throws(() => p({ action: 'start', ws: 'clubs', counts: { 'club-add': 9 } }), /0–8/);
  assert.deepEqual(p({ action: 'restart', name: 'club-settings-2' }), ['restart', 'club-settings-2']);
  assert.deepEqual(p({ action: 'send', name: 'club-add-1', text: 'hallo' }), ['send', 'club-add-1', '--', 'hallo']);
  assert.throws(() => p({ action: 'restart', name: 'club-1' }), /Worker/);
  assert.throws(() => p({ action: 'restart', name: 'club-add-x' }), /Worker/);
  // nur code: Rollen kommen aus dem Projekt
  const small = buildWorkspaces(normalizeConfig({ root: '/r', slug: 's', roles: ['fix', 'verify'] }));
  assert.deepEqual(planWorkerAction({ action: 'start', counts: { fix: 1, search: 4 } }, small), ['start', '--ws', 'code', 'fix=1', 'verify=0']);
  assert.throws(() => planWorkerAction({ action: 'add', role: 'search' }, small), /Rolle/);
  assert.throws(() => planWorkerAction({ action: 'stop', name: 'search-1' }, small), /Worker/);
});

test('planCreate: Workspace-Labels, Zusatzfelder als Label, Typ aus dem Workspace', () => {
  assert.deepEqual(planCreate({ title: 'Club: Bahnhof (Bad Honnef)', stadt: '  Bad  Honnef ', priority: 2 }, CLUBS, CFG.modules), [
    ['create', '--title=Club: Bahnhof (Bad Honnef)', '--description=Club: Bahnhof (Bad Honnef)', '--priority=2', '--type=task',
      '--labels=ws:clubs,phase:place,stadt:bad-honnef'],
  ]);
  assert.equal(labelSlug('Mülheim an der Ruhr'), 'muelheim-an-der-ruhr');
  assert.equal(labelSlug('Gießen'), 'giessen');
  assert.equal(labelSlug('Bonn,human'), 'bonn-human');
  assert.equal(labelSlug(''), '');
  assert.deepEqual(planCreate({ title: 'Club ohne Stadt', human: true }, CLUBS, CFG.modules)[0].at(-1),
    '--labels=ws:clubs,phase:place,human');
  // Module gibt es in clubs nicht (create.modules false)
  assert.throws(() => planCreate({ title: 'Club mit Modul', modul: 'cli' }, CLUBS, CFG.modules), /Modul/);
  assert.throws(() => planCreate({ title: 'Club mit langer Stadt', stadt: 'x'.repeat(61) }, CLUBS, CFG.modules), /Stadt/);
  assert.deepEqual(planCreate({ title: 'Titel lang genug', modul: 'app' }, CODE, CFG.modules)[0].at(-1), '--labels=phase:fix,modul:app');
});

test('normalizeExt und cardExtras: nur gültige Teile, Links nur http(s), Aktionen mit applies/check', () => {
  const warns = [];
  const ext = normalizeExt({ default: {
    card: (it) => ({
      logo: it.metadata?.logo, tags: ['Bonn', 7, ''],
      links: [{ href: 'https://x.example/a', text: 'Web' }, { href: 'javascript:alert(1)', text: 'böse' }, { href: 'https://y', text: '' }],
    }),
    actions: [
      { key: 'activate', title: 'Aktivieren', primary: true, applies: (it) => it.labels.includes('aktivieren'),
        check: (it) => (it.metadata?.place_id ? null : 'place_id fehlt'), run: () => [] },
      { key: 'kaputt', title: 'ohne run', applies: () => true },
      { key: 'wirft', title: 'Wirft', applies: () => { throw new Error('x'); }, run: () => [] },
    ],
    panels: [{ key: 'cities', title: 'Neue Städte', items: () => [] }, { key: 'BAD KEY', title: 'x', items: () => [] }],
  } }, (m) => warns.push(m));
  assert.deepEqual(ext.actions.map((a) => a.key), ['activate', 'wirft']);
  assert.deepEqual(ext.panels.map((p) => p.key), ['cities']);
  assert.equal(warns.length, 2);
  const x = cardExtras({ id: 'spot-1', labels: ['aktivieren'], metadata: { logo: 'data:image/png;base64,xx' } }, ext);
  assert.equal(x.logo, undefined);
  assert.deepEqual(x.tags, ['Bonn']);
  assert.deepEqual(x.links, [{ href: 'https://x.example/a', text: 'Web' }]);
  assert.deepEqual(x.actions, [{ key: 'activate', title: 'Aktivieren', hint: '', confirm: 'Aktivieren?', primary: true, disabled: 'place_id fehlt' }]);
  assert.equal(cardExtras({ id: 'spot-1', labels: ['aktivieren'], metadata: { place_id: 1 } }, ext).actions[0].disabled, null);
  // card wirft: keine Zusatzangaben, aber kein Fehler
  assert.equal(cardExtras({ id: 'a-1', labels: [] }, normalizeExt({ card: () => { throw new Error('kaputt'); } })), null);
  assert.equal(cardExtras({ id: 'a-1', labels: [] }, normalizeExt(null)), null);
});

test('repoOfIssue: modul:<repo> eines weiteren Repos, sonst das Projekt selbst', () => {
  assert.equal(repoOfIssue({ labels: ['modul:side'] }, CFG.repos), 'side');
  assert.equal(repoOfIssue({ labels: ['modul:cli'] }, CFG.repos), '.');
  assert.equal(repoOfIssue({ labels: ['modul:.'] }, CFG.repos), '.');
  assert.equal(repoOfIssue(null, CFG.repos), '.');
});

// ---- Zwei Rechner ----
const HOSTS_CONF = `# Kommentar
LEADER=pc
HOSTS="mac pc"
SELF=pc
BK_HOST_BASE=100
HOST_mac_SSH=felix@mac.tail1234.ts.net
HOST_mac_ROOT=/Users/felix/IdeaProjects/
HOST_pc_ROOT=/home/felix/IdeaProjects
HOST_pc_SSH=-oProxyCommand=evil
`;

test('parseHostsConf: Rechner, ssh-Ziele und Ordner; ohne LEADER/SELF ein Rechner', () => {
  const c = parseHostsConf(HOSTS_CONF);
  assert.equal(c.leader, 'pc');
  assert.equal(c.self, 'pc');
  assert.deepEqual(c.hosts, [
    { name: 'mac', ssh: 'felix@mac.tail1234.ts.net', root: '/Users/felix/IdeaProjects' },
    // eine ssh-Option als Ziel fällt auf den Namen zurück
    { name: 'pc', ssh: 'pc', root: '/home/felix/IdeaProjects' },
  ]);
  assert.equal(parseHostsConf(''), null);
  assert.equal(parseHostsConf('SELF=mac\n'), null);
  assert.equal(parseHostsConf('LEADER=PC\nSELF=mac\n'), null);
  // LEADER und SELF zählen auch ohne HOSTS, ungültige Namen fallen weg
  assert.deepEqual(parseHostsConf('LEADER=pc\nSELF=mac\nHOSTS="NAS n_s"\n').hosts.map((h) => h.name), ['pc', 'mac']);
});

test('mapRoot: Präfix tauschen, fremde Pfade null', () => {
  assert.equal(mapRoot('/home/felix/IdeaProjects/spot-mm', '/home/felix/IdeaProjects', '/Users/felix/IdeaProjects'), '/Users/felix/IdeaProjects/spot-mm');
  assert.equal(mapRoot('/home/felix/IdeaProjects', '/home/felix/IdeaProjects', '/x'), '/x');
  assert.equal(mapRoot('/home/felix/IdeaProjectsX/a', '/home/felix/IdeaProjects', '/x'), null);
  assert.equal(mapRoot('/opt/a', '/home/felix/IdeaProjects', '/x'), null);
  assert.equal(mapRoot('/a', null, '/x'), null);
});

test('shQuote/remoteCommand: jedes Argument bleibt auf der Gegenseite ein einziges Wort', () => {
  const nasty = ["'; rm -rf ~; '", '$(touch /tmp/x)', '`id`', 'a b', 'zwei\nZeilen', '"', ''];
  for (const s of nasty) assert.equal(execFileSync('sh', ['-c', `printf %s ${shQuote(s)}`], { encoding: 'utf8' }), s);
  const line = remoteCommand('/home/f/P/spot', 'scripts/beadskit/workers', ['send', 'fix-1', '--', "it's $HOME"]);
  assert.equal(line, "'/home/f/P/spot/scripts/beadskit/on-host' '/home/f/P/spot' 'scripts/beadskit/workers' 'send' 'fix-1' '--' 'it'\\''s $HOME'");
  const words = execFileSync('sh', ['-c', `set -- ${line}; printf '%s|' "$@"`], { encoding: 'utf8' });
  assert.equal(words, "/home/f/P/spot/scripts/beadskit/on-host|/home/f/P/spot|scripts/beadskit/workers|send|fix-1|--|it's $HOME|");
});

test('mergeHostWorkers: Rechner an jedem Worker, Workspace aus der Rolle, ein Rechner offline', () => {
  const { workers, hosts } = mergeHostWorkers([
    { host: 'mac', ok: true, self: false, leader: false, workers: [{ name: 'fix-2', role: 'fix', ws: 'x' }, { name: 'club-add-1', role: 'club-add' }] },
    { host: 'pc', ok: true, self: true, leader: true, workers: [{ name: 'fix-101', role: 'fix' }, null, { name: 7 }] },
    { host: 'nas', ok: false, error: 'ssh: connect to host nas port 22: Connection refused' },
  ], WS);
  assert.deepEqual(workers.map((w) => [w.name, w.host, w.ws]), [['club-add-1', 'mac', 'clubs'], ['fix-2', 'mac', 'code'], ['fix-101', 'pc', 'code']]);
  assert.deepEqual(hosts.map((h) => [h.name, h.ok, h.leader, h.self]), [['mac', true, false, false], ['pc', true, true, true], ['nas', false, false, false]]);
  assert.match(hosts[2].error, /Connection refused/);
  // ok ohne Liste zählt als Fehler
  assert.equal(mergeHostWorkers([{ host: 'mac', ok: true }], WS).hosts[0].ok, false);
});

test('parseMarkers: Drain global, je Rolle, je Rechner, Schwelle des Auto-Neustarts', () => {
  const m = parseMarkers({ 'beadskit.drain-fix': '1', 'beadskit.drain@mac': '1', 'beadskit.autorestart': '300000', schema_version: 1 },
    ['fix', 'verify'], ['mac', 'pc']);
  assert.deepEqual(m, { drain: { all: false, roles: { fix: true, verify: false }, hosts: { mac: true, pc: false } }, threshold: 300000 });
  const all = parseMarkers({ 'beadskit.drain': '1', 'beadskit.autorestart': 'kaputt' }, ['fix'], []);
  assert.deepEqual(all, { drain: { all: true, roles: { fix: true }, hosts: {} }, threshold: null });
  // beads antwortet nicht: nichts markiert
  assert.deepEqual(parseMarkers(null, ['fix']).drain.roles, { fix: false });
});

test('planWorkerAction drain role host / routeWorkerAction: wo die Aktion läuft', () => {
  assert.deepEqual(planWorkerAction({ action: 'drain', role: 'host', host: 'mac' }, WS, ['mac', 'pc']), ['drain', '--host', 'mac']);
  assert.deepEqual(planWorkerAction({ action: 'drain', role: 'host', host: 'mac', off: true }, WS, ['mac', 'pc']), ['drain', '--host', 'mac', '--off']);
  assert.throws(() => planWorkerAction({ action: 'drain', role: 'host', host: 'nas' }, WS, ['mac', 'pc']), /Rechner/);
  assert.throws(() => planWorkerAction({ action: 'drain', role: 'host', host: 'mac' }, WS), /Rechner/);

  const hosts = [{ name: 'mac', ok: true }, { name: 'pc', ok: true }, { name: 'nas', ok: false }];
  const workers = [{ name: 'fix-1', host: 'mac' }, { name: 'fix-101', host: 'pc' }];
  const route = (body) => routeWorkerAction(body, { hosts, self: 'pc', workers });
  assert.deepEqual(route({ action: 'start' }), ['pc']);
  assert.deepEqual(route({ action: 'add', host: 'mac' }), ['mac']);
  assert.throws(() => route({ action: 'start', host: 'x' }), /Rechner/);
  assert.deepEqual(route({ action: 'restart', name: 'fix-1' }), ['mac']);
  assert.deepEqual(route({ action: 'send', name: 'fix-101' }), ['pc']);
  assert.throws(() => route({ action: 'stop', name: 'fix-7' }), /keinem Rechner/);
  assert.deepEqual(route({ action: 'stop', name: 'all' }), ['mac', 'pc']);
  assert.deepEqual(route({ action: 'drain', role: 'all' }), ['pc']);
  assert.deepEqual(route({ action: 'autorestart' }), ['pc']);
  // ein Rechner: immer hier
  assert.deepEqual(routeWorkerAction({ action: 'restart', name: 'fix-1' }), [null]);
});

test('planRestarts über zwei Rechner: Namen sind über die Nummernbereiche eindeutig', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  const idle = (name, host) => ({ name, host, status: 'idle', issues: [], activity: { contextTokens: 400_000, lastAt: '2026-10-25T11:50:00Z', pending: [] } });
  const workers = [idle('fix-1', 'mac'), idle('fix-101', 'pc'), { ...idle('verify-101', 'pc'), drained: true }];
  assert.deepEqual(planRestarts(workers, { threshold: 200_000, now }), ['fix-1', 'fix-101']);
});

test('normalizeConfig: markers kv nur ausdrücklich, publicConfig ohne markers', () => {
  assert.equal(normalizeConfig({ root: '/r', slug: 's', markers: 'kv' }).markers, 'kv');
  assert.equal(normalizeConfig({ root: '/r', slug: 's', markers: 'x' }).markers, 'file');
  assert.equal('markers' in publicConfig(normalizeConfig({ root: '/r', slug: 's', markers: 'kv' })), false);
});

// ---- Rückfragen ----
test('parsePrompt: Frage, Optionen (mehrzeilig, ❯), Grund und Befehl aus einem echten tmux-Bildschirm', () => {
  const r = parsePrompt(readFileSync(new URL('./testdata/prompt-proceed.txt', import.meta.url), 'utf8'));
  assert.equal(r.question, 'Do you want to proceed?');
  assert.deepEqual(r.options.map((o) => [o.key, o.selected]), [['1', true], ['2', false], ['3', false]]);
  assert.equal(r.options[1].label, 'Yes, and always allow access to /home/felixoben/IdeaProjects/ScriptPress/frontend/sdk from this project');
  assert.equal(r.context.at(-1), 'allowed working directories');
  assert.match(r.context[0], /fix-102\/node_modules\/$/);
  assert.match(r.command.at(-1), /npm run test:press/);
});

test('parsePrompt: ohne Auswahl null, nummerierte Liste mitten im Text ohne 1. null', () => {
  assert.equal(parsePrompt(''), null);
  assert.equal(parsePrompt('● Fertig.\n\n❯ \n'), null);
  assert.equal(parsePrompt(' 2. zwei\n 3. drei\n'), null);
  const simple = parsePrompt(' Weiter?\n ❯ 1. Ja\n   2. Nein\n\n Esc to cancel\n');
  assert.deepEqual([simple.question, simple.options.map((o) => o.label), simple.context, simple.command], ['Weiter?', ['Ja', 'Nein'], [], []]);
});

test('planWorkerAction press: nur erlaubte Tasten, Route an den Rechner des Workers', () => {
  assert.deepEqual(planWorkerAction({ action: 'press', name: 'fix-2', text: '2' }, WS), ['press', 'fix-2', '2']);
  assert.deepEqual(planWorkerAction({ action: 'press', name: 'fix-2', text: 'Escape' }, WS), ['press', 'fix-2', 'Escape']);
  for (const t of ['0', '22', 'y', '; rm', '', undefined]) assert.throws(() => planWorkerAction({ action: 'press', name: 'fix-2', text: t }, WS), /Taste/);
  assert.throws(() => planWorkerAction({ action: 'press', name: 'x', text: '1' }, WS), /Worker/);
  const hosts = [{ name: 'mac', ok: true }, { name: 'pc', ok: true }];
  assert.deepEqual(routeWorkerAction({ action: 'press', name: 'fix-101' }, { hosts, self: 'pc', workers: [{ name: 'fix-101', host: 'pc' }] }), ['pc']);
});

test('parseDecision: Block „Optionen:“, Hinweis „Entscheidung nötig“ mit Aufzählung, Zu tun (User)', () => {
  const block = parseDecision('Kern: ticket.io sperrt Bots.\n\nOptionen:\n1. Vorlage 5 als kaputt markieren (empfohlen)\n2. Nutzungsbedingungen klären,\n   bis dahin nichts ändern\n\nSonstiges');
  assert.deepEqual(block, { todo: false, options: [{ key: '1', label: 'Vorlage 5 als kaputt markieren (empfohlen)' }, { key: '2', label: 'Nutzungsbedingungen klären, bis dahin nichts ändern' }] });
  const hint = parseDecision('Entscheidung nötig (Kosten):\n- **Neu einreihen**, nur kommende Events\n- Oder nichts tun.\n');
  assert.deepEqual(hint.options.map((o) => o.label), ['Neu einreihen, nur kommende Events', 'Oder nichts tun.']);
  assert.deepEqual(parseDecision('Zu tun (User): Passwort im Passwortmanager ablegen. Danach schließen.'), { options: [], todo: true });
  // eine einzelne Aufzählung ohne Hinweis ist keine Entscheidung, ein Punkt allein auch nicht
  assert.equal(parseDecision('Schritte:\n1. a\n2. b'), null);
  assert.equal(parseDecision('Optionen:\n1. nur eine'), null);
  assert.equal(parseDecision(''), null);
});

test('decisionOf: Optionen aus den Notes nach der letzten User-Entscheidung, sonst Beschreibung', () => {
  const desc = 'Kandidat.\n\nOptionen:\n1. alt A\n2. alt B';
  const back = 'Place angelegt.\nUser-Entscheidung 2026-10-25: verschoben nach phase:place\nclub-add-101: Place fertig.\n\nOptionen:\n1. Zurück nach phase:settings (empfohlen)\n2. Status 2 setzen\n3. Place-Daten ändern';
  // nur in den Notes (spot-k9k.307) und Notes vor Beschreibung
  assert.deepEqual(decisionOf({ description: 'Kandidat.', notes: back }).options.map((o) => o.label),
    ['Zurück nach phase:settings (empfohlen)', 'Status 2 setzen', 'Place-Daten ändern']);
  assert.equal(decisionOf({ description: desc, notes: back }).options[0].label, 'Zurück nach phase:settings (empfohlen)');
  // ein Block vor der letzten User-Entscheidung ist erledigt: zurück auf die Beschreibung
  const done = 'Optionen:\n1. x\n2. y\nUser-Entscheidung 2026-10-25: Option 1: x';
  assert.equal(decisionOf({ description: 'nichts', notes: done }), null);
  assert.equal(decisionOf({ description: desc, notes: done }).options[0].label, 'alt A');
  assert.deepEqual(decisionOf({ description: 'Kern.', notes: 'Zu tun (User): Schlüssel anlegen' }), { options: [], todo: true });
  assert.equal(decisionOf({}), null);
});

test('collectSystems: ein Rechner ohne hosts.conf, zwei mit; ein Fehler betrifft nur diesen', async () => {
  const stats = { cpu: { percent: 12, perCore: [10, 14], cores: 2 } };
  const one = await collectSystems(null, { self: 'mac', local: async () => stats, remote: async () => { throw new Error('nie'); } });
  assert.deepEqual(one, [{ name: 'mac', leader: true, self: true, ok: true, stats }]);
  const conf = { self: 'mac', leader: 'mac', hosts: [{ name: 'mac' }, { name: 'pc' }] };
  const two = await collectSystems(conf, { local: async () => stats, remote: async () => { throw new Error('ssh: x\nConnection refused'); } });
  assert.equal(two[0].ok, true);
  assert.deepEqual(two[1], { name: 'pc', leader: false, self: false, ok: false, error: 'Connection refused' });
});

test('collectServers: mit kind und key; Fehler nur bei diesem, Namensgleiche mit Rechnern fallen weg', async () => {
  const stats = { cpu: { percent: 50, perCore: [50], cores: 1 } };
  const servers = [{ name: 'prod', ssh: 'server', services: [] }, { name: 'tot', ssh: 'x', services: [] }, { name: 'mac', ssh: 'y', services: [] }];
  const seen = [];
  const list = await collectServers(servers, {
    skip: ['mac', 'pc'],
    server: async (s) => { seen.push(s.name); if (s.name === 'tot') throw new Error('ssh: connect\nkeine Antwort'); return stats; },
  });
  assert.deepEqual(seen, ['prod', 'tot']);
  assert.deepEqual(list[0], { name: 'prod', key: 'server:server', kind: 'server', leader: false, self: false, ok: true, stats });
  assert.deepEqual(list[1], { name: 'tot', key: 'server:x', kind: 'server', leader: false, self: false, ok: false, error: 'keine Antwort' });
  assert.deepEqual(await collectServers(null, { server: async () => stats }), []);
});

test('normalizeExt: servers nur mit gültigem Namen, ssh-Ziel und Units, höchstens 4', () => {
  const warns = [];
  const ext = normalizeExt({ servers: [
    { name: 'prod', ssh: 'root@server.example.de', services: ['spot', 'mysql.service', 'runner@1'] },
    { name: 'ohne', ssh: 'h' },
    { name: 'opt', ssh: '-oProxyCommand=touch /tmp/x' },
    { name: 'unit', ssh: 'h', services: ['spot; rm -rf /'] },
    { name: 'flag', ssh: 'h', services: ['--user'] },
    { name: 'Gross', ssh: 'h' },
    { name: 'viele', ssh: 'h', services: Array(13).fill('a') },
    null,
  ] }, (m) => warns.push(m));
  assert.deepEqual(ext.servers, [
    { name: 'prod', ssh: 'root@server.example.de', services: ['spot', 'mysql.service', 'runner@1'] },
    { name: 'ohne', ssh: 'h', services: [] },
  ]);
  assert.equal(warns.length, 6);
  assert.deepEqual(normalizeExt({}).servers, []);
  const many = normalizeExt({ servers: ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name, ssh: name })) });
  assert.deepEqual(many.servers.map((x) => x.name), ['a', 'b', 'c', 'd']);
});

test('buildWorkspaces: Schnellantworten mit Vorgaben, aus beads.leitstand.mjs überschreibbar und gekürzt', () => {
  const def = buildWorkspaces(CFG, {});
  assert.deepEqual(def.code.quick, QUICK);
  const own = buildWorkspaces(CFG, { workspaces: { code: { quick: { chat: [' Los ', '', 7, 'x'.repeat(200)] } } } });
  assert.deepEqual(own.code.quick.chat, ['Los', 'x'.repeat(120)]);
  assert.deepEqual(own.code.quick.decide, QUICK.decide);
});

test('waitsOf: blocks-Abhängigkeiten mit Titel, Status und Phase, offene zuerst', () => {
  const byId = new Map([
    ['a-1', { id: 'a-1', title: 'Parser-Fix', status: 'closed', labels: ['phase:merge', 'modul:backend'] }],
    ['a-2', { id: 'a-2', title: 'Logo', status: 'in_progress', labels: ['phase:fix'] }],
    ['epic', { id: 'epic', title: 'Epic', status: 'open' }],
  ]);
  const it = { dependencies: [
    { issue_id: 'x', depends_on_id: 'epic', type: 'parent-child' },
    { issue_id: 'x', depends_on_id: 'a-1', type: 'blocks' },
    { id: 'a-2', dependency_type: 'blocks' },
    { issue_id: 'x', depends_on_id: 'a-1', type: 'blocks' },
    { issue_id: 'x', depends_on_id: 'weg-9', type: 'blocks' },
    { issue_id: 'x', depends_on_id: 'a-2', type: 'related' },
  ] };
  assert.deepEqual(waitsOf(it, byId), [
    { id: 'a-2', title: 'Logo', status: 'in_progress', phase: 'fix' },
    { id: 'weg-9', title: null, status: null, phase: null },
    { id: 'a-1', title: 'Parser-Fix', status: 'closed', phase: 'merge' },
  ]);
  assert.deepEqual(waitsOf({}, byId), []);
  assert.deepEqual(waitsOf({ dependencies: [{ depends_on_id: 'epic', type: 'parent-child' }] }, byId), []);
});

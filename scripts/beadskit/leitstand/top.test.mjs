// node --test scripts/beadskit/leitstand/top.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ago, bar, coreLine, fit, gb, lastParagraph, palette, renderOverview, spark, uptimeText } from './top.mjs';

const now = Date.parse('2026-10-25T12:00:00Z');
const worker = (name, extra = {}) => ({
  name, role: name.replace(/-\d+$/, ''), host: 'pc', status: 'busy', issues: [],
  activity: { lastAt: '2026-10-25T11:58:00Z', contextTokens: 120_000, tools: [{ name: 'Bash', summary: 'npm test' }] }, ...extra,
});
const data = {
  at: '2026-10-25T12:00:00Z',
  hosts: [{ name: 'mac', ok: false, error: 'ssh: timeout' }, { name: 'pc', ok: true, leader: true }],
  projects: [{
    name: 'Spot', colors: {}, threshold: 300_000, errors: ['mac: ssh: timeout'],
    metrics: { open: 99, working: 1, human: 3, done24h: 12 }, slot: { available: false, holder: 'verify-101' },
    workers: [
      worker('club-settings-101', { issues: [{ id: 'spot-k9k.217', title: 'Club: Vortex Surfer Musikbar' }] }),
      worker('fix-101', { status: 'idle', drained: true, activity: { lastAt: '2026-10-25T11:20:00Z', contextTokens: 400_000, pending: [{}] } }),
    ],
  }, { name: 'RegieHub', colors: {}, errors: [], metrics: null, slot: null, workers: [] }],
};

test('fit und ago', () => {
  assert.equal(fit('abcdef', 4), 'abc…');
  assert.equal(fit('ab', 4), 'ab  ');
  assert.equal(fit('ab', 4, true), '  ab');
  assert.equal(ago('2026-10-25T11:58:00Z', now), '2 min');
  assert.equal(ago('kaputt', now), '–');
});

test('renderOverview ohne Farben: Rechner, Kennzahlen, Worker mit vollem Namen, Drain, Kontext über der Schwelle', () => {
  const t = renderOverview(data, { width: 120, color: false, now });
  assert.doesNotMatch(t, /\x1b\[/);
  assert.match(t, /● mac offline\s+● pc ★/);
  assert.match(t, /Spot {2}2 Worker \(1 aktiv\) · offen 99 · in Arbeit 1 · wartet auf dich 3 · erledigt 24 h 12 · Merge-Slot verify-101/);
  assert.match(t, /! mac: ssh: timeout/);
  assert.match(t, /● club-settings-101 pc +busy +spot-k9k\.217 Club: Vortex/);
  assert.match(t, /○ fix-101 +pc +Drain +wartet auf die nächste Runde .* 40 min +400k ✉1/);
  assert.match(t, /RegieHub {2}0 Worker\n/);
  // keine Zeile breiter als das Terminal
  for (const line of t.split('\n')) assert.ok([...line].length <= 120, line);
});

test('renderOverview mit einem Rechner: keine Rechner-Spalte', () => {
  const one = { ...data, hosts: [], projects: [{ ...data.projects[0], errors: [] }] };
  const t = renderOverview(one, { width: 100, color: false, now });
  assert.doesNotMatch(t, / pc +busy/);
  assert.match(t, /● club-settings-101 busy/);
});

const GB = 2 ** 30;
const sysData = {
  ...data,
  systems: [
    { name: 'pc', leader: true, ok: true, stats: { cpu: { percent: 95, cores: 4, perCore: [5, 75, 100, null], load: [4.2, 3.1, 2] }, mem: { used: 18 * GB, total: 30 * GB },
      disk: { used: 17 * GB, total: 457 * GB }, tempC: 80, uptime: 3 * 3600, claude: 12, docker: 0 } },
    { name: 'mac', ok: false, error: 'ssh: timeout' },
  ],
  projects: [{ ...data.projects[0],
    human: [{ id: 'spot-wxt.18', title: 'Prod-Zugang fehlt', priority: 1 }],
    done: [{ id: 'spot-7iq.96', title: 'Zeitzonen', closed_at: '2026-10-25T11:02:00Z', assignee: 'verify-101' }] }],
};

test('bar, gb, uptimeText', () => {
  assert.equal(bar(38), '████░░░░░░');
  assert.equal(bar(null), '░░░░░░░░░░');
  assert.equal(gb(18.24 * GB), '18,2');
  assert.equal(gb(457 * GB), '457');
  assert.equal(uptimeText(3 * 3600), '3 h');
  assert.equal(uptimeText(5 * 86400), '5 d');
});

test('Rechnerzeilen: breit mit Temperatur, Uptime, Docker; offline mit Fehler; Listen nebeneinander', () => {
  const t = renderOverview(sysData, { width: 200, color: false, now });
  assert.match(t, /● pc ★ +CPU ██████████ +95 % +80 °C +Load 4,2 3,1 2 \/4 +RAM ██████░░░░ 18,0\/30,0 GB +SSD 17,0\/457 GB +up 3 h +claude 12 +docker 0/);
  assert.match(t, /● mac +offline: ssh: timeout/);
  assert.match(t, /Wartet auf dich \(3\) +Zuletzt erledigt/);
  assert.match(t, /P1 spot-wxt\.18 +Prod-Zugang fehlt +\d\d:02 spot-7iq\.96 +Zeitzonen .*verify-101/);
  assert.match(t, /2 Worker, 1 aktiv · Σ Kontext 520k/);
  for (const line of t.split('\n')) assert.ok([...line].length <= 200, line);
});

test('coreLine: ein Zeichen je Kern, höchster Kern, Anzahl ≥ 90 %; ohne Werte keine Zeile', () => {
  const p = palette(false);
  assert.equal(coreLine(sysData.systems[0], { p, nameW: 4 }), '       Kerne  ▁▇█·   max 100 % (#2)   1 ≥ 90 %');
  const calm = { ok: true, stats: { cpu: { perCore: [10, 20] } } };
  assert.equal(coreLine(calm, { p, nameW: 2 }), '     Kerne  ▁▂   max 20 % (#1)');
  assert.equal(coreLine({ ok: true, stats: { cpu: { percent: 5 } } }, { p, nameW: 2 }), null);
  assert.equal(coreLine(sysData.systems[1], { p, nameW: 2 }), null);
  assert.match(renderOverview(sysData, { width: 110, color: false, now }), /● pc ★ +CPU .*\n +Kerne  ▁▇█·/);
});

test('schmal (< 140): ohne Listen, Temperatur, Uptime und Docker', () => {
  const t = renderOverview(sysData, { width: 110, color: false, now });
  assert.doesNotMatch(t, /Wartet auf dich \(|°C|up 3 h|docker/);
  assert.match(t, /● pc ★ +CPU .*claude 12/);
});

const full = {
  ...sysData,
  systems: [{ ...sysData.systems[0], history: { cpu: [0, 50, 100], mem: [60] },
    stats: { ...sysData.systems[0].stats, services: [{ name: 'beads-dolt', ok: true }, { name: 'Tunnel', ok: false, state: 'failed' }] } }],
  projects: [{ ...sysData.projects[0],
    board: [{ label: 'Code', cols: [['bereit', 12], ['fix', 3], ['verify', 0]] }],
    prs: [{ number: 798, title: 'grün', ci: 'pass', createdAt: '2026-10-25T10:00:00Z', headRefName: 'fix/a' },
      { number: 799, title: 'rot', ci: 'fail', mergeable: 'CONFLICTING', createdAt: '2026-10-25T09:00:00Z', headRefName: 'fix/b' }],
    workers: [worker('fix-101', { issues: [{ id: 'spot-1', title: 'x' }],
      activity: { lastAt: '2026-10-25T11:59:00Z', contextTokens: 1000, branch: 'fix/spot-1', prs: [{ number: 798 }], lastText: 'Erst lesen.\n\nJetzt baue ich den Test.' } })],
    human: Array.from({ length: 8 }, (_, k) => ({ id: `spot-h${k}`, title: `wartet ${k}`, priority: 2 })),
  }],
};

test('spark und lastParagraph', () => {
  assert.equal(spark([0, 50, 100], 5), '  ▁▅█');
  assert.equal(spark([], 3), '   ');
  assert.equal(lastParagraph('Erst lesen.\n\nJetzt baue ich den Test.'), 'Jetzt baue ich den Test.');
  assert.equal(lastParagraph('e wasn\'t possible. I rebased it onto main without conflicts and ran the checks.'), 'I rebased it onto main without conflicts and ran the checks.');
  assert.equal(lastParagraph(''), '');
});

test('volle Höhe: Verlauf, Dienste, Board, Worker-Text, PRs (rot zuerst), 8 Einträge', () => {
  const t = renderOverview(full, { width: 200, color: false, now });
  assert.match(t, /CPU ██████████ +95 % +▁▅█/);
  assert.match(t, /Dienste {2}● beads-dolt {3}● Tunnel failed/);
  assert.match(t, /Code bereit 12 · fix 3 · verify 0/);
  assert.match(t, /↳ Jetzt baue ich den Test\. +fix\/spot-1 · #798/);
  assert.match(t, /Offene PRs \(2\)\n +✗ #799 +rot .*Konflikt .*\n +✓ #798 +grün/);
  assert.match(t, /spot-h7/);
  for (const line of t.split('\n')) assert.ok([...line].length <= 200, line);
});

test('wenig Höhe: erst kürzere Listen, dann ohne Worker-Text und PRs, nie höher als erlaubt', () => {
  const tall = renderOverview(full, { width: 200, color: false, now }).split('\n').length;
  for (const h of [tall - 3, tall - 8, 14, 5]) {
    const t = renderOverview(full, { width: 200, height: h, color: false, now });
    const n = t.split('\n').length;
    // die kleinste Stufe darf die Höhe überschreiten (Pflichtteile), alle anderen nicht
    if (!/Offene PRs|↳|Code bereit/.test(t) && n > h) continue;
    assert.ok(n <= h, `${h}: ${n} Zeilen`);
  }
  const small = renderOverview(full, { width: 200, height: 14, color: false, now });
  assert.doesNotMatch(small, /spot-h7/);
});

test('Rückfrage: Status Frage, Zeile mit Frage und Antworten, Hinweis in der Kopfzeile', () => {
  const ask = { question: 'Do you want to proceed?', options: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }], context: ['outside the allowed working directories'] };
  const d = { ...data, projects: [{ ...data.projects[0], workers: [worker('fix-102', { status: 'waiting', ask })] }] };
  const t = renderOverview(d, { width: 160, color: false, now });
  assert.match(t, /❓ 1 Rückfrage wartet auf dich/);
  assert.match(t, /fix-102 +pc +❓ Frage/);
  assert.match(t, /↳ ❓ Do you want to proceed\? +1 Yes · 2 No/);
  assert.match(t, /outside the allowed working directories/);
  // auch auf der kleinsten Stufe bleibt die Frage
  assert.match(renderOverview(d, { width: 160, height: 3, color: false, now }), /↳ ❓ Do you want to proceed/);
});

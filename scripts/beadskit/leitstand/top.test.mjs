// node --test scripts/beadskit/leitstand/top.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ago, bar, fit, gb, renderOverview, uptimeText } from './top.mjs';

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
    { name: 'pc', leader: true, ok: true, stats: { cpu: { percent: 95, cores: 16, load: [4.2, 3.1, 2] }, mem: { used: 18 * GB, total: 30 * GB },
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
  assert.match(t, /● pc ★ +CPU ██████████ +95 % +80 °C +Load 4,2 3,1 2 \/16 +RAM ██████░░░░ 18,0\/30,0 GB +SSD 17,0\/457 GB +up 3 h +claude 12 +docker 0/);
  assert.match(t, /● mac +offline: ssh: timeout/);
  assert.match(t, /Wartet auf dich \(3\) +Zuletzt erledigt/);
  assert.match(t, /P1 spot-wxt\.18 +Prod-Zugang fehlt +\d\d:02 spot-7iq\.96 +Zeitzonen .*verify-101/);
  assert.match(t, /2 Worker, 1 aktiv · Σ Kontext 520k/);
  for (const line of t.split('\n')) assert.ok([...line].length <= 200, line);
});

test('schmal (< 140): ohne Listen, Temperatur, Uptime und Docker', () => {
  const t = renderOverview(sysData, { width: 110, color: false, now });
  assert.doesNotMatch(t, /Wartet auf dich \(|°C|up 3 h|docker/);
  assert.match(t, /● pc ★ +CPU .*claude 12/);
});

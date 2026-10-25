// node --test scripts/beadskit/leitstand/top.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ago, fit, renderOverview } from './top.mjs';

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

// node --test scripts/beadskit/leitstand/usage.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  between, compactBuckets, costOf, DAY_MS, estimate, HOUR_MS, learnWeights, localUsage, maxCorrelation, mergeHosts, mergeIncoming, nnls,
  parseLimits, parseUsageLine, projection, scanUsage, slotOf, snapshotOf, summarize, timeline, windowsOf,
} from './usage.mjs';
import { modelLabel, priceOf } from './usage-prices.mjs';
import { isOurs, planInstall, shouldWrite, stableNode, statusLineEntry, statusText } from './usage-statusline.mjs';

const line = (o = {}) => JSON.stringify({
  type: 'assistant', timestamp: o.ts || '2026-11-07T10:03:00.000Z', requestId: o.req || 'req_1',
  message: {
    id: o.id || 'msg_1', model: o.model || 'claude-opus-5-5',
    usage: { input_tokens: 10, output_tokens: o.out ?? 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 300, cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 100 } },
  },
});

test('parseUsageLine: Slot auf 10 min, Cache-Schreiben getrennt nach 5 min / 1 h', () => {
  const r = parseUsageLine(line());
  assert.equal(r.slot, '2026-11-07T10:00');
  assert.equal(r.id, 'msg_1:req_1');
  assert.deepEqual(r.v, [1, 10, 100, 1000, 100, 200]);
  assert.equal(parseUsageLine('{"type":"user","message":{"usage":{}}}'), null);
  assert.equal(parseUsageLine(line({ model: '<synthetic>' })), null);
  assert.equal(parseUsageLine('{"usage" kaputt'), null);
  assert.equal(parseUsageLine('{"type":"assistant"}'), null);
});

test('slotOf rundet ab und lehnt ungültige Zeiten ab', () => {
  assert.equal(slotOf('2026-11-07T10:19:59Z'), '2026-11-07T10:10');
  assert.equal(slotOf('kaputt'), null);
});

test('Preise: Familie, unbekanntes Modell wie Sonnet, $-Gegenwert', () => {
  assert.equal(priceOf('claude-opus-5-5').out, 20);
  assert.equal(priceOf('claude-opus-4-8').out, 25);
  assert.equal(priceOf('claude-fable-5-1').family, 'Fable');
  assert.equal(priceOf('claude-neu-9').known, false);
  assert.equal(priceOf('claude-neu-9').out, priceOf('claude-sonnet-5-5').out);
  // 1 Mio. Ausgabe-Tokens Opus 5.5 = 20 $
  assert.equal(costOf('claude-opus-5-5', [1, 0, 1e6, 0, 0, 0]), 20);
  assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelLabel('claude-sonnet-5'), 'Sonnet 5');
  assert.equal(modelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
});

test('scanUsage: inkrementell, Wiederholungen einmal, angeschnittene Zeile erst wenn vollständig', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-'));
  const proj = join(dir, 'projects', '-x');
  await mkdir(join(proj, 'sess', 'subagents'), { recursive: true });
  const f = join(proj, 'a.jsonl');
  const store = join(dir, 'state', 'store.json');
  // dieselbe Antwort dreimal (je Inhaltsblock eine Zeile), dann eine halbe Zeile
  const half = line({ id: 'msg_2', ts: '2026-11-07T10:15:00Z' });
  await writeFile(f, `${line()}\n${line()}\n{"type":"user"}\n${line()}\n${half.slice(0, 40)}`);
  await writeFile(join(proj, 'sess', 'subagents', 'agent-1.jsonl'), `${line({ id: 'msg_s', model: 'claude-haiku-5-5' })}\n`);
  const now = Date.parse('2026-11-07T12:00:00Z');
  let r = await scanUsage({ dir: join(dir, 'projects'), file: store, now });
  assert.equal(r.scan.done, true);
  assert.deepEqual(r.store.buckets['2026-11-07T10:00|claude-opus-5-5'], [1, 10, 100, 1000, 100, 200]);
  assert.ok(r.store.buckets['2026-11-07T10:00|claude-haiku-5-5'], 'Subagent-Transkript zählt mit');
  // Rest der Zeile kommt nach: jetzt zählt msg_2, msg_1 nicht noch einmal
  await appendFile(f, `${half.slice(40)}\n${line()}\n`);
  r = await scanUsage({ dir: join(dir, 'projects'), file: store, now });
  assert.equal(r.store.buckets['2026-11-07T10:00|claude-opus-5-5'][0], 1);
  assert.equal(r.store.buckets['2026-11-07T10:10|claude-opus-5-5'][0], 1);
  // gespeichert und wieder geladen: dritter Lauf ändert nichts
  r = await scanUsage({ dir: join(dir, 'projects'), file: store, now });
  assert.equal(r.store.buckets['2026-11-07T10:00|claude-opus-5-5'][0], 1);
  assert.equal(JSON.parse(await readFile(store, 'utf8')).firstAt, Date.parse('2026-11-07T10:00:00Z'));
});

test('scanUsage: Zeitbudget 0 liest nichts und meldet ausstehend', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-'));
  await mkdir(join(dir, 'projects', 'p'), { recursive: true });
  await writeFile(join(dir, 'projects', 'p', 'a.jsonl'), `${line()}\n`.repeat(5000));
  const r = await scanUsage({ dir: join(dir, 'projects'), file: join(dir, 's.json'), budgetMs: 0 });
  assert.equal(r.scan.done, false);
  assert.equal(r.scan.pending, 1);
});

test('compactBuckets: alte Slots zur Stunde, Summen gleich', () => {
  const now = Date.parse('2026-11-30T00:00:00Z');
  const b = { '2026-11-01T10:10|m': [1, 1, 1, 1, 1, 1], '2026-11-01T10:50|m': [2, 2, 2, 2, 2, 2], '2026-11-29T10:10|m': [1, 0, 0, 0, 0, 0] };
  assert.deepEqual(compactBuckets(b, now), { '2026-11-01T10:00|m': [3, 3, 3, 3, 3, 3], '2026-11-29T10:10|m': [1, 0, 0, 0, 0, 0] });
});

test('mergeHosts: Buckets summiert, gleiche Snapshots beider Rechner einmal', () => {
  const s = { ts: 1000, d7: [10, 5e9] };
  const m = mergeHosts([
    { buckets: { '2026-11-07T10:00|m': [1, 0, 0, 0, 0, 0] }, limits: [s] },
    { buckets: { '2026-11-07T10:00|m': [2, 0, 0, 0, 0, 0] }, limits: [{ ...s, ts: 1500 }, { ts: 9e5, d7: [11, 5e9] }] },
  ], Date.parse('2026-11-08T00:00:00Z'));
  assert.deepEqual(m.buckets['2026-11-07T10:00|m'], [3, 0, 0, 0, 0, 0]);
  assert.equal(m.limits.length, 2);
});

test('between: anteilig im angeschnittenen Slot', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  const tl = timeline({ '2026-11-07T10:00|claude-opus-5-5': [1, 0, 1e6, 0, 0, 0] }, now); // 20 $ in 10 min
  const t0 = Date.parse('2026-11-07T10:00:00Z');
  assert.equal(between(tl, t0, t0 + 5 * 60_000).cost, 10);
  assert.equal(between(tl, t0 - HOUR_MS, t0 + HOUR_MS).cost, 20);
  assert.equal(between(tl, t0 + HOUR_MS, t0 + 2 * HOUR_MS).cost, 0);
});

// Synthetischer Verlauf: 2 $ je Stunde, Limit 400 $ je Woche → 0,5 % je Stunde
function synth({ weeks = 2, usdPerHour = 2, limit = 400, end0 = Date.parse('2026-11-02T08:00:00Z') } = {}) {
  const buckets = {};
  const limits = [];
  const start = end0 - 7 * DAY_MS;
  for (let t = start; t < start + weeks * 7 * DAY_MS; t += 10 * 60_000) {
    // Opus 5.5 Ausgabe: 20 $ / Mio. → usdPerHour/6 je Slot
    buckets[`${slotOf(t)}|claude-opus-5-5`] = [1, 0, (usdPerHour / 6 / 20) * 1e6, 0, 0, 0];
  }
  for (let t = start + HOUR_MS; t < start + weeks * 7 * DAY_MS; t += HOUR_MS) {
    const w = Math.floor((t - start) / (7 * DAY_MS));
    const ws = start + w * 7 * DAY_MS;
    limits.push({ ts: t, host: 'mac', d7: [Math.round(((t - ws) / HOUR_MS) * usdPerHour / limit * 100 * 100) / 100, (ws + 7 * DAY_MS) / 1000 * 1000] });
  }
  return { buckets, limits, start };
}

test('estimate: findet ein bekanntes Wochenlimit wieder', () => {
  const { buckets, limits, start } = synth();
  const now = start + 14 * DAY_MS - HOUR_MS;
  const tl = timeline(buckets, now);
  const e = estimate(tl, limits, 'd7', { now, coveredFrom: start });
  assert.equal(windowsOf(limits, 'd7').length, 2);
  assert.ok(Math.abs(e.usdPer100 - 400) < 4, `geschätzt ${e.usdPer100}`);
  assert.ok(e.intervals > 10);
  assert.equal(e.windows.length, 2);
  assert.equal(e.windows.at(-1).open, true);
});

test('estimate: Woche am Limit (100 %) zählt nicht in die Schätzung', () => {
  const { buckets, limits, start } = synth();
  const now = start + 14 * DAY_MS - HOUR_MS;
  // erste Woche bei 100 % gedeckelt, obwohl doppelt so viel verbraucht wurde
  const capped = limits.map((s) => (s.d7[1] === start + 7 * DAY_MS ? { ...s, d7: [Math.min(100, s.d7[0] * 2), s.d7[1]] } : s));
  const e = estimate(timeline(buckets, now), capped, 'd7', { now, coveredFrom: start });
  assert.equal(e.windows[0].capped, true);
  assert.ok(Math.abs(e.usdPer100 - 400) < 4, `geschätzt ${e.usdPer100}`);
});

test('estimate: ohne Daten vor dem Fensterbeginn keine Fensterschätzung', () => {
  const { buckets, limits, start } = synth({ weeks: 1 });
  const now = start + 6 * DAY_MS;
  const e = estimate(timeline(buckets, now), limits, 'd7', { now, coveredFrom: start + DAY_MS });
  assert.equal(e.windows.length, 0);
  assert.ok(e.usdPer100, 'Intervalle danach zählen');
});

test('windowsOf: Snapshot außerhalb seines Fensters fällt weg, Reset beginnt neues Fenster', () => {
  const end = Date.parse('2026-11-09T08:00:00Z');
  const w = windowsOf([
    { ts: end - DAY_MS, d7: [50, end] },
    { ts: end + 10, d7: [60, end] }, // nach dem Reset mit altem resets_at
    { ts: end + HOUR_MS, d7: [1, end + 7 * DAY_MS] },
  ], 'd7');
  assert.equal(w.length, 2);
  assert.deepEqual(w[0].points.map((p) => p.p), [50]);
});

test('projection: Rate der letzten 24 h, 100 % vor dem Reset', () => {
  const end = Date.parse('2026-11-09T08:00:00Z');
  const now = end - 3 * DAY_MS;
  const limits = [0, 6, 12, 18, 24].map((h) => ({ ts: now - (24 - h) * HOUR_MS, d7: [50 + h, end] }));
  const p = projection(limits, 'd7', now);
  assert.ok(Math.abs(p.rate - 1) < 1e-9);
  assert.equal(p.p, 74);
  assert.equal(p.hitAt, now + 26 * HOUR_MS);
  assert.equal(projection([], 'd7', now), null);
});

test('nnls und learnWeights: Ausgabe zählt doppelt, Cache lesen gar nicht', () => {
  assert.deepEqual(nnls([[1, 0], [0, 1], [1, 1]], [2, 3, 5]).map((x) => Math.round(x * 1000) / 1000), [2, 3]);
  assert.deepEqual(nnls([[1], [2]], [-1, -2]), [0]);
  const ivs = [];
  for (let i = 0; i < 12; i++) {
    const out = 1 + (i % 3), cr = 2 + (i % 4);
    // 1 % je 1 $ Ausgabe-Gegenwert … aber 2× gewichtet; Cache lesen zählt nicht
    ivs.push({ dp: out * 2, f: { 't:Ausgabe': out, 't:Cache lesen': cr, 'f:Opus': out + cr } });
  }
  const w = learnWeights(ivs, 100); // Mittel: 1 % je $
  assert.equal(w.type.Ausgabe, 2);
  assert.equal(w.type['Cache lesen'], 0);
  assert.equal(w.family, undefined, 'nur eine Familie: keine Gewichte je Modell');
  assert.equal(learnWeights(ivs.slice(0, 3), 100), null);
  // Cache lesen immer genau doppelt so viel wie Ausgabe: nicht trennbar
  const tied = ivs.map((iv) => ({ dp: iv.dp, f: { 't:Ausgabe': iv.f['t:Ausgabe'], 't:Cache lesen': 2 * iv.f['t:Ausgabe'] } }));
  assert.equal(learnWeights(tied, 100), null);
  assert.equal(maxCorrelation([[1, 2], [2, 4], [3, 6]]), 1);
});

test('snapshotOf: nur mit rate_limits, Prozent und resets_at in ms', () => {
  assert.equal(snapshotOf({ model: { id: 'x' } }, 'mac'), null);
  assert.equal(snapshotOf({ rate_limits: { seven_day: { used_percentage: 'x' } } }, 'mac'), null);
  const s = snapshotOf({ model: { id: 'claude-opus-5-5' }, rate_limits: { five_hour: { used_percentage: 23.456, resets_at: 1738425600 }, seven_day: { used_percentage: 41.2, resets_at: 1738857600 } } }, 'mac', 5);
  assert.deepEqual(s, { ts: 5, host: 'mac', model: 'claude-opus-5-5', h5: [23.46, 1738425600000], d7: [41.2, 1738857600000] });
  assert.deepEqual(parseLimits(`${JSON.stringify(s)}\n{"kaputt\n{"ts":1}\n`), [s]);
  assert.deepEqual(parseLimits(JSON.stringify(s), 6), []);
});

test('mergeIncoming: ab since ersetzt, davor bleibt; since 0 ersetzt alles', () => {
  const prev = { firstAt: 100, buckets: { '2026-11-07T08:00|m': [1, 0, 0, 0, 0, 0], '2026-11-07T10:00|m': [1, 0, 0, 0, 0, 0] }, limits: [{ ts: 1 }, { ts: Date.parse('2026-11-07T10:30:00Z') }] };
  const since = Date.parse('2026-11-07T09:30:00Z');
  const inc = { at: 2, since, scan: { done: true }, firstAt: 200, buckets: { '2026-11-07T10:00|m': [5, 0, 0, 0, 0, 0] }, limits: [{ ts: since + 1 }] };
  const m = mergeIncoming(prev, inc, Date.parse('2026-11-08T00:00:00Z'));
  assert.deepEqual(m.buckets, { '2026-11-07T08:00|m': [1, 0, 0, 0, 0, 0], '2026-11-07T10:00|m': [5, 0, 0, 0, 0, 0] });
  assert.deepEqual(m.limits.map((s) => s.ts), [1, since + 1]);
  assert.equal(m.firstAt, 100);
  assert.equal(m.ok, true);
  assert.deepEqual(mergeIncoming(prev, { ...inc, since: 0 }).buckets, inc.buckets);
  assert.equal(mergeIncoming({ buckets: {}, limits: [] }, { ...inc, firstAt: null }).firstAt, null);
});

test('summarize: Tabelle je Modell und Rechner, Tage, Schätzung erst nach dem Erstscan', () => {
  const { buckets, limits, start } = synth();
  const now = start + 14 * DAY_MS - HOUR_MS;
  const half = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.map((x) => x / 2)]));
  const hosts = [
    { name: 'mac', ok: true, scan: { done: true }, firstAt: start, buckets: half, limits },
    { name: 'pc', ok: true, scan: { done: true }, firstAt: start, buckets: half, limits: [] },
  ];
  const s = summarize(hosts, { now, rangeDays: 7 });
  assert.equal(s.models.length, 1);
  assert.equal(s.models[0].label, 'Opus 5.5');
  assert.ok(Math.abs(s.models[0].hosts.mac.cost - s.models[0].hosts.pc.cost) < 1e-6);
  assert.equal(s.days.length, 7);
  assert.ok(Math.abs(s.estimate.week.usdPer100 - 400) < 4);
  assert.ok(s.projection.d7.p > 0);
  assert.ok(s.series.points.length > 0);
  assert.equal(s.hosts[0].buckets, undefined, 'Rohdaten gehen nicht an die Seite');
  const scanning = summarize([{ ...hosts[0], scan: { done: false } }, hosts[1]], { now });
  assert.equal(scanning.estimate.week.usdPer100, null);
  assert.equal(scanning.estimate.scanning, true);
  const empty = summarize([], { now });
  assert.equal(empty.total.cost, 0);
  assert.equal(empty.projection.d7, null);
});

test('localUsage: liest Store, Snapshots und ob die Statuszeile eingetragen ist', async () => {
  const home = await mkdtemp(join(tmpdir(), 'usage-home-'));
  await mkdir(join(home, '.claude', 'projects', 'p'), { recursive: true });
  await writeFile(join(home, '.claude', 'projects', 'p', 'a.jsonl'), `${line()}\n`);
  await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ statusLine: statusLineEntry('/usr/bin/node', '/x/usage-statusline.mjs') }));
  const dir = join(home, '.local', 'state', 'beadskit', 'usage');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'limits.jsonl'), `${JSON.stringify({ ts: 5, d7: [1, 2] })}\n`);
  const old = process.env.BEADSKIT_USAGE_DIR;
  const oldC = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.BEADSKIT_USAGE_DIR; delete process.env.CLAUDE_CONFIG_DIR;
  try {
    const u = await localUsage({ home, now: Date.parse('2026-11-07T12:00:00Z') });
    assert.equal(u.statusline, true);
    assert.equal(Object.keys(u.buckets).length, 1);
    assert.equal(u.limits.length, 1);
    const later = await localUsage({ home, since: Date.parse('2026-11-07T11:00:00Z'), now: Date.parse('2026-11-07T12:00:00Z') });
    assert.equal(Object.keys(later.buckets).length, 0);
  } finally {
    if (old !== undefined) process.env.BEADSKIT_USAGE_DIR = old;
    if (oldC !== undefined) process.env.CLAUDE_CONFIG_DIR = oldC;
  }
});

test('Statuszeile: Text, Drosselung, Eintrag in settings.json', () => {
  const now = Date.parse('2026-11-07T12:00:00');
  const st = { model: { id: 'claude-opus-5-5' }, context_window: { used_percentage: 12.4 }, rate_limits: { five_hour: { used_percentage: 23.5 }, seven_day: { used_percentage: 41.2, resets_at: Date.parse('2026-11-09T09:00:00') / 1000 } } };
  assert.equal(statusText(st, now), 'Opus 5.5 · Kontext 12 % · 5h 24 % · Woche 41 % (Mo 09:00)');
  assert.equal(statusText(null), '');
  const a = { ts: 0, h5: [1, 2], d7: [3, 4] };
  assert.equal(shouldWrite(null, a), true);
  assert.equal(shouldWrite(a, { ...a, ts: 60_000 }), false);
  assert.equal(shouldWrite(a, { ...a, ts: 60_000, d7: [3.5, 4] }), true);
  assert.equal(shouldWrite(a, { ...a, ts: 60_000, d7: [3.2, 4] }), false, 'kleine Schritte gedrosselt');
  assert.equal(shouldWrite(a, { ...a, ts: 60_000, d7: [3, 5] }), true, 'neues Fenster');
  assert.equal(shouldWrite(a, { ts: 60_000, d7: [3, 4] }), true, '5-h-Fenster weggefallen');
  assert.equal(shouldWrite(a, { ...a, ts: 10 * 60_000 }), true);
  assert.equal(stableNode('/opt/homebrew/Cellar/node/24.9.0/bin/node', (p) => p === '/opt/homebrew/bin/node'), '/opt/homebrew/bin/node');
  assert.equal(stableNode('/usr/bin/node', () => false), '/usr/bin/node');
  const e = statusLineEntry('/opt/node bin/node', '/x/usage-statusline.mjs');
  assert.equal(e.command, "'/opt/node bin/node' /x/usage-statusline.mjs");
  assert.equal(isOurs(e), true);
  assert.equal(planInstall({}, e).change, 'add');
  assert.equal(planInstall({ statusLine: e, x: 1 }, e).change, 'same');
  assert.equal(planInstall({ statusLine: { type: 'command', command: 'mine.sh' } }, e).change, 'foreign');
  const forced = planInstall({ statusLine: { command: 'mine.sh' }, x: 1 }, e, true);
  assert.equal(forced.change, 'update');
  assert.deepEqual(forced.settings, { statusLine: e, x: 1 });
});

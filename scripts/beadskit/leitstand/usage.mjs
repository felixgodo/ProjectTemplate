// Token-Verbrauch je Rechner und Modell und Schätzung des Wochenlimits (Tab „Tokens“).
//
// Zählen: Jede Claude-Antwort steht mit message.model und message.usage in den Transkripten unter
// ~/.claude/projects (auch Subagenten). scanUsage liest sie inkrementell (Byte-Offset je Datei) und
// summiert je 10-Minuten-Slot und Modell; die Summen liegen in ~/.local/state/beadskit/usage/
// store.json und bleiben, wenn Claude Code alte Transkripte löscht (cleanupPeriodDays). Ältere
// Slots als FINE_DAYS werden zu Stunden zusammengefasst. Eine Antwort steht mehrmals hintereinander
// im Transkript (je Inhaltsblock eine Zeile, gleiche usage): gezählt wird sie einmal (message.id +
// requestId, die letzten IDS_KEPT je Datei).
//
// Limit: Claude Code nennt das Limit nicht in Tokens, nur in Prozent (rate_limits der Statuszeile,
// usage-statusline.mjs schreibt sie nach limits.jsonl). estimate setzt die Prozente ins Verhältnis
// zum Verbrauch aller Rechner im selben Fenster, gemessen im $-Gegenwert (usage-prices.mjs):
// „100 % der Woche ≈ X $“. Je mehr Wochen und Snapshots, desto belastbarer; eine Regression über
// die Intervalle lernt dazu, wie stark die Modelle bzw. Token-Arten ins Limit zählen.
//
// Nur lesend gegenüber Claude Code. Teil des beadskit aus dem ProjectTemplate – nicht im Projekt ändern.
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { modelLabel, priceOf } from './usage-prices.mjs';

export const SLOT_MS = 10 * 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const FINE_DAYS = 21;
const IDS_KEPT = 16; // Wiederholungen stehen höchstens ein paar Zeilen auseinander
const CHUNK = 4 * 1024 * 1024;
const MAX_LINE = 64 * 1024 * 1024;
const LOCK_STALE_MS = 120_000;
// Felder je Bucket: Requests, Eingabe, Ausgabe, Cache lesen, Cache schreiben 5 min / 1 h
export const N = 0, IN = 1, OUT = 2, CR = 3, C5 = 4, C1 = 5;
const WINDOWS = { d7: 7 * DAY_MS, h5: 5 * HOUR_MS };

export const stateDir = (home = homedir()) => process.env.BEADSKIT_USAGE_DIR || join(home, '.local', 'state', 'beadskit', 'usage');
export const projectsDir = (home = homedir()) => join(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects');

const pad = (n) => String(n).padStart(2, '0');
/** Slot-Schlüssel (UTC) „YYYY-MM-DDTHH:MM“, auf 10 Minuten abgerundet; null bei ungültiger Zeit. */
export function slotOf(ts) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return null;
  const d = new Date(Math.floor(t / SLOT_MS) * SLOT_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
/** Beginn eines Slots in ms und seine Länge (Stunden-Slots enden auf :00 und kommen aus compact). */
export function slotRange(slot, hourly = false) {
  return [Date.parse(`${slot}:00Z`), hourly ? HOUR_MS : SLOT_MS];
}

/**
 * Eine Transkriptzeile → { id, slot, model, v } für eine Antwort mit usage, sonst null.
 * Synthetische Antworten (model "<synthetic>", Fehlermeldungen ohne API-Aufruf) zählen nicht.
 */
export function parseUsageLine(line) {
  if (!line.includes('"usage"')) return null;
  let d;
  try { d = JSON.parse(line); } catch { return null; }
  const m = d?.message;
  const u = m?.usage;
  if (d.type !== 'assistant' || !u || typeof m.model !== 'string' || m.model.startsWith('<')) return null;
  const slot = slotOf(d.timestamp);
  if (!slot) return null;
  const num = (x) => (Number.isFinite(x) && x > 0 ? x : 0);
  const cw = num(u.cache_creation_input_tokens);
  const c1 = Math.min(cw, num(u.cache_creation?.ephemeral_1h_input_tokens));
  return {
    id: m.id ? `${m.id}:${d.requestId ?? ''}` : null,
    slot,
    model: m.model,
    v: [1, num(u.input_tokens), num(u.output_tokens), num(u.cache_read_input_tokens), cw - c1, c1],
  };
}

const add = (a, b) => { for (let i = 0; i < b.length; i++) a[i] = (a[i] || 0) + b[i]; return a; };
const bucketKey = (slot, model) => `${slot}|${model}`;
export const splitKey = (k) => { const i = k.indexOf('|'); return [k.slice(0, i), k.slice(i + 1)]; };

export function emptyStore() {
  return { v: 1, files: {}, buckets: {}, firstAt: null, scannedAt: null };
}
export async function loadStore(file) {
  try {
    const s = JSON.parse(await readFile(file, 'utf8'));
    if (s?.v === 1 && s.files && s.buckets) return s;
  } catch { /* neu */ }
  return emptyStore();
}
async function saveJson(file, data) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file);
}

/**
 * Fasst Slots, die älter als fineDays sind, zur Stunde zusammen (Schlüssel endet dann auf :00 und
 * steht in hourly). Summen bleiben gleich.
 */
export function compactBuckets(buckets, now = Date.now(), fineDays = FINE_DAYS) {
  const limit = now - fineDays * DAY_MS;
  const out = {};
  for (const [k, v] of Object.entries(buckets)) {
    const [slot, model] = splitKey(k);
    const t = Date.parse(`${slot}:00Z`);
    const s = t < limit ? `${slot.slice(0, 14)}00` : slot;
    out[bucketKey(s, model)] = add(out[bucketKey(s, model)] || [], v);
  }
  return out;
}

async function listTranscripts(dir) {
  const out = [];
  async function walk(d, depth) {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory() && depth < 4) await walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try { const s = await stat(p); out.push({ path: p, size: s.size, mtime: s.mtimeMs }); } catch { /* weg */ }
      }
    }
  }
  await walk(dir, 0);
  return out.sort((a, b) => b.mtime - a.mtime);
}

// Liest eine Datei ab f.o bis zur letzten vollständigen Zeile; hält bei Zeitablauf an
async function readNew(file, f, size, onLine, deadline) {
  const fh = await open(file, 'r');
  try {
    let chunk = CHUNK;
    while (f.o < size && Date.now() < deadline) {
      const len = Math.min(chunk, size - f.o);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, f.o);
      const nl = buf.lastIndexOf(10, bytesRead - 1);
      if (nl < 0) {
        // unvollständige letzte Zeile (Claude schreibt gerade) oder eine sehr lange Zeile
        if (f.o + bytesRead >= size || chunk >= MAX_LINE) {
          if (chunk >= MAX_LINE) f.o += bytesRead;
          break;
        }
        chunk *= 2;
        continue;
      }
      for (const line of buf.toString('utf8', 0, nl).split('\n')) onLine(line);
      f.o += nl + 1;
      chunk = CHUNK;
    }
  } finally {
    await fh.close();
  }
}

/**
 * Liest neue Zeilen aller Transkripte in den Store (inkrementell, höchstens budgetMs) und speichert
 * ihn. Läuft schon ein Scan (Lock), wird nur der gespeicherte Stand gelesen.
 * → { store, scan: { done, files, pending, bytes, bytesDone, busy? } }
 */
export async function scanUsage({ dir = projectsDir(), file = join(stateDir(), 'store.json'), budgetMs = 8_000, now = Date.now() } = {}) {
  const lock = `${file}.lock`;
  await mkdir(dirname(file), { recursive: true });
  let fh;
  try {
    fh = await open(lock, 'wx');
  } catch {
    try {
      if (Date.now() - (await stat(lock)).mtimeMs > LOCK_STALE_MS) await rm(lock, { force: true });
    } catch { /* weg */ }
    const store = await loadStore(file);
    return { store, scan: { ...(store.scan || {}), busy: true } };
  }
  try {
    const store = await loadStore(file);
    const deadline = Date.now() + budgetMs;
    const list = await listTranscripts(dir);
    const seen = new Set();
    for (const t of list) {
      seen.add(t.path);
      const f = store.files[t.path] || (store.files[t.path] = { o: 0, ids: [] });
      if (t.size < f.o) { f.o = 0; f.ids = []; } // neu geschrieben: von vorn
      if (t.size === f.o || Date.now() >= deadline) continue;
      const ids = new Set(f.ids);
      await readNew(t.path, f, t.size, (line) => {
        const r = parseUsageLine(line);
        if (!r) return;
        if (r.id) {
          if (ids.has(r.id)) return;
          ids.add(r.id);
          f.ids.push(r.id);
          if (f.ids.length > IDS_KEPT) ids.delete(f.ids.shift());
        }
        const k = bucketKey(r.slot, r.model);
        store.buckets[k] = add(store.buckets[k] || [0, 0, 0, 0, 0, 0], r.v);
        const at = Date.parse(`${r.slot}:00Z`);
        if (!store.firstAt || at < store.firstAt) store.firstAt = at;
      }, deadline);
    }
    for (const p of Object.keys(store.files)) if (!seen.has(p)) delete store.files[p];
    let bytes = 0, bytesDone = 0, pending = 0;
    for (const t of list) {
      const o = Math.min(store.files[t.path]?.o || 0, t.size);
      bytes += t.size; bytesDone += o;
      // offene letzte Zeile zählt nicht als ausstehend
      if (t.size - o > 64 * 1024) pending++;
    }
    store.buckets = compactBuckets(store.buckets, now);
    store.scannedAt = now;
    store.scan = { done: pending === 0, files: list.length, pending, bytes, bytesDone };
    await saveJson(file, store);
    return { store, scan: store.scan };
  } finally {
    await fh.close();
    await rm(lock, { force: true });
  }
}

// ---- Limit-Snapshots (limits.jsonl, eine Zeile je Messung aus usage-statusline.mjs) ----

const pctOk = (p) => Number.isFinite(p) && p >= 0 && p <= 1000;
/**
 * stdin-JSON der Statuszeile → Snapshot { ts, host, model, h5: [pct, resetsMs]?, d7: [...]? };
 * null ohne rate_limits.
 */
export function snapshotOf(status, host, now = Date.now()) {
  const rl = status?.rate_limits;
  if (!rl || typeof rl !== 'object') return null;
  const win = (w) => (w && pctOk(w.used_percentage) && Number.isFinite(w.resets_at)
    ? [Math.round(w.used_percentage * 100) / 100, w.resets_at * 1000] : null);
  const h5 = win(rl.five_hour);
  const d7 = win(rl.seven_day);
  if (!h5 && !d7) return null;
  return { ts: now, host, model: typeof status.model?.id === 'string' ? status.model.id : null, ...(h5 ? { h5 } : {}), ...(d7 ? { d7 } : {}) };
}

export function parseLimits(text, since = 0) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line) continue;
    try {
      const s = JSON.parse(line);
      if (Number.isFinite(s?.ts) && s.ts >= since && (Array.isArray(s.h5) || Array.isArray(s.d7))) out.push(s);
    } catch { /* abgeschnitten */ }
  }
  return out;
}
export async function readLimits(file = join(stateDir(), 'limits.jsonl'), since = 0) {
  try { return parseLimits(await readFile(file, 'utf8'), since); } catch { return []; }
}

// ---- Zusammenführen und Auswerten ----

/**
 * Mehrere Rechner → ein Verlauf. hosts: [{ name, buckets, limits }]. Buckets je Schlüssel summiert
 * (beide Rechner haben eigene Transkripte), Snapshots nach Zeit sortiert, gleiche Messungen
 * (beide Rechner sehen dasselbe Konto) nur einmal.
 */
export function mergeHosts(hosts, now = Date.now()) {
  const buckets = {};
  const limits = [];
  for (const h of hosts) {
    for (const [k, v] of Object.entries(compactBuckets(h.buckets || {}, now))) buckets[k] = add(buckets[k] || [], v);
    limits.push(...(h.limits || []));
  }
  limits.sort((a, b) => a.ts - b.ts);
  const out = [];
  for (const s of limits) {
    const prev = out.at(-1);
    if (prev && s.ts - prev.ts < 30_000 && JSON.stringify([prev.h5, prev.d7]) === JSON.stringify([s.h5, s.d7])) continue;
    out.push(s);
  }
  return { buckets, limits: out };
}

/** $-Gegenwert eines Buckets */
export function costOf(model, v) {
  const p = priceOf(model);
  return ((v[IN] || 0) * p.in + (v[OUT] || 0) * p.out + (v[CR] || 0) * p.cacheRead
    + (v[C5] || 0) * p.cacheWrite5m + (v[C1] || 0) * p.cacheWrite1h) / 1e6;
}
/** Kostenanteile für die Regression: je Familie und je Token-Art */
function features(model, v) {
  const p = priceOf(model);
  const c = costOf(model, v);
  return {
    [`f:${p.family}`]: c,
    't:Ausgabe': (v[OUT] || 0) * p.out / 1e6,
    't:Cache lesen': (v[CR] || 0) * p.cacheRead / 1e6,
    't:Eingabe+Cache schreiben': ((v[IN] || 0) * p.in + (v[C5] || 0) * p.cacheWrite5m + (v[C1] || 0) * p.cacheWrite1h) / 1e6,
  };
}

/**
 * Zeitreihe aus den Buckets: sortierte Slots [{ t, d, cost, f }] (t Beginn, d Länge, f Anteile).
 * Ein Slot gilt als Stunde, wenn sein Schlüssel auf :00 endet und älter als FINE_DAYS ist.
 */
export function timeline(buckets, now = Date.now()) {
  const fine = now - FINE_DAYS * DAY_MS; // dieselbe Grenze wie compactBuckets
  const map = new Map();
  for (const [k, v] of Object.entries(buckets)) {
    const [slot, model] = splitKey(k);
    const [t] = slotRange(slot);
    if (!Number.isFinite(t)) continue;
    const d = t < fine && slot.endsWith(':00') ? HOUR_MS : SLOT_MS;
    const e = map.get(t) || { t, d, cost: 0, f: {} };
    e.d = Math.max(e.d, d);
    e.cost += costOf(model, v);
    for (const [fk, fv] of Object.entries(features(model, v))) e.f[fk] = (e.f[fk] || 0) + fv;
    map.set(t, e);
  }
  const list = [...map.values()].sort((a, b) => a.t - b.t);
  // Präfixsummen für schnelle Abfragen zwischen zwei Zeitpunkten
  let acc = 0;
  const accF = {};
  for (const e of list) {
    e.acc0 = acc; e.accF0 = { ...accF };
    acc += e.cost;
    for (const [k, v] of Object.entries(e.f)) accF[k] = (accF[k] || 0) + v;
  }
  return list;
}

// Kumulierter Verbrauch bis Zeitpunkt t (anteilig im angeschnittenen Slot) → { cost, f }
function cumAt(tl, t) {
  let lo = 0, hi = tl.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (tl[m].t <= t) lo = m + 1; else hi = m; }
  if (lo === 0) return { cost: 0, f: {} };
  const e = tl[lo - 1];
  const frac = Math.max(0, Math.min(1, (t - e.t) / e.d));
  const f = { ...e.accF0 };
  for (const [k, v] of Object.entries(e.f)) f[k] = (f[k] || 0) + v * frac;
  return { cost: e.acc0 + e.cost * frac, f };
}
/** Verbrauch zwischen a und b → { cost, f } */
export function between(tl, a, b) {
  const x = cumAt(tl, a), y = cumAt(tl, b);
  const f = {};
  for (const k of new Set([...Object.keys(x.f), ...Object.keys(y.f)])) f[k] = Math.max(0, (y.f[k] || 0) - (x.f[k] || 0));
  return { cost: Math.max(0, y.cost - x.cost), f };
}

const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};

/** Nicht-negative kleinste Quadrate (Koordinatenabstieg, wenige Merkmale): min |Ax − b|, x ≥ 0 */
export function nnls(A, b, iters = 2000) {
  const n = A[0]?.length || 0;
  const x = new Array(n).fill(0);
  const norm = Array.from({ length: n }, (_, j) => A.reduce((s, r) => s + r[j] * r[j], 0));
  const r = [...b];
  for (let it = 0; it < iters; it++) {
    let moved = 0;
    for (let j = 0; j < n; j++) {
      if (!norm[j]) continue;
      const g = A.reduce((s, row, i) => s + row[j] * r[i], 0);
      const nx = Math.max(0, x[j] + g / norm[j]);
      const dx = nx - x[j];
      if (dx) {
        for (let i = 0; i < A.length; i++) r[i] -= A[i][j] * dx;
        x[j] = nx;
        moved = Math.max(moved, Math.abs(dx) / (Math.abs(nx) || 1));
      }
    }
    if (moved < 1e-9) break;
  }
  return x;
}

/**
 * Snapshots eines Fenstertyps (d7 oder h5) nach Fenster gruppiert (gleiches resets_at, auf 10 min
 * gerundet) → [{ start, end, points: [{ ts, p }] }], älteste zuerst.
 */
export function windowsOf(limits, kind) {
  const len = WINDOWS[kind];
  const map = new Map();
  for (const s of limits) {
    const w = s[kind];
    if (!Array.isArray(w) || !pctOk(w[0]) || !Number.isFinite(w[1])) continue;
    const end = Math.round(w[1] / SLOT_MS) * SLOT_MS;
    if (s.ts > end || s.ts < end - len) continue; // Messung gehört nicht in dieses Fenster
    const e = map.get(end) || { start: end - len, end, points: [] };
    e.points.push({ ts: s.ts, p: w[0] });
    map.set(end, e);
  }
  return [...map.values()].sort((a, b) => a.end - b.end);
}

/**
 * Schätzung „100 % ≈ X $-Gegenwert“ für einen Fenstertyp.
 *  - je Fenster kumulativ: Verbrauch seit Fensterbeginn / letzter Prozentwert (ab minPct)
 *  - je Intervall zwischen Snapshots (Δ% ≥ minStep, ≥ 30 min): Δ$ / Δ% → Streuung, Regression
 * coveredFrom: ab wann Verbrauchsdaten vollständig sind (frühester Scan aller Rechner).
 */
export function estimate(tl, limits, kind, { now = Date.now(), coveredFrom = 0, minPct = 5, minStep = 2 } = {}) {
  const wins = windowsOf(limits, kind);
  const perWindow = [];
  const intervals = [];
  for (const w of wins) {
    const pts = w.points;
    const last = pts.at(-1);
    if (w.start >= coveredFrom && last.p >= minPct) {
      // bei 100 % gedeckelt: Verbrauch danach sagt nichts mehr über das Limit, zählt nicht
      const capped = last.p >= 99.5;
      const c = between(tl, w.start, last.ts).cost;
      if (c > 0) perWindow.push({ start: w.start, end: w.end, p: last.p, cost: c, est: (c / last.p) * 100, open: w.end > now, capped });
    }
    let a = pts[0];
    for (const b of pts.slice(1)) {
      const dp = b.p - a.p;
      if (dp < 0 || b.p >= 99.5) { a = b; continue; } // gesunken (Korrektur) oder am Limit
      if (dp >= minStep && b.ts - a.ts >= 30 * 60_000) {
        if (a.ts >= coveredFrom) {
          const d = between(tl, a.ts, b.ts);
          if (d.cost > 0) intervals.push({ a: a.ts, b: b.ts, dp, cost: d.cost, f: d.f, est: (d.cost / dp) * 100 });
        }
        a = b;
      }
    }
  }
  const ests = intervals.map((x) => x.est);
  // Hauptwert: Median der Fenster (kumulativ ist robuster), sonst der Intervalle
  const usable = perWindow.filter((x) => !x.capped);
  const base = usable.length ? usable.map((x) => x.est) : ests;
  const usdPer100 = quantile(base, 0.5);
  const out = {
    usdPer100,
    low: quantile(ests.length >= 4 ? ests : base, 0.25),
    high: quantile(ests.length >= 4 ? ests : base, 0.75),
    windows: perWindow.slice(-8),
    intervals: intervals.length,
    weights: null,
  };
  out.weights = learnWeights(intervals, usdPer100);
  return out;
}

/** Größter Betrag der Korrelation zweier Spalten */
export function maxCorrelation(A) {
  const n = A.length, m = A[0]?.length || 0;
  const col = (j) => A.map((r) => r[j]);
  let max = 0;
  for (let a = 0; a < m; a++) {
    for (let b = a + 1; b < m; b++) {
      const x = col(a), y = col(b);
      const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
      const r = sxx && syy ? Math.abs(sxy / Math.sqrt(sxx * syy)) : 1;
      max = Math.max(max, r);
    }
  }
  return max;
}

/**
 * Regression Δ% = Σ w_k · Δ$_k über die Intervalle, getrennt für Familien (f:) und Token-Arten (t:).
 * Ein Merkmal braucht ≥ 5 % Anteil am Verbrauch der Intervalle; gezeigt wird das Gewicht relativ zu
 * „1 $ = 1 $“ (1,0 = zählt wie der Listenpreis, 2,0 = doppelt). null bei zu wenig Daten.
 */
export function learnWeights(intervals, usdPer100, minIntervals = 8) {
  if (intervals.length < minIntervals || !usdPer100) return null;
  const out = {};
  for (const prefix of ['f:', 't:']) {
    const total = {};
    for (const iv of intervals) for (const [k, v] of Object.entries(iv.f)) if (k.startsWith(prefix)) total[k] = (total[k] || 0) + v;
    const sum = Object.values(total).reduce((s, v) => s + v, 0);
    const keys = Object.keys(total).filter((k) => total[k] >= 0.05 * sum).sort();
    if (keys.length < 2) continue;
    const A = intervals.map((iv) => keys.map((k) => iv.f[k] || 0));
    // Merkmale, die immer im selben Verhältnis anfallen, lassen sich nicht trennen: dann keine Gewichte
    if (maxCorrelation(A) > 0.9) continue;
    const b = intervals.map((iv) => iv.dp);
    const x = nnls(A, b);
    const ref = 100 / usdPer100; // % je $ im Mittel
    out[prefix === 'f:' ? 'family' : 'type'] = Object.fromEntries(keys.map((k, j) => [k.slice(2), Math.round((x[j] / ref) * 100) / 100]));
  }
  return Object.keys(out).length ? out : null;
}

/** Rate der letzten 24 h im laufenden Fenster (% je Stunde) und wann 100 % erreicht wären */
export function projection(limits, kind, now = Date.now()) {
  const w = windowsOf(limits, kind).filter((x) => x.end > now).at(-1);
  if (!w) return null;
  const pts = w.points.filter((x) => x.ts >= now - DAY_MS);
  const last = w.points.at(-1);
  if (pts.length < 2 || pts.at(-1).ts - pts[0].ts < HOUR_MS) return { p: last.p, resetsAt: w.end, start: w.start, rate: null, hitAt: null };
  const mt = pts.reduce((s, x) => s + x.ts, 0) / pts.length;
  const mp = pts.reduce((s, x) => s + x.p, 0) / pts.length;
  const num = pts.reduce((s, x) => s + (x.ts - mt) * (x.p - mp), 0);
  const den = pts.reduce((s, x) => s + (x.ts - mt) ** 2, 0);
  const perMs = den ? Math.max(0, num / den) : 0;
  const hitAt = perMs > 0 && last.p < 100 ? last.ts + (100 - last.p) / perMs : null;
  return { p: last.p, resetsAt: w.end, start: w.start, rate: perMs * HOUR_MS, hitAt: hitAt && hitAt < w.end ? hitAt : null };
}

const localDay = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const tok = (v) => (v[IN] || 0) + (v[OUT] || 0) + (v[CR] || 0) + (v[C5] || 0) + (v[C1] || 0);

/**
 * Antwort für den Tab „Tokens“. hosts: [{ name, ok, error?, at, scan, statusline, buckets, limits, firstAt }].
 * rangeDays begrenzt Tagesbalken und Tabelle; Schätzungen nutzen alle Daten.
 */
export function summarize(hosts, { now = Date.now(), rangeDays = 30 } = {}) {
  const usable = hosts.filter((h) => h.buckets);
  const { buckets, limits } = mergeHosts(usable, now);
  const tl = timeline(buckets, now);
  const from = now - rangeDays * DAY_MS;
  // Schätzen erst, wenn alle Rechner fertig gelesen haben; Daten ab dem spätesten Erstbeleg
  const scanning = usable.some((h) => h.scan && h.scan.done === false);
  const coveredFrom = scanning ? Infinity : Math.max(0, ...usable.map((h) => h.firstAt).filter(Number.isFinite));

  // Tabelle Modell × Rechner und Tagesbalken je Modell
  const models = new Map();
  const days = new Map();
  const unknown = new Set();
  for (const h of usable) {
    for (const [k, v] of Object.entries(h.buckets)) {
      const [slot, model] = splitKey(k);
      const t = Date.parse(`${slot}:00Z`);
      if (!(t >= from)) continue;
      if (!priceOf(model).known) unknown.add(model);
      const c = costOf(model, v);
      const m = models.get(model) || { model, label: modelLabel(model), family: priceOf(model).family, v: [0, 0, 0, 0, 0, 0], cost: 0, hosts: {} };
      add(m.v, v); m.cost += c;
      const mh = m.hosts[h.name] || (m.hosts[h.name] = { v: [0, 0, 0, 0, 0, 0], cost: 0 });
      add(mh.v, v); mh.cost += c;
      models.set(model, m);
      const day = localDay(t);
      const d = days.get(day) || { day, cost: 0, tokens: 0, models: {} };
      d.cost += c; d.tokens += tok(v);
      const dm = d.models[model] || (d.models[model] = { cost: 0, tokens: 0, out: 0 });
      dm.cost += c; dm.tokens += tok(v); dm.out += v[OUT] || 0;
      days.set(day, d);
    }
  }
  const total = [...models.values()].reduce((s, m) => s + m.cost, 0);
  const modelList = [...models.values()].sort((a, b) => b.cost - a.cost).map((m) => ({
    ...m, tokens: tok(m.v), share: total ? m.cost / total : 0,
  }));
  const dayList = [];
  for (let t = now - (rangeDays - 1) * DAY_MS; t <= now + 1; t += DAY_MS) {
    const day = localDay(t);
    dayList.push(days.get(day) || { day, cost: 0, tokens: 0, models: {} });
  }

  // Limits und Schätzung
  const latest = limits.at(-1) || null;
  const week = estimate(tl, limits, 'd7', { now, coveredFrom });
  const five = estimate(tl, limits, 'h5', { now, coveredFrom, minPct: 10, minStep: 3 });
  const proj = { d7: projection(limits, 'd7', now), h5: projection(limits, 'h5', now) };
  // Verlauf des laufenden Wochenfensters: Prozent gegen kumulierten Verbrauch
  let series = null;
  if (proj.d7) {
    const w = windowsOf(limits, 'd7').filter((x) => x.end > now).at(-1);
    series = { start: w.start, end: w.end, points: w.points.map((x) => ({ ts: x.ts, p: x.p, cost: between(tl, w.start, x.ts).cost })) };
    if (series.points.length > 400) {
      const step = Math.ceil(series.points.length / 400);
      series.points = series.points.filter((_, i) => i % step === 0 || i === series.points.length - 1);
    }
    series.costNow = between(tl, w.start, now).cost;
  }
  // Was 100 % in Tokens bedeuten: beim Mix der letzten 7 Tage
  const mix = between(tl, now - 7 * DAY_MS, now).cost;
  let mixTokens = 0;
  for (const [k, v] of Object.entries(buckets)) if (Date.parse(`${splitKey(k)[0]}:00Z`) >= now - 7 * DAY_MS) mixTokens += tok(v);
  const perToken = mixTokens ? mix / mixTokens : null;
  let outPerUsd = null;
  {
    let o = 0, c = 0;
    for (const [k, v] of Object.entries(buckets)) {
      if (Date.parse(`${splitKey(k)[0]}:00Z`) < now - 7 * DAY_MS) continue;
      o += v[OUT] || 0; c += costOf(splitKey(k)[1], v);
    }
    outPerUsd = c ? o / c : null;
  }

  return {
    at: new Date(now).toISOString(),
    rangeDays,
    hosts: hosts.map(({ name, ok, error, at, scan, statusline, firstAt, stale }) => ({ name, ok, error, at, scan, statusline, firstAt, stale })),
    total: { cost: total, tokens: modelList.reduce((s, m) => s + m.tokens, 0), requests: modelList.reduce((s, m) => s + m.v[N], 0) },
    today: days.get(localDay(now)) || null,
    models: modelList,
    days: dayList,
    unknown: [...unknown],
    limits: {
      latest: latest && { ts: latest.ts, host: latest.host, h5: latest.h5 || null, d7: latest.d7 || null },
      snapshots: limits.length,
      first: limits[0]?.ts || null,
    },
    estimate: {
      week: { ...week, tokens: week.usdPer100 && perToken ? week.usdPer100 / perToken : null, outTokens: week.usdPer100 && outPerUsd ? week.usdPer100 * outPerUsd : null },
      five: { ...five, tokens: five.usdPer100 && perToken ? five.usdPer100 / perToken : null },
      coveredFrom: Number.isFinite(coveredFrom) ? coveredFrom : null,
      scanning,
    },
    projection: proj,
    series,
  };
}

/**
 * Stand dieses Rechners für den Leitstand (host-agent.mjs usage): liest neue Transkriptzeilen und
 * liefert Buckets und Snapshots ab since (ms; 0 = alles) plus Scan-Stand und ob die Statuszeile
 * eingetragen ist.
 */
export async function localUsage({ since = 0, budgetMs = 8_000, home = homedir(), now = Date.now() } = {}) {
  const dir = stateDir(home);
  const { store, scan } = await scanUsage({ dir: projectsDir(home), file: join(dir, 'store.json'), budgetMs, now });
  const buckets = {};
  const sinceSlot = since ? slotOf(Math.floor(since / HOUR_MS) * HOUR_MS) : '';
  for (const [k, v] of Object.entries(store.buckets)) if (!since || k >= sinceSlot) buckets[k] = v;
  let statusline = false;
  try {
    const s = JSON.parse(await readFile(join(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json'), 'utf8'));
    statusline = typeof s?.statusLine?.command === 'string' && s.statusLine.command.includes('usage-statusline.mjs');
  } catch { /* keine settings */ }
  return { at: now, since, scan, statusline, firstAt: store.firstAt, buckets, limits: await readLimits(join(dir, 'limits.jsonl'), since) };
}

const earliest = (...xs) => { const v = xs.filter(Number.isFinite); return v.length ? Math.min(...v) : null; };

/**
 * Leitrechner: frische Antwort eines Rechners (localUsage ab since) in den gespeicherten Stand
 * übernehmen. Slots ab since und Snapshots ab since ersetzen die alten; since 0 ersetzt alles.
 */
export function mergeIncoming(prev, inc, now = Date.now()) {
  if (!prev || !inc.since) return { ...inc, ok: true, error: null, stale: false };
  const sinceSlot = slotOf(Math.floor(inc.since / HOUR_MS) * HOUR_MS);
  const buckets = {};
  for (const [k, v] of Object.entries(prev.buckets || {})) if (k < sinceSlot) buckets[k] = v;
  Object.assign(buckets, inc.buckets);
  const limits = [...(prev.limits || []).filter((s) => s.ts < inc.since), ...inc.limits];
  return { ...inc, ok: true, error: null, stale: false, buckets: compactBuckets(buckets, now), limits,
    firstAt: earliest(prev.firstAt, inc.firstAt) };
}

// Listenpreise der Claude-Modelle in $ je Million Tokens (Stand 2026-10, Anthropic-API). Der
// Leitstand rechnet damit Tokens verschiedener Modelle und Arten (Eingabe, Ausgabe, Cache) in eine
// gemeinsame Einheit um, den „$-Gegenwert“. Das ist keine Rechnung (Abo), sondern das Maß, gegen das
// usage.mjs das Wochenlimit schätzt. Neue Modelle hier eintragen; ein unbekanntes Modell zählt wie
// Sonnet und wird im Tab markiert.
// Teil des beadskit aus dem ProjectTemplate – nicht im Projekt ändern.

// in, out, Cache lesen, Cache schreiben 5 min, Cache schreiben 1 h; erste passende Zeile gilt
const TABLE = [
  [/fable|mythos/, 'Fable', [10, 50, 0.25, 12.5, 20]],
  [/opus-5-5/, 'Opus', [4, 20, 0.2, 5, 8]],
  [/opus-(5|4-[5-9])/, 'Opus', [5, 25, 0.5, 6.25, 10]],
  [/opus/, 'Opus', [15, 75, 1.5, 18.75, 30]],
  [/sonnet-5/, 'Sonnet', [2, 10, 0.2, 2.5, 4]],
  [/sonnet/, 'Sonnet', [3, 15, 0.3, 3.75, 6]],
  [/haiku-5/, 'Haiku', [0.1, 0.5, 0.01, 0.125, 0.2]],
  [/haiku/, 'Haiku', [1, 5, 0.1, 1.25, 2]],
];
const FALLBACK = TABLE[4];

/** Preise und Familie eines Modells; known=false, wenn es nicht in der Tabelle steht. */
export function priceOf(model) {
  const m = String(model || '');
  const row = TABLE.find(([re]) => re.test(m));
  const [, family, p] = row || FALLBACK;
  return { family, known: !!row, in: p[0], out: p[1], cacheRead: p[2], cacheWrite5m: p[3], cacheWrite1h: p[4] };
}

/** Lesbarer Name: claude-opus-5-5 → Opus 5.5 */
export function modelLabel(model) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(String(model || ''));
  if (!m) return String(model || '?');
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

#!/usr/bin/env node
// Statuszeile für Claude Code, die nebenbei die Limit-Prozente mitschreibt (Tab „Tokens“ im
// Leitstand). Claude Code ruft sie bei jeder Antwort mit dem Sitzungs-JSON auf stdin auf; nur dort
// stehen rate_limits.five_hour/seven_day (used_percentage, resets_at). Änderungen ab 0,5 Punkten,
// sonst höchstens alle 10 Minuten, landen als Zeile in ~/.local/state/beadskit/usage/limits.jsonl.
// Ausgabe: eine kurze Zeile, z. B. „Opus 5.5 · Kontext 12 % · 5h 23 % · Woche 41 % (Mo 09:00)“.
//
//   usage-statusline.mjs                    als statusLine-Befehl (liest stdin)
//   usage-statusline.mjs install            zeigt, was in ~/.claude/settings.json eingetragen würde
//   usage-statusline.mjs install --apply    trägt es ein (Sicherung settings.json.bak-beadskit);
//                                           eine fremde statusLine bleibt, außer mit --force
//   usage-statusline.mjs check              true/false: ist diese Statuszeile eingetragen?
//
// Teil des beadskit aus dem ProjectTemplate – nicht im Projekt ändern.
import { existsSync } from 'node:fs';
import { appendFile, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotOf, stateDir } from './usage.mjs';
import { modelLabel } from './usage-prices.mjs';

const SELF = fileURLToPath(import.meta.url);
const THROTTLE_MS = 10 * 60_000;
const settingsFile = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');

/**
 * Soll eine neue Zeile geschrieben werden? Nach THROTTLE_MS, bei neuem Fenster (resets_at) oder ab
 * MIN_STEP Prozentpunkten Änderung; sonst schriebe jede Antwort jeder Session eine Zeile.
 */
const MIN_STEP = 0.5;
export function shouldWrite(prev, snap) {
  if (!prev) return true;
  if (snap.ts - prev.ts >= THROTTLE_MS) return true;
  return ['h5', 'd7'].some((k) => {
    const a = prev[k], b = snap[k];
    if (!a || !b) return !!a !== !!b;
    return a[1] !== b[1] || Math.abs(a[0] - b[0]) >= MIN_STEP;
  });
}

const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const two = (n) => String(n).padStart(2, '0');
/** Text der Statuszeile */
export function statusText(status, now = Date.now()) {
  const parts = [];
  if (status?.model?.id || status?.model?.display_name) parts.push(status.model.id ? modelLabel(status.model.id) : status.model.display_name);
  const ctx = status?.context_window?.used_percentage;
  if (Number.isFinite(ctx)) parts.push(`Kontext ${Math.round(ctx)} %`);
  const rl = status?.rate_limits || {};
  if (Number.isFinite(rl.five_hour?.used_percentage)) parts.push(`5h ${Math.round(rl.five_hour.used_percentage)} %`);
  if (Number.isFinite(rl.seven_day?.used_percentage)) {
    const r = Number.isFinite(rl.seven_day.resets_at) ? new Date(rl.seven_day.resets_at * 1000) : null;
    const when = r && r.getTime() > now ? ` (${WD[r.getDay()]} ${two(r.getHours())}:${two(r.getMinutes())})` : '';
    parts.push(`Woche ${Math.round(rl.seven_day.used_percentage)} %${when}`);
  }
  return parts.join(' · ');
}

/**
 * node für den Eintrag: ein fester Pfad statt des versionierten (Homebrew legt node unter
 * Cellar/<version>/ ab, der Pfad verschwindet beim nächsten Update).
 */
export function stableNode(execPath = process.execPath, exists = existsSync) {
  if (!/\/Cellar\/|\/\.nvm\/versions\//.test(execPath)) return execPath;
  return ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'].find((p) => exists(p)) || execPath;
}

/** Eintrag für settings.json */
export function statusLineEntry(node = stableNode(), script = SELF) {
  const q = (s) => (/^[\w./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
  return { type: 'command', command: `${q(node)} ${q(script)}`, refreshInterval: 300 };
}
export const isOurs = (sl) => typeof sl?.command === 'string' && sl.command.includes('usage-statusline.mjs');

/** Neue settings → { settings, change: 'add'|'update'|'same'|'foreign' } */
export function planInstall(settings, entry, force = false) {
  const cur = settings?.statusLine;
  if (cur && !isOurs(cur) && !force) return { settings, change: 'foreign' };
  if (cur && JSON.stringify(cur) === JSON.stringify(entry)) return { settings, change: 'same' };
  return { settings: { ...settings, statusLine: entry }, change: cur ? 'update' : 'add' };
}

async function readSettings() {
  try { return JSON.parse(await readFile(settingsFile(), 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`${settingsFile()} nicht lesbar: ${e.message}`);
  }
}

async function install(args) {
  const settings = await readSettings();
  const entry = statusLineEntry();
  const plan = planInstall(settings, entry, args.includes('--force'));
  const file = settingsFile();
  if (plan.change === 'foreign') {
    console.log(`${file}: schon eine andere statusLine eingetragen:\n  ${JSON.stringify(settings.statusLine)}\nÜberschreiben mit --apply --force.`);
    process.exitCode = 1;
    return;
  }
  if (plan.change === 'same') { console.log(`${file}: Statuszeile ist schon eingetragen.`); return; }
  console.log(`${file}: statusLine ${plan.change === 'add' ? 'neu' : 'ersetzen'}:\n  ${JSON.stringify(entry)}`);
  if (!args.includes('--apply')) { console.log('Nur angezeigt; eintragen mit --apply.'); return; }
  await mkdir(dirname(file), { recursive: true });
  try { await copyFile(file, `${file}.bak-beadskit`); } catch { /* keine Datei */ }
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(plan.settings, null, 2)}\n`);
  await rename(tmp, file);
  console.log('Eingetragen. Gilt für neu gestartete Claude-Sessions.');
}

async function statusline() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let status = null;
  try { status = JSON.parse(input); } catch { /* leer */ }
  process.stdout.write(`${statusText(status)}\n`);
  const snap = snapshotOf(status, hostname().split('.')[0]);
  if (!snap) return;
  const dir = stateDir();
  const last = join(dir, 'limits.last.json');
  let prev = null;
  try { prev = JSON.parse(await readFile(last, 'utf8')); } catch { /* erste Messung */ }
  if (!shouldWrite(prev, snap)) return;
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, 'limits.jsonl'), `${JSON.stringify(snap)}\n`);
  const tmp = `${last}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(snap));
  await rename(tmp, last);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [what, ...args] = process.argv.slice(2);
  try {
    if (what === 'install') await install(args);
    else if (what === 'check') console.log(isOurs((await readSettings()).statusLine));
    else await statusline();
  } catch (e) {
    // Die Statuszeile darf Claude Code nie stören: Fehler nur auf stderr
    console.error(e.message);
    if (what) process.exitCode = 1;
  }
}

#!/usr/bin/env node
// Live-Übersicht im Terminal: oben je Rechner (hosts.conf) CPU und RAM mit Verlauf, Temperatur,
// Load, Platte, Uptime, laufende claude-Prozesse, Docker-Container und Dienste (beads-dolt,
// Leitstand, Tunnel, Sicherung); darunter alle Projekte aus ~/.config/beadskit/projects.txt mit
// Board-Spalten, ihren Workern (Rechner, Status, Issue, letzte Aktion, was sie gerade sagen,
// Ruhezeit, Kontext), offenen PRs mit CI, was auf dich wartet und was zuletzt erledigt wurde.
// Füllt die Höhe des Terminals; was nicht passt, fällt in fester Reihenfolge weg. Liest nur
// (wie der Leitstand, aber ohne Browser und Login); läuft auf Mac und PC.
//
//   node scripts/beadskit/leitstand/top.mjs [slug…] [--once] [--interval 5]
//   scripts/beadskit/workers top …            dasselbe
//
// Tasten: q beenden, r sofort aktualisieren. --once gibt die Übersicht einmal aus (ohne Farben,
// wenn die Ausgabe kein Terminal ist).
// Teil des beadskit aus dem ProjectTemplate – nicht im Projekt ändern.
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  buildWorkspaces, CONF_DIR, groupIssues, isBoardIssue, localWorkers, mapRoot, mergeHostWorkers, normalizeConfig,
  normalizeExt, parseHostsConf, parseMarkers, parseProjectList, parsePrompt, prSummary, remoteCommand,
} from './inbox.mjs';
import { systemStats } from './sysinfo.mjs';

const run = promisify(execFile);
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=10',
  '-o', 'ControlMaster=auto', '-o', 'ControlPersist=10m', '-o', `ControlPath=${join(homedir(), '.ssh', 'bk-%C')}`];

// ---------------------------------------------------------------- Darstellung (rein, getestet)

const ESC = '\x1b[';
/** Farben; ohne Terminal alles leer. */
export function palette(color) {
  const c = (code) => (s) => (color ? `${ESC}${code}m${s}${ESC}0m` : s);
  return {
    color,
    bold: c('1'), dim: c('2'), red: c('31'), green: c('32'), yellow: c('33'), cyan: c('36'), inv: c('7'),
    rgb: (rgb, s) => (color && Array.isArray(rgb) && rgb.length === 3 ? `${ESC}38;2;${rgb.join(';')}m${s}${ESC}0m` : s),
  };
}

/** Auf n Zeichen kürzen (…) bzw. mit Leerzeichen auffüllen. */
export function fit(s, n, right = false) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (n <= 0) return '';
  const cut = [...t].length > n ? `${[...t].slice(0, Math.max(0, n - 1)).join('')}…` : t;
  const pad = ' '.repeat(Math.max(0, n - [...cut].length));
  return right ? pad + cut : cut + pad;
}

/** „3 min“, „2 h“, „–“ seit einem Zeitpunkt. */
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '–';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

const ktok = (n) => (Number.isFinite(n) ? `${Math.round(n / 1000)}k` : '–');

/** Balken aus n Zeichen für 0–100 %. */
export function bar(pct, n = 10) {
  const f = Number.isFinite(pct) ? Math.max(0, Math.min(n, Math.round((pct / 100) * n))) : 0;
  return `${'█'.repeat(f)}${'░'.repeat(n - f)}`;
}

/** Bytes als GB: eine Nachkommastelle unter 100 GB. */
export function gb(bytes) {
  if (!Number.isFinite(bytes)) return '–';
  const g = bytes / 2 ** 30;
  return g < 100 ? g.toFixed(1).replace('.', ',') : String(Math.round(g));
}

/** Laufzeit in Sekunden als „45 min“, „3 h“, „5 d“. */
export function uptimeText(sec) {
  if (!Number.isFinite(sec)) return '–';
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  if (sec < 172_800) return `${Math.round(sec / 3600)} h`;
  return `${Math.round(sec / 86400)} d`;
}

/** Verlauf 0–100 als Sparkline aus n Zeichen (rechtsbündig, neueste rechts). */
export function spark(values, n = 20) {
  const chars = '▁▂▃▄▅▆▇█';
  const v = (values || []).filter(Number.isFinite).slice(-n);
  return `${' '.repeat(n - v.length)}${v.map((x) => chars[Math.min(7, Math.max(0, Math.floor((x / 100) * 8)))]).join('')}`;
}

/** Dienste eines Rechners in einer Zeile: grün läuft, rot nicht; Sicherung mit Zeitpunkt. */
export function serviceLine(sys, { p, nameW }) {
  const list = sys.ok ? sys.stats?.services || [] : [];
  if (!list.length) return null;
  const items = list.map((x) => `${x.ok ? p.green('●') : p.red('●')} ${x.name}${x.at ? p.dim(` ${clock(x.at)}`) : ''}${x.ok ? '' : p.red(` ${x.state}`)}`);
  return `   ${' '.repeat(nameW)}${p.dim('Dienste')}  ${items.join('   ')}`;
}

/** Eine Zeile je Rechner; ab 140 Spalten mit Temperatur, Uptime, Docker und Verlauf. */
export function systemLine(sys, { p, wide, nameW }) {
  const name = `${sys.name}${sys.leader ? ' ★' : ''}`;
  if (!sys.ok) return ` ${p.red('●')} ${p.bold(fit(name, nameW))} ${p.red(`offline: ${sys.error || 'keine Antwort'}`)}`;
  const s = sys.stats || {};
  const level = (v, warn, bad) => (v >= bad ? p.red : v >= warn ? p.yellow : p.green);
  const cpu = s.cpu?.percent;
  const memPct = s.mem ? (s.mem.used / s.mem.total) * 100 : null;
  const diskPct = s.disk ? (s.disk.used / s.disk.total) * 100 : null;
  const parts = [
    `${p.dim('CPU')} ${level(cpu, 70, 90)(bar(cpu))} ${fit(Number.isFinite(cpu) ? `${cpu} %` : '–', 5, true)}${wide && sys.history ? ` ${p.cyan(spark(sys.history.cpu))}` : ''}`,
    wide && Number.isFinite(s.tempC) ? level(s.tempC, 75, 85)(`${s.tempC} °C`) : null,
    s.cpu?.load ? `${p.dim('Load')} ${s.cpu.load.map((x) => String(x).replace('.', ',')).join(' ')} ${p.dim(`/${s.cpu.cores}`)}` : null,
    s.mem ? `${p.dim('RAM')} ${level(memPct, 75, 90)(bar(memPct))} ${gb(s.mem.used)}/${gb(s.mem.total)} GB${wide && sys.history ? ` ${p.cyan(spark(sys.history.mem, 12))}` : ''}` : null,
    s.disk ? `${p.dim('SSD')} ${level(diskPct, 80, 95)(`${gb(s.disk.used)}/${gb(s.disk.total)} GB`)}` : null,
    wide ? `${p.dim('up')} ${uptimeText(s.uptime)}` : null,
    `${p.dim('claude')} ${s.claude ?? '–'}`,
    wide ? `${p.dim('docker')} ${s.docker ?? '–'}` : null,
  ].filter(Boolean);
  return ` ${p.green('●')} ${p.bold(fit(name, nameW))} ${parts.join('   ')}`;
}

/** Sichtbare Länge ohne Farbcodes. */
const plainLen = (t) => [...t.replace(/\x1b\[[0-9;]*m/g, '')].length;

const clock = (iso) => (Number.isFinite(Date.parse(iso))
  ? new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '–');

const CI = { pass: '✓', fail: '✗', pending: '…', none: '·' };

/**
 * Baut die Übersicht als Text. data = { at, hosts: [{name, ok, leader, error}], systems: [{ name,
 * leader, ok, error, stats, history: {cpu, mem} }] (sysinfo.mjs), projects: [{ name, slug, colors,
 * metrics, slot, board: [{ label, cols: [[titel, anzahl]] }], prs: [prSummary + repo],
 * workers: [{ name, role, host, status, drained, issues, activity }], human, done, threshold, errors }] }.
 *
 * Pflicht sind Kopf, Rechner, Projekte und Worker; danach, solange `height` reicht: Board-Zeile,
 * PRs, was jeder aktive Worker sagt, „Wartet auf dich“/„Zuletzt erledigt“ (bis 8 Einträge).
 * Unter 140 Spalten ohne Verlauf, Listen und Nebenwerte.
 */
export function renderOverview(data, { width = 120, height = Infinity, color = true, now = Date.now(), multi = data.hosts.length > 1 } = {}) {
  const levels = [
    { board: true, prs: 5, texts: true, list: 8 }, { board: true, prs: 5, texts: true, list: 5 },
    { board: true, prs: 3, texts: true, list: 3 }, { board: true, prs: 3, texts: false, list: 3 },
    { board: true, prs: 0, texts: false, list: 3 }, { board: false, prs: 0, texts: false, list: 0 },
  ];
  let lines = [];
  for (const lv of levels) {
    lines = build(data, { width, color, now, multi, ...lv });
    if (lines.length <= height) break;
  }
  return lines.join('\n');
}

function build(data, { width, color, now, multi, board, prs: prMax, texts, list: listMax }) {
  const p = palette(color);
  const w = Math.max(60, width);
  const wide = w >= 140;
  const out = [];
  const rule = p.dim('─'.repeat(w));
  const systems = data.systems || [];
  const hosts = multi && !systems.length ? `  ${data.hosts.map((h) => (h.ok
    ? `${p.green('●')} ${h.name}${h.leader ? ' ★' : ''}`
    : `${p.red('●')} ${h.name} ${p.red('offline')}`)).join('   ')}` : '';
  const total = data.projects.flatMap((x) => x.workers);
  const summary = total.length
    ? `${total.length} Worker, ${total.filter((x) => x.status !== 'idle').length} aktiv · Σ Kontext ${ktok(total.reduce((n, x) => n + (x.activity?.contextTokens || 0), 0))}`
    : 'keine Worker';
  const asks = total.filter((x) => x.ask).length;
  const askNote = asks ? `   ${p.yellow(p.bold(`❓ ${asks} ${asks === 1 ? 'Rückfrage wartet' : 'Rückfragen warten'} auf dich`))}` : '';
  out.push(`${p.bold(' beads · Übersicht')}${hosts}   ${p.dim(summary)}${askNote}   ${p.dim(new Date(data.at).toLocaleTimeString('de-DE'))}`);
  out.push(rule);
  if (systems.length) {
    const sysNameW = Math.max(...systems.map((x) => x.name.length + (x.leader ? 2 : 0)));
    for (const sys of systems) {
      out.push(systemLine(sys, { p, wide, nameW: sysNameW }));
      const svc = wide ? serviceLine(sys, { p, nameW: sysNameW }) : null;
      if (svc) out.push(svc);
    }
    out.push(rule);
  }
  // Spalten: Punkt, Name, Rechner, Status, Issue (flexibel), Aktion (flexibel), still, Kontext;
  // Name und Issue-ID so breit wie der längste Eintrag
  const nameW = Math.min(22, Math.max(10, ...total.map((x) => x.name.length)));
  const idW = Math.min(18, Math.max(6, ...total.flatMap((x) => (x.issues || []).map((i) => i.id.length)),
    ...data.projects.flatMap((x) => [...(x.human || []), ...(x.done || [])].map((i) => i.id.length)))) + 1;
  const fixed = 2 + nameW + 1 + (multi ? 5 : 0) + 8 + 7 + 6 + 6;
  const flex = Math.max(20, w - fixed);
  const issueW = Math.floor(flex * 0.55);
  const actW = flex - issueW;
  for (const pr of data.projects) {
    const m = pr.metrics;
    // [Text, Rang]: passt die Zeile nicht, fallen die mit dem höchsten Rang zuerst weg
    let facts = [
      [`${pr.workers.length} Worker${pr.workers.length ? ` (${pr.workers.filter((x) => x.status !== 'idle').length} aktiv)` : ''}`, 0],
      m ? [p.dim(`offen ${m.open}`), 4] : null,
      m ? [p.dim(`in Arbeit ${m.working}`), 2] : null,
      m && m.human ? [p.yellow(`wartet auf dich ${m.human}`), 0] : m ? [p.dim('wartet auf dich 0'), 3] : null,
      m ? [p.dim(`erledigt 24 h ${m.done24h}`), 5] : null,
      pr.slot ? [pr.slot.available ? p.dim('Merge-Slot frei') : p.cyan(`Merge-Slot ${pr.slot.holder}`), 1] : null,
      pr.workers.length ? [p.dim(`Σ ${ktok(pr.workers.reduce((n, x) => n + (x.activity?.contextTokens || 0), 0))}`), 6] : null,
    ].filter(Boolean);
    const head = () => `${p.bold(` ${pr.name}`)}  ${facts.map((f) => f[0]).join(p.dim(' · '))}`;
    while (plainLen(head()) > w && facts.length > 1) {
      const worst = Math.max(...facts.map((f) => f[1]));
      facts = facts.filter((f) => f[1] !== worst);
    }
    out.push(head());
    // Board: Spalten je Workspace mit Inhalt
    if (board && pr.board?.length) {
      const parts = pr.board.map((b) => `${p.dim(b.label)} ${b.cols.map(([t, n]) => (n ? `${t} ${p.bold(String(n))}` : p.dim(`${t} 0`))).join(p.dim(' · '))}`);
      out.push(`   ${fitAnsi(parts.join('     '), w - 3)}`);
    }
    for (const e of pr.errors || []) out.push(`   ${p.red(`! ${e}`)}`);
    for (const wk of pr.workers) {
      const a = wk.activity || {};
      const busy = wk.status !== 'idle';
      const rgb = pr.colors?.[wk.role];
      const issue = wk.issues?.[0];
      const tool = a.tools?.[0];
      const quiet = ago(a.lastAt, now);
      const quietMs = now - Date.parse(a.lastAt);
      const over = pr.threshold ? a.contextTokens > pr.threshold : a.contextTokens > 300_000;
      const cells = [
        busy ? p.rgb(rgb, '●') : p.dim('○'),
        p.rgb(rgb, fit(wk.name, nameW)),
        multi ? p.dim(fit(wk.host, 4)) : null,
        wk.ask ? p.yellow(p.bold(fit('❓ Frage', 7))) : wk.drained ? p.yellow(fit('Drain', 7)) : busy ? fit(wk.status, 7) : p.dim(fit('idle', 7)),
        issue ? `${p.cyan(fit(issue.id, idW))}${fit(issue.title, issueW - idW - 1)}` : p.dim(fit(busy ? '' : 'wartet auf die nächste Runde', issueW - 1)),
        tool ? `${p.dim(fit(tool.name, 10))} ${fit(tool.summary, actW - 12)}` : p.dim(fit('–', actW - 1)),
        busy && quietMs > 30 * 60_000 ? p.red(fit(quiet, 6, true)) : busy && quietMs > 10 * 60_000 ? p.yellow(fit(quiet, 6, true)) : p.dim(fit(quiet, 6, true)),
        over ? p.red(fit(ktok(a.contextTokens), 5, true)) : fit(ktok(a.contextTokens), 5, true),
        a.pending?.length ? p.yellow(`✉${a.pending.length}`) : null,
      ].filter((c) => c !== null);
      out.push(`   ${cells.join(' ')}`);
      // Rückfrage: immer anzeigen (blockiert den Worker), mit den Antworten
      if (wk.ask) {
        const opts = (wk.ask.options || []).map((o) => `${p.bold(o.key)} ${o.label}`).join(p.dim(' · '));
        const q = `↳ ❓ ${wk.ask.question || 'wartet auf eine Eingabe'}  `;
        out.push(`${' '.repeat(5 + nameW)}${p.yellow(q)}${fitAnsi(opts || p.dim('Antwort im Leitstand oder im Terminal'), w - 5 - nameW - plainLen(q))}`);
        if (texts && wk.ask.context?.length) out.push(`${' '.repeat(7 + nameW)}${p.dim(fit(wk.ask.context.join(' '), w - 7 - nameW))}`);
      } else if (texts && busy && (a.lastText || a.branch)) {
        // was der Worker zuletzt gesagt hat, rechts Branch und PR
        const prNo = a.prs?.at(-1)?.number;
        const right = [a.branch ? branchShort(a.branch) : null, prNo ? `#${prNo}` : null].filter(Boolean).join(' · ');
        const indent = 5 + nameW;
        const room = w - indent - (right ? plainLen(right) + 3 : 0);
        out.push(`${' '.repeat(indent)}${p.dim(`↳ ${fit(lastParagraph(a.lastText), room - 2)}`)}${right ? `  ${p.dim(right)}` : ''}`);
      }
    }
    // offene PRs, rote CI zuerst
    if (prMax && pr.prs?.length) {
      const order = { fail: 0, pending: 1, none: 2, pass: 3 };
      const list = [...pr.prs].sort((x, y) => (order[x.ci] ?? 9) - (order[y.ci] ?? 9) || String(y.createdAt).localeCompare(String(x.createdAt)));
      out.push(`   ${p.dim(`Offene PRs (${list.length})`)}`);
      for (const x of list.slice(0, prMax)) {
        const mark = x.ci === 'fail' ? p.red(CI.fail) : x.ci === 'pending' ? p.yellow(CI.pending) : x.ci === 'pass' ? p.green(CI.pass) : p.dim(CI.none);
        const tail = [x.mergeable === 'CONFLICTING' ? p.red('Konflikt') : null, x.isDraft ? p.dim('Entwurf') : null,
          p.dim(fit(x.headRefName || '', 26)), p.dim(fit(ago(x.createdAt, now), 6, true))].filter(Boolean).join('  ');
        const num = `#${x.number}${x.repo && x.repo !== '.' ? `@${x.repo}` : ''}`;
        out.push(`   ${mark} ${p.cyan(fit(num, 9))}${fit(x.title, w - 16 - plainLen(tail))}  ${tail}`);
      }
    }
    // ab 140 Spalten: zwei Listen nebeneinander, links was auf dich wartet, rechts was fertig wurde
    if (wide && listMax && (pr.human?.length || pr.done?.length)) {
      const half = Math.floor((w - 6) / 2);
      const left = [p.yellow(`Wartet auf dich (${m?.human ?? pr.human.length})`),
        ...(pr.human || []).slice(0, listMax).map((i) => `${p.dim(`P${i.priority ?? '?'}`)} ${p.cyan(fit(i.id, idW))}${fit(i.title, half - idW - 4)}`)];
      const right = [p.dim('Zuletzt erledigt'),
        ...(pr.done || []).slice(0, listMax).map((i) => `${p.dim(clock(i.closed_at))} ${p.cyan(fit(i.id, idW))}${fit(i.title, half - idW - 20)} ${p.dim(fit(i.assignee || '', 12))}`)];
      for (let k = 0; k < Math.max(left.length, right.length); k++) {
        const l = left[k] ?? '';
        out.push(`   ${l}${' '.repeat(Math.max(1, half - plainLen(l)))} ${right[k] ?? ''}`);
      }
    }
    out.push('');
  }
  if (!data.projects.length) out.push(p.dim(' keine Projekte (projects.txt) bzw. keine passenden'));
  out.push(p.dim(' q beenden · r sofort aktualisieren · Projekte mit Workern zuerst'));
  return out;
}

/**
 * Letzter Absatz einer Textausgabe; ist der Text vorne abgeschnitten (Transkript-Ende), beginnt er
 * am ersten Satzanfang statt mitten im Wort.
 */
export function lastParagraph(text) {
  const paras = String(text || '').split(/\n\s*\n|\n(?=[-*#] )/).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  let t = paras.at(-1) || '';
  if (paras.length === 1 && /^[a-zäöü]/.test(t)) {
    const k = t.search(/[.!?:] +[A-ZÄÖÜ„"*]/);
    if (k > 0 && k < t.length - 20) t = t.slice(k + 1).trim();
  }
  return t;
}

/** fix/spot-7iq.103 bleibt, detached HEAD und lange Namen werden kurz. */
const branchShort = (b) => (b === 'HEAD' ? 'detached' : fit(b, 28).trim());

/** Kürzt eine farbige Zeile auf n sichtbare Zeichen (schneidet zwischen den Farbcodes). */
function fitAnsi(t, n) {
  if (plainLen(t) <= n) return t;
  let vis = 0;
  let out = '';
  for (const part of t.split(/(\x1b\[[0-9;]*m)/)) {
    if (/^\x1b\[/.test(part)) { out += part; continue; }
    for (const ch of part) {
      if (vis >= n - 1) return `${out}…\x1b[0m`;
      out += ch;
      vis += 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------- Daten

async function json(cmd, args, opts = {}) {
  try {
    const { stdout } = await run(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: 20_000, ...opts });
    return JSON.parse(stdout || 'null');
  } catch {
    return null;
  }
}

const cfgCache = new Map();
async function projectConfig(root) {
  const hit = cfgCache.get(root);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const cfg = normalizeConfig(await json(join(root, 'scripts/beadskit/workers'), ['config'], { cwd: root }));
  const value = cfg ? { cfg, workspaces: buildWorkspaces(cfg, normalizeExt({})) } : null;
  cfgCache.set(root, { at: Date.now(), value });
  return value;
}

async function hostWorkers(root, workspaces, conf) {
  if (!conf) return [{ host: 'local', self: true, leader: true, ...(await local()) }];
  async function local() {
    const workers = await localWorkers(root, workspaces);
    return { ok: !!workers, error: workers ? null : 'claude agents', workers };
  }
  const self = conf.hosts.find((h) => h.name === conf.self);
  return Promise.all(conf.hosts.map(async (h) => {
    const base = { host: h.name, self: h.name === conf.self, leader: h.name === conf.leader };
    if (base.self) return { ...base, ...(await local()) };
    const there = mapRoot(root, self?.root, h.root);
    if (!there) return { ...base, ok: false, error: 'Ordner dort unbekannt (hosts.conf)' };
    try {
      const { stdout } = await run('ssh', [...SSH_OPTS, h.ssh, remoteCommand(there, 'scripts/beadskit/leitstand/host-agent.mjs', ['workers'])],
        { timeout: 15_000, maxBuffer: 64 * 1024 * 1024 });
      return { ...base, ok: true, workers: JSON.parse(stdout) };
    } catch (e) {
      return { ...base, ok: false, error: String(e.stderr || e.message).trim().split('\n').at(-1) };
    }
  }));
}

// Teure Abfragen (alle Issues fürs Board, gh für die PRs) nur alle 30 s je Projekt
const SLOW_MS = 30_000;
const slowCache = new Map();
async function slowData(root, cfg, workspaces, bd) {
  const hit = slowCache.get(root);
  if (hit && Date.now() - hit.at < SLOW_MS) return hit.value;
  const [issues, prLists] = await Promise.all([
    bd(['list', '--all', '-n', '0']),
    Promise.all(cfg.repos.map(async (r) => {
      const list = await json('gh', ['pr', 'list', '--state', 'open', '--json',
        'number,title,url,mergeable,headRefName,isDraft,createdAt,statusCheckRollup'], { cwd: r.path });
      return Array.isArray(list) ? list.map((x) => ({ ...prSummary(x), repo: r.key })) : [];
    })),
  ]);
  // je Workspace mit Inhalt: bereit und die Phasen mit ihren Titeln aus der Projekt-Config
  const boardCols = Array.isArray(issues) ? Object.entries(workspaces).map(([key, ws]) => {
    const cols = groupIssues(issues, ws, workspaces);
    const titles = Object.fromEntries((cfg.workspaces.find((x) => x.key === key)?.phases || []).map((ph) => [ph.key, ph.title || ph.key]));
    const list = [['bereit', cols.ready.length], ...ws.phases.map((ph) => [titles[ph] || ph, cols[ph].length])];
    return { label: ws.label || key, cols: list, any: list.some(([, n]) => n > 0) };
  }).filter((b) => b.any) : [];
  const value = { board: boardCols, prs: prLists.flat() };
  slowCache.set(root, { at: Date.now(), value });
  return value;
}

// Rückfrage eines wartenden Terminal-Workers: Bildschirm über `workers screen` auf seinem Rechner
async function askFor(root, conf, w) {
  const args = ['screen', w.name, '--lines', '40'];
  try {
    let stdout;
    if (!conf || w.host === conf.self) {
      ({ stdout } = await run(join(root, 'scripts/beadskit/workers'), args, { cwd: root, timeout: 10_000 }));
    } else {
      const self = conf.hosts.find((h) => h.name === conf.self);
      const h = conf.hosts.find((x) => x.name === w.host);
      const there = h && mapRoot(root, self?.root, h.root);
      if (!there) return null;
      ({ stdout } = await run('ssh', [...SSH_OPTS, h.ssh, remoteCommand(there, 'scripts/beadskit/workers', args)], { timeout: 10_000 }));
    }
    return parsePrompt(stdout) || { question: null, options: [], context: [] };
  } catch {
    return null;
  }
}

async function projectData(root, conf) {
  const pc = await projectConfig(root);
  if (!pc) return null;
  const { cfg, workspaces } = pc;
  const bd = (args) => json(join(root, 'scripts/beadskit/bdw'), [...args, '--json'], { cwd: root, env: { ...process.env, BEADS_ACTOR: 'user' } });
  const since = new Date(Date.now() - 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');
  const [byStatus, human, done, working, slot, kv, perHost, humanList, doneList] = await Promise.all([
    bd(['count', '--by-status']), bd(['count', '-l', 'human', '--status', 'open']),
    bd(['count', '--status', 'closed', '--closed-after', since]),
    bd(['list', '--status', 'in_progress', '-n', '0']), bd(['merge-slot', 'check']),
    cfg.markers === 'kv' ? bd(['kv', 'list']) : Promise.resolve(null),
    hostWorkers(root, workspaces, conf),
    bd(['list', '-l', 'human', '--status', 'open', '--sort', 'priority', '-n', '10']),
    bd(['list', '--status', 'closed', '--sort', 'closed', '-n', '10']),
  ]);
  const slow = await slowData(root, cfg, workspaces, bd);
  const board = (list) => (Array.isArray(list) ? list.filter(isBoardIssue) : []);
  const { workers, hosts } = mergeHostWorkers(perHost, workspaces);
  const marks = parseMarkers(kv, cfg.roles, conf ? conf.hosts.map((h) => h.name) : []);
  const group = (k) => byStatus?.groups?.find((g) => g.group === k)?.count ?? 0;
  const live = (Array.isArray(working) ? working : []).filter((i) => !String(i.id).endsWith('-merge-slot') && i.issue_type !== 'epic');
  return {
    hosts,
    project: {
      name: cfg.name,
      slug: cfg.slug,
      colors: cfg.colors,
      threshold: marks.threshold,
      metrics: byStatus ? { open: group('open'), working: live.length, human: human?.count ?? 0, done24h: done?.count ?? 0 } : null,
      slot: slot ? { available: !!slot.available, holder: slot.holder || null } : null,
      board: slow.board,
      prs: slow.prs,
      human: board(humanList).slice(0, 8).map((i) => ({ id: i.id, title: i.title, priority: i.priority })),
      done: board(doneList).sort((a, b) => String(b.closed_at).localeCompare(String(a.closed_at))).slice(0, 8)
        .map((i) => ({ id: i.id, title: i.title, closed_at: i.closed_at, assignee: i.assignee })),
      errors: [byStatus ? null : 'beads antwortet nicht', ...hosts.filter((h) => !h.ok).map((h) => `${h.name}: ${h.error}`)].filter(Boolean),
      workers: await Promise.all(workers.map(async (w) => ({
        ...w,
        drained: !!marks.drain.roles[w.role] || !!marks.drain.hosts[w.host],
        issues: live.filter((i) => i.assignee === w.name).map((i) => ({ id: i.id, title: i.title })),
        ask: w.status === 'waiting' && w.kind === 'terminal' ? await askFor(root, conf, w) : null,
      }))),
    },
  };
}

// ProjectTemplate dieses Rechners (beads-top läuft von dort); auf dem anderen Rechner über HOST_<h>_ROOT
const TEMPLATE = dirname(dirname(dirname(dirname(realpathSync(fileURLToPath(import.meta.url))))));

// Systemwerte je Rechner: dieser direkt, die anderen per ssh über host-agent.mjs im ProjectTemplate dort
async function systems(conf) {
  if (!conf) return [{ name: hostname().split('.')[0], leader: false, ok: true, stats: await systemStats() }];
  const self = conf.hosts.find((h) => h.name === conf.self);
  return Promise.all(conf.hosts.map(async (h) => {
    const base = { name: h.name, leader: h.name === conf.leader };
    if (h.name === conf.self) return { ...base, ok: true, stats: await systemStats() };
    const there = mapRoot(TEMPLATE, self?.root, h.root);
    if (!there) return { ...base, ok: false, error: 'ProjectTemplate dort unbekannt (hosts.conf)' };
    try {
      const { stdout } = await run('ssh', [...SSH_OPTS, h.ssh, remoteCommand(there, 'scripts/beadskit/leitstand/host-agent.mjs', ['system'])],
        { timeout: 15_000 });
      return { ...base, ok: true, stats: JSON.parse(stdout) };
    } catch (e) {
      return { ...base, ok: false, error: String(e.stderr || e.message).trim().split('\n').at(-1) };
    }
  }));
}

// Verlauf der Systemwerte je Rechner (nur im Speicher, 60 Punkte)
const history = new Map();
function remember(sys) {
  if (!sys.ok || !sys.stats) return sys;
  const h = history.get(sys.name) || { cpu: [], mem: [] };
  h.cpu.push(sys.stats.cpu?.percent ?? null);
  h.mem.push(sys.stats.mem ? (sys.stats.mem.used / sys.stats.mem.total) * 100 : null);
  h.cpu = h.cpu.slice(-60);
  h.mem = h.mem.slice(-60);
  history.set(sys.name, h);
  return { ...sys, history: h };
}

async function collect(filter) {
  let conf = null;
  try { conf = parseHostsConf(await readFile(join(CONF_DIR, 'hosts.conf'), 'utf8')); } catch { /* ein Rechner */ }
  const sysP = systems(conf);
  let roots = [];
  try { roots = parseProjectList(await readFile(join(CONF_DIR, 'projects.txt'), 'utf8')); } catch { /* keine Liste */ }
  const all = (await Promise.all(roots.map((r) => projectData(r, conf)))).filter(Boolean)
    .filter((d) => !filter.length || filter.includes(d.project.slug) || filter.includes(d.project.name));
  // Rechner aus dem ersten Projekt (alle fragen dieselben), Projekte mit Workern zuerst
  const hosts = all[0]?.hosts ?? (conf ? conf.hosts.map((h) => ({ name: h.name, ok: true, leader: h.name === conf.leader })) : []);
  const projects = all.map((d) => d.project)
    .sort((a, b) => (b.workers.length > 0) - (a.workers.length > 0) || a.name.localeCompare(b.name, 'de'));
  return { at: new Date().toISOString(), hosts: conf ? hosts : [], systems: (await sysP).map(remember), projects };
}

// ---------------------------------------------------------------- Programm

async function main(argv) {
  const once = argv.includes('--once');
  const i = argv.indexOf('--interval');
  const interval = Math.max(2, Number(i >= 0 ? argv[i + 1] : 5) || 5) * 1000;
  const filter = argv.filter((a, k) => !a.startsWith('--') && argv[k - 1] !== '--interval');
  const tty = process.stdout.isTTY;
  if (once || !tty) {
    process.stdout.write(`${renderOverview(await collect(filter), {
      width: process.stdout.columns || Number(process.env.COLUMNS) || 120,
      height: process.stdout.rows || Number(process.env.LINES) || Infinity,
      color: !!tty,
    })}\n`);
    return;
  }
  // eigener Bildschirm wie bei top/less; beim Beenden alles wiederherstellen
  const restore = () => { process.stdout.write(`${ESC}?25h${ESC}?1049l`); };
  process.stdout.write(`${ESC}?1049h${ESC}?25l`);
  process.on('exit', restore);
  let timer = null;
  let busy = false;
  const draw = async () => {
    if (busy) return;
    busy = true;
    clearTimeout(timer);
    try {
      const text = renderOverview(await collect(filter), { width: process.stdout.columns || 120, height: (process.stdout.rows || 40) - 1 });
      process.stdout.write(`${ESC}H${text.split('\n').map((l) => `${l}${ESC}K`).join('\n')}${ESC}J`);
    } catch (e) {
      process.stdout.write(`${ESC}H${ESC}J Fehler: ${e.message}`);
    } finally {
      busy = false;
      timer = setTimeout(draw, interval);
    }
  };
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on('data', (b) => {
    const k = b.toString();
    if (k === 'q' || k === '\x03' || k === '\x1b') process.exit(0);
    if (k === 'r') draw();
  });
  process.stdout.on('resize', draw);
  await draw();
}

// realpath: als beads-top über einen Symlink aufgerufen
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}

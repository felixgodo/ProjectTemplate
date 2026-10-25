#!/usr/bin/env node
// Live-Übersicht im Terminal: alle Projekte aus ~/.config/beadskit/projects.txt mit ihren Workern
// auf allen Rechnern (hosts.conf), je Worker Rechner, Status, Issue, letzte Aktion, Ruhezeit und
// Kontext, je Projekt die Kennzahlen aus beads. Liest nur (wie der Leitstand, aber ohne Browser
// und Login); läuft auf Mac und PC.
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
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  buildWorkspaces, CONF_DIR, localWorkers, mapRoot, mergeHostWorkers, normalizeConfig, normalizeExt, parseHostsConf,
  parseMarkers, parseProjectList, remoteCommand,
} from './inbox.mjs';

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

/**
 * Baut die Übersicht als Text. data = { at, hosts: [{name, ok, leader, error}], projects: [{ name,
 * slug, colors, metrics: {open, human, working, done24h} | null, slot: {available, holder} | null,
 * workers: [{ name, role, host, status, kind, drained, issues: [{id, title}], activity }],
 * threshold, errors: [] }] }.
 */
export function renderOverview(data, { width = 120, color = true, now = Date.now(), multi = data.hosts.length > 1 } = {}) {
  const p = palette(color);
  const w = Math.max(60, width);
  const out = [];
  const rule = p.dim('─'.repeat(w));
  const hosts = multi ? `  ${data.hosts.map((h) => (h.ok
    ? `${p.green('●')} ${h.name}${h.leader ? ' ★' : ''}`
    : `${p.red('●')} ${h.name} ${p.red('offline')}`)).join('   ')}` : '';
  out.push(`${p.bold(' beads · Übersicht')}${hosts}${' '.repeat(4)}${p.dim(`${new Date(data.at).toLocaleTimeString('de-DE')} · q beenden · r neu`)}`);
  out.push(rule);
  // Spalten: Punkt, Name, Rechner, Status, Issue (flexibel), Aktion (flexibel), still, Kontext;
  // Name und Issue-ID so breit wie der längste Eintrag
  const all = data.projects.flatMap((x) => x.workers);
  const nameW = Math.min(22, Math.max(10, ...all.map((x) => x.name.length)));
  const idW = Math.min(18, Math.max(6, ...all.flatMap((x) => (x.issues || []).map((i) => i.id.length)))) + 1;
  const fixed = 2 + nameW + 1 + (multi ? 5 : 0) + 7 + 7 + 6 + 6;
  const flex = Math.max(20, w - fixed);
  const issueW = Math.floor(flex * 0.55);
  const actW = flex - issueW;
  for (const pr of data.projects) {
    const m = pr.metrics;
    const facts = [
      `${pr.workers.length} Worker${pr.workers.length ? ` (${pr.workers.filter((x) => x.status !== 'idle').length} aktiv)` : ''}`,
      m ? p.dim(`offen ${m.open}`) : null,
      m ? p.dim(`in Arbeit ${m.working}`) : null,
      m && m.human ? p.yellow(`wartet auf dich ${m.human}`) : m ? p.dim('wartet auf dich 0') : null,
      m ? p.dim(`erledigt 24 h ${m.done24h}`) : null,
      pr.slot ? (pr.slot.available ? p.dim('Merge-Slot frei') : p.cyan(`Merge-Slot ${pr.slot.holder}`)) : null,
    ].filter(Boolean);
    out.push(`${p.bold(` ${pr.name}`)}  ${facts.join(p.dim(' · '))}`);
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
        wk.drained ? p.yellow(fit('Drain', 6)) : busy ? fit(wk.status, 6) : p.dim(fit('idle', 6)),
        issue ? `${p.cyan(fit(issue.id, idW))}${fit(issue.title, issueW - idW - 1)}` : p.dim(fit(busy ? '' : 'wartet auf die nächste Runde', issueW - 1)),
        tool ? `${p.dim(fit(tool.name, 10))} ${fit(tool.summary, actW - 12)}` : p.dim(fit('–', actW - 1)),
        busy && quietMs > 30 * 60_000 ? p.red(fit(quiet, 6, true)) : busy && quietMs > 10 * 60_000 ? p.yellow(fit(quiet, 6, true)) : p.dim(fit(quiet, 6, true)),
        over ? p.red(fit(ktok(a.contextTokens), 5, true)) : fit(ktok(a.contextTokens), 5, true),
        a.pending?.length ? p.yellow(`✉${a.pending.length}`) : null,
      ].filter((c) => c !== null);
      out.push(`   ${cells.join(' ')}`);
    }
    out.push('');
  }
  if (!data.projects.length) out.push(p.dim(' keine Projekte (projects.txt) bzw. keine passenden'));
  return out.join('\n');
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

async function projectData(root, conf) {
  const pc = await projectConfig(root);
  if (!pc) return null;
  const { cfg, workspaces } = pc;
  const bd = (args) => json(join(root, 'scripts/beadskit/bdw'), [...args, '--json'], { cwd: root, env: { ...process.env, BEADS_ACTOR: 'user' } });
  const since = new Date(Date.now() - 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');
  const [byStatus, human, done, working, slot, kv, perHost] = await Promise.all([
    bd(['count', '--by-status']), bd(['count', '-l', 'human', '--status', 'open']),
    bd(['count', '--status', 'closed', '--closed-after', since]),
    bd(['list', '--status', 'in_progress', '-n', '0']), bd(['merge-slot', 'check']),
    cfg.markers === 'kv' ? bd(['kv', 'list']) : Promise.resolve(null),
    hostWorkers(root, workspaces, conf),
  ]);
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
      errors: [byStatus ? null : 'beads antwortet nicht', ...hosts.filter((h) => !h.ok).map((h) => `${h.name}: ${h.error}`)].filter(Boolean),
      workers: workers.map((w) => ({
        ...w,
        drained: !!marks.drain.roles[w.role] || !!marks.drain.hosts[w.host],
        issues: live.filter((i) => i.assignee === w.name).map((i) => ({ id: i.id, title: i.title })),
      })),
    },
  };
}

async function collect(filter) {
  let conf = null;
  try { conf = parseHostsConf(await readFile(join(CONF_DIR, 'hosts.conf'), 'utf8')); } catch { /* ein Rechner */ }
  let roots = [];
  try { roots = parseProjectList(await readFile(join(CONF_DIR, 'projects.txt'), 'utf8')); } catch { /* keine Liste */ }
  const all = (await Promise.all(roots.map((r) => projectData(r, conf)))).filter(Boolean)
    .filter((d) => !filter.length || filter.includes(d.project.slug) || filter.includes(d.project.name));
  // Rechner aus dem ersten Projekt (alle fragen dieselben), Projekte mit Workern zuerst
  const hosts = all[0]?.hosts ?? (conf ? conf.hosts.map((h) => ({ name: h.name, ok: true, leader: h.name === conf.leader })) : []);
  const projects = all.map((d) => d.project)
    .sort((a, b) => (b.workers.length > 0) - (a.workers.length > 0) || a.name.localeCompare(b.name, 'de'));
  return { at: new Date().toISOString(), hosts: conf ? hosts : [], projects };
}

// ---------------------------------------------------------------- Programm

async function main(argv) {
  const once = argv.includes('--once');
  const i = argv.indexOf('--interval');
  const interval = Math.max(2, Number(i >= 0 ? argv[i + 1] : 5) || 5) * 1000;
  const filter = argv.filter((a, k) => !a.startsWith('--') && argv[k - 1] !== '--interval');
  const tty = process.stdout.isTTY;
  if (once || !tty) {
    process.stdout.write(`${renderOverview(await collect(filter), { width: process.stdout.columns || 120, color: !!tty })}\n`);
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
      const text = renderOverview(await collect(filter), { width: process.stdout.columns || 120 });
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

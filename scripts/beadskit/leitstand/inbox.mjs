#!/usr/bin/env node
// Leitstand für die beads-Pipelines aller Projekte (Login mit Token oder Benutzer/Passwort): oben
// „Wartet auf dich“ (Issues mit Label human) mit Entscheidungsfeld, Worker-Karten (was jede
// Claude-Session gerade tut, aus ihrem Transkript), Kanban-Board je Workspace, PRs mit CI-Stand,
// CI-Runner. Steuert Issues (verschieben, Priorität, Unclaim, anlegen), Worker (start, add, drain,
// stop, restart, Chat: Verlauf lesen, Nachricht ins Terminal senden) und die CI-Runner auf dem
// Server (gemeinsamer Pool aller Projekte, Tab „CI“: Plätze, an/aus, CI-MySQL, je Projekt Grenze
// und Pause). Mit `workers autorestart` startet der Server Worker mit
// großem Kontext zwischen zwei Runden selbst neu (Prüfung jede Minute, siehe planRestarts).
// Liest und schreibt nur über scripts/beadskit/{bdw,workers,ci/runner-pool}, `claude agents|logs`,
// `gh` und die Transkripte unter ~/.claude/projects (nur lesend).
//
// Zwei Rechner (~/.config/beadskit/hosts.conf, siehe ProjectTemplate/scripts/remote): Der Leitstand
// läuft auf dem Leitrechner und holt die Worker des anderen Rechners per ssh (on-host +
// host-agent.mjs im selben Projekt dort); Start, Stopp, Neustart und Nachrichten laufen auf dem
// Rechner des Workers. beads ist ohnehin gemeinsam (eine Datenbank auf dem Leitrechner).
//
// Ein Prozess für alle Projekte: Die Liste steht in ~/.config/beadskit/projects.txt (ein Pfad je
// Zeile; `workers` trägt sein Projekt bei jedem Aufruf ein). Jede Projekt-Route nimmt ?p=<slug>.
// Workspaces (code und BK_WORKSPACES aus beads.project.sh): ein Issue gehört über das Label
// ws:<name> zu einem Workspace, ohne ws:-Label zu code; /api/state?p=…&ws=… liefert Spalten und
// Kennzahlen eines Workspaces plus deren Beschreibung, damit die Seite nichts fest verdrahtet.
// Projektspezifisches (Knöpfe, Zusatzlisten, Links an Karten, Texte) kommt aus der optionalen
// beads.leitstand.mjs im Projekt, siehe README.
//
//   node scripts/beadskit/leitstand/inbox.mjs        http://127.0.0.1:3738
//   PORT=4000 node scripts/beadskit/leitstand/inbox.mjs
//
// Schreibzugriffe nur von der eigenen Seite: Origin muss passen, und der Header
// X-Beads-Inbox erzwingt bei fremden Seiten einen CORS-Preflight, den der Server nicht erlaubt.
import { execFile } from 'node:child_process';
import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { chatTranscript, readTail, sessionSummary, transcriptPath } from './sessions.mjs';
import { parseServerStats, pushHistory, serverCommand, systemStats, UNIT_RE } from './sysinfo.mjs';

const run = promisify(execFile);
const scrypt = promisify(scryptCb);
const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3738);
// Entscheidungen erscheinen in beads unter diesem Actor
const ACTOR = process.env.BEADS_ACTOR_INBOX || 'user';
// Fernzugang: öffentliche Adresse hinter dem Server-Proxy (siehe leitstand-remote)
const PUBLIC_URL = process.env.LEITSTAND_PUBLIC_URL || '';
export const CONF_DIR = process.env.BEADSKIT_HOME || join(homedir(), '.config', 'beadskit');

export const ACTIONS = ['release', 'note', 'defer', 'close'];
export const DEFAULT_ROLES = ['fix', 'search', 'verify', 'regress'];
export const TYPES = ['bug', 'feature', 'task', 'chore'];
const ID_RE = /^[a-z0-9]+-[a-z0-9]+(\.[0-9]+)*$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const ROLE_RE = /^[a-z]+(-[a-z]+)*$/;
const WS_RE = /^[a-z]+$/;
const KEY_RE = /^[a-z][a-z0-9-]{0,30}$/;
const DONE_WINDOW_MS = 24 * 3600 * 1000;
const CONFIG_TTL_MS = 30_000;
// Auto-Neustart: so lange still im Transkript, und frühestens so oft je Worker
export const RESTART_QUIET_MS = 60_000;
export const RESTART_COOLDOWN_MS = 10 * 60_000;

/** Heutiges Datum als YYYY-MM-DD (lokale Zeit). */
export function today(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

function checkId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('ungültige Issue-ID');
}

function cleanText(text, max = 4000) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (t.length > max) throw new Error(`Text zu lang (max. ${max} Zeichen)`);
  return t;
}

/** Worker-Namen eines Projekts: <rolle>-<n> mit einer seiner Rollen. */
export function workerRe(roles = DEFAULT_ROLES) {
  return new RegExp(`^(${roles.filter((r) => ROLE_RE.test(r)).join('|')})-\\d+$`);
}

// ---- Workspaces ----
// Vorgaben für code (die Pipeline fix → verify → merge); andere Workspaces bekommen ihre Texte
// aus beads.project.sh (Phasen-Titel) und beads.leitstand.mjs (workspaces.<name>).
const CODE_ROLE_LABELS = { fix: 'Fix', verify: 'Verify', search: 'Suche', regress: 'Regression' };
const CODE_ROLE_COLORS = { fix: 'var(--fix)', verify: 'var(--verify)', search: 'var(--search)', regress: 'var(--regress)' };
const CODE_COLS = {
  ready: ['Bereit', 'var(--ready)', 'Wartet auf einen Fix-Worker'],
  fix: ['In Arbeit', 'var(--fix)', 'Geclaimt von einem Worker'],
  verify: ['Verify', 'var(--verify)', 'PR offen, wartet auf Prüfung'],
  merge: ['Merge', 'var(--merge)', 'Geprüft, wartet auf den Merge-Slot'],
};
const PHASE_PALETTE = ['#e6781e', '#1ea0aa', '#d25096', '#7c3aed', '#3c6ed2', '#d2aa28'];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const str = (v, d = '') => (typeof v === 'string' && v ? v : d);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const rgb = (c) => (Array.isArray(c) && c.length === 3 && c.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
  ? `rgb(${c.join(' ')})` : null);
// CSS-Farbe aus beads.leitstand.mjs: Hex, rgb() oder var(--x), nichts, was aus dem Attribut ausbricht
const cssColor = (c) => (typeof c === 'string' && /^(#[0-9a-f]{3,8}|rgba?\([0-9 ,.%/]+\)|var\(--[a-z-]+\))$/i.test(c) ? c : null);

/**
 * Beschreibung aller Workspaces eines Projekts für Server und Seite (JSON-tauglich).
 * cols: Board-Spalten [key, Titel, Farbe, Hinweis]; human, die split-Spalten und deferred zeigt
 * die Seite außerhalb des Boards. Die erste Phase ist die, die Worker claimen: offen = „Bereit“,
 * in Arbeit = Spalte der Phase. moveTargets: Ziele beim Verschieben (die erste Phase fehlt
 * absichtlich, claimen nur Worker). split: human-Issues mit diesem Label bekommen eine eigene
 * Spalte (z. B. „zum Aktivieren“).
 */
export function buildWorkspaces(cfg, ext = {}) {
  const out = {};
  for (const w of cfg.workspaces) {
    const ui = (ext.workspaces && typeof ext.workspaces[w.key] === 'object' && ext.workspaces[w.key]) || {};
    const code = w.key === 'code';
    const phases = w.phases.map((p) => p.key);
    const titleOf = Object.fromEntries(w.phases.map((p, i) => [p.key,
      p.title || (code && CODE_COLS[p.key]?.[0]) || (i === 0 ? 'In Arbeit' : cap(p.key))]));
    const uiCol = (k) => (ui.cols && typeof ui.cols[k] === 'object' && ui.cols[k]) || {};
    const col = (k, title, color, hint) => [k, str(uiCol(k).title, title), cssColor(uiCol(k).color) || color, str(uiCol(k).hint, hint)];
    const cols = [
      col('ready', 'Bereit', 'var(--ready)', code ? CODE_COLS.ready[2] : 'Wartet auf einen Worker'),
      ...phases.map((p, i) => col(p, titleOf[p], (code && CODE_COLS[p]?.[1]) || PHASE_PALETTE[i % PHASE_PALETTE.length],
        (code && CODE_COLS[p]?.[2]) || (i === 0 ? 'Geclaimt von einem Worker' : ''))),
      col('done', 'Erledigt', 'var(--done)', 'Geschlossen in den letzten 24 h'),
    ];
    const split = (Array.isArray(ui.split) ? ui.split : [])
      .filter((s) => s && KEY_RE.test(s.key) && typeof s.label === 'string' && s.label && !phases.includes(s.key))
      .map((s) => ({ key: s.key, label: s.label, title: str(s.title, s.key) }));
    const roleLabels = Object.fromEntries(w.roles.map((r) => [r,
      str(ui.roleLabels?.[r], (code && CODE_ROLE_LABELS[r]) || cap(r.replace(/-/g, ' ')))]));
    const colors = Object.fromEntries(w.roles.map((r) => [r,
      cssColor(ui.colors?.[r]) || (code && CODE_ROLE_COLORS[r]) || rgb(cfg.colors?.[r]) || 'var(--muted)']));
    const group = ui.group && typeof ui.group.prefix === 'string' && /^[a-z-]+:$/.test(ui.group.prefix)
      ? { prefix: ui.group.prefix, all: str(ui.group.all, 'alle') } : { prefix: 'modul:', all: 'alle Module' };
    const create = ui.create && typeof ui.create === 'object' ? ui.create : {};
    const fields = (Array.isArray(create.fields) ? create.fields : [])
      .filter((f) => f && KEY_RE.test(f.name) && typeof f.prefix === 'string' && /^[a-z-]+:$/.test(f.prefix))
      .map((f) => ({ name: f.name, label: str(f.label, f.name), placeholder: str(f.placeholder), prefix: f.prefix }));
    out[w.key] = {
      name: w.key,
      label: str(ui.name, w.name || cap(w.key)),
      roles: w.roles,
      roleLabels,
      colors,
      defaults: Object.fromEntries(w.roles.map((r) => [r, Number(cfg.start?.[r] ?? 0)])),
      phases,
      readyPhase: phases[0],
      moveTargets: ['ready', ...phases.slice(1), 'human', 'deferred', 'done'],
      cols,
      split,
      group,
      kpis: Array.isArray(ui.kpis) ? ui.kpis : [
        ['human', 'wartet auf dich'], ...split.map((s) => [s.key, s.title]), ['open', 'bereit'],
        ['released', `bereit: ${w.phases[0].title || cap(phases[0])}`],
        ...phases.map((p, i) => [p, i === 0 ? 'in Arbeit' : titleOf[p]]),
        ...(code ? [['mergedToday', 'heute gemergt']] : []),
        ['done24h', 'erledigt (24 h)'], ['leadMs', 'Ø Durchlauf (24 h)'], ['stale', 'Claims abgelaufen']],
      create: {
        type: TYPES.includes(create.type) ? create.type : code ? 'bug' : 'task',
        modules: create.modules ?? code,
        fields,
        title: str(create.title, code ? 'Neues Issue' : `Neu: ${str(ui.name, w.name || cap(w.key))}`),
        titlePlaceholder: str(create.titlePlaceholder, code ? 'Modul: was passiert, wann, warum es falsch ist' : ''),
        descriptionPlaceholder: str(create.descriptionPlaceholder, code ? 'Fundstelle, Schritte zum Nachstellen, erwartetes Verhalten' : ''),
      },
      // HTML-Hinweise kommen nur aus dem Projekt selbst (beads.leitstand.mjs), nie aus beads
      humanHint: str(ui.humanHint),
      release: str(ui.release, code ? 'Freigeben an Fix' : 'Freigeben'),
      prs: ui.prs ?? code,
      // Antworten zum Antippen über den Eingabefeldern (Entscheidung, Notiz/Schließgrund, Chat)
      quick: Object.fromEntries(Object.entries(QUICK).map(([k, def]) => [k, quickList(ui.quick?.[k], def)])),
    };
  }
  return out;
}

/** Vorgaben der Schnellantworten; je Workspace in beads.leitstand.mjs unter quick überschreibbar. */
export const QUICK = {
  decide: ['Ja, so umsetzen', 'Wie vorgeschlagen', 'Nein, nicht gewollt', 'Nur in diesem Fall', 'Später nochmal fragen'],
  close: ['Erledigt', 'Duplikat', 'Nicht nötig', 'Nicht reproduzierbar', 'Kommt später', 'Siehe PR'],
  chat: ['Weiter', 'Status?', 'Ja', 'Nein', 'Nach diesem Issue stoppen', '/compact'],
};
const quickList = (v, def) => {
  if (!Array.isArray(v)) return def;
  return v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 120)).slice(0, 12);
};

/** Workspace eines Issues: Label ws:<name>, ohne (oder mit unbekanntem) zu code. */
export function wsOfIssue(issue, workspaces) {
  const l = (issue?.labels || []).find((x) => typeof x === 'string' && x.startsWith('ws:'));
  const w = l?.slice(3);
  return w && Object.hasOwn(workspaces, w) ? w : 'code';
}

/** Workspace einer Rolle (fix → code, club-add → clubs), null wenn unbekannt. */
export function wsOfRole(role, workspaces) {
  return Object.keys(workspaces).find((w) => workspaces[w].roles.includes(role)) ?? null;
}

/**
 * Übersetzt eine Entscheidung in bdw-Aufrufe (je ein Argument-Array, ohne Shell).
 * Wirft bei ungültiger Eingabe einen Error mit deutscher Meldung.
 */
export function planDecision({ id, action, text }, date = today()) {
  checkId(id);
  if (!ACTIONS.includes(action)) throw new Error('unbekannte Aktion');
  const t = cleanText(text);
  const note = `User-Entscheidung ${date}: ${t}`;
  switch (action) {
    case 'release':
      if (!t) throw new Error('Zum Freigeben bitte die Entscheidung eintragen');
      return [['update', id, '--remove-label', 'human', '--append-notes', note]];
    case 'note':
      if (!t) throw new Error('Notiz ist leer');
      return [['update', id, '--append-notes', note]];
    case 'defer':
      return [...(t ? [['update', id, '--append-notes', note]] : []), ['defer', id]];
    case 'close':
      if (!t) throw new Error('Zum Schließen bitte einen Grund eintragen');
      return [['close', id, '--reason', `${note}`]];
  }
}

/**
 * Übersetzt eine Issue-Aktion aus dem Board in bdw-Aufrufe. `current` ist der aktuelle Stand
 * des Issues (labels, status, assignee) aus `bdw show`, damit nur vorhandene Labels entfernt werden;
 * `ws` die Beschreibung seines Workspaces (buildWorkspaces).
 *   priority {value 0–4} · move {to: ws.moveTargets, text?} · unclaim
 */
export function planIssueAction({ id, action, value, to, text }, current = {}, ws, date = today()) {
  checkId(id);
  const t = cleanText(text);
  const labels = Array.isArray(current.labels) ? current.labels : [];
  const status = current.status || 'open';
  switch (action) {
    case 'priority': {
      const p = Number(value);
      if (!Number.isInteger(p) || p < 0 || p > 4) throw new Error('Priorität 0–4');
      return [['update', id, '--priority', String(p)]];
    }
    case 'unclaim': {
      if (status !== 'in_progress' || !current.assignee) throw new Error('Issue ist nicht geclaimt');
      // Compare-and-swap: hat der Worker inzwischen abgegeben, ändert sich nichts
      return [['unclaim', id, '--force', '--if-assignee', current.assignee]];
    }
    case 'move': {
      if (!ws.moveTargets.includes(to)) throw new Error('unbekanntes Ziel');
      const note = (what) => ['--append-notes', `User-Entscheidung ${date}: ${what}${t ? `. ${t}` : ''}`];
      if (to === 'done') {
        if (!t) throw new Error('Zum Schließen bitte einen Grund eintragen');
        if (status === 'closed') throw new Error('Issue ist schon geschlossen');
        return [['close', id, '--reason', `User-Entscheidung ${date}: ${t}`]];
      }
      if (to === 'deferred') {
        if (status === 'deferred') throw new Error('Issue ist schon zurückgestellt');
        return [
          ...(status === 'closed' ? [['reopen', id]] : []),
          ...(t ? [['update', id, ...note('zurückgestellt')]] : []),
          ['defer', id],
        ];
      }
      const steps = [];
      if (status === 'closed') steps.push(['reopen', id]);
      if (status === 'deferred') steps.push(['undefer', id]);
      const update = ['update', id];
      if (to === 'human') {
        if (!labels.includes('human')) update.push('--add-label', 'human');
        update.push(...note('braucht Entscheidung'));
      } else {
        const phase = to === 'ready' ? ws.readyPhase : to;
        if (labels.includes('human')) update.push('--remove-label', 'human');
        // split-Labels (z. B. aktivieren) gelten nur zusammen mit human
        for (const s of ws.split) if (labels.includes(s.label)) update.push('--remove-label', s.label);
        for (const l of labels) {
          if (l.startsWith('phase:') && l !== `phase:${phase}`) update.push('--remove-label', l);
        }
        if (!labels.includes(`phase:${phase}`)) update.push('--add-label', `phase:${phase}`);
        update.push(...note(`verschoben nach phase:${phase}`));
      }
      steps.push(update);
      return steps;
    }
    default:
      throw new Error('unbekannte Aktion');
  }
}

/**
 * Text als Label-Wert: klein, Umlaute als ae/oe/ue/ss, Leerzeichen als „-“, sonst nur a–z, 0–9
 * und „-“ („Bad Honnef“ → bad-honnef). Leer bleibt leer; wirft bei zu langem Wert.
 */
export function labelSlug(name, what = 'Wert') {
  const s = String(name ?? '').trim().toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > 60) throw new Error(`${what}: höchstens 60 Zeichen`);
  return s;
}

/**
 * Neues Issue aus dem Formular; landet in der ersten Phase des Workspaces (code: phase:fix), mit
 * ws:<name> außerhalb von code, optional modul:<x>, den Zusatzfeldern des Workspaces als Labels
 * (<prefix><slug>) und human.
 */
export function planCreate({ title, description, priority, modul, type, human, ...rest }, ws, modules = []) {
  const t = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
  if (t.length < 5 || t.length > 200) throw new Error('Titel 5–200 Zeichen');
  const d = cleanText(description, 20_000);
  const p = Number(priority ?? 2);
  if (!Number.isInteger(p) || p < 0 || p > 4) throw new Error('Priorität 0–4');
  const ty = type || ws.create.type;
  if (!TYPES.includes(ty)) throw new Error('unbekannter Typ');
  if (modul && (!ws.create.modules || !modules.includes(modul))) throw new Error('unbekanntes Modul');
  const extra = ws.create.fields.map((f) => {
    const v = labelSlug(rest[f.name], f.label);
    return v ? `${f.prefix}${v}` : null;
  }).filter(Boolean);
  const labels = [...(ws.name === 'code' ? [] : [`ws:${ws.name}`]), `phase:${ws.readyPhase}`,
    ...(modul ? [`modul:${modul}`] : []), ...extra, ...(human ? ['human'] : [])];
  // Werte immer als --flag=wert: ein Titel wie „--force …“ bleibt so ein Wert
  return [['create', `--title=${t}`, `--description=${d || t}`, `--priority=${p}`, `--type=${ty}`,
    `--labels=${labels.join(',')}`]];
}

/**
 * Argumente für scripts/beadskit/workers. `ws` (Standard code) bestimmt, welche Rollen start, add
 * und drain annehmen. drain mit role 'all' = globaler Drain, role 'ws' = alle Rollen des Workspaces,
 * role 'host' = alle Worker des Rechners `host` (einer aus `hosts`). Wo die Aktion läuft, sagt
 * routeWorkerAction.
 */
export function planWorkerAction({ action, role, name, force, off, counts, threshold, text, ws, host }, workspaces, hosts = []) {
  const w = ws ?? 'code';
  if (typeof w !== 'string' || !Object.hasOwn(workspaces, w)) throw new Error('unbekannter Workspace');
  const roles = workspaces[w].roles;
  const all = Object.values(workspaces).flatMap((x) => x.roles);
  const re = workerRe(all);
  switch (action) {
    case 'start': {
      // Gesamtzahl je Rolle des Workspaces; start hebt auch dessen Drain auf
      const args = ['start', '--ws', w];
      for (const r of roles) {
        const n = Number(counts?.[r] ?? 0);
        if (!Number.isInteger(n) || n < 0 || n > 8) throw new Error(`Anzahl ${r}: 0–8`);
        args.push(`${r}=${n}`);
      }
      return args;
    }
    case 'add':
      if (!roles.includes(role)) throw new Error('unbekannte Rolle');
      return ['add', role];
    case 'drain': {
      // role 'host': nur die Worker eines Rechners (zwei Rechner)
      if (role === 'host') {
        if (typeof host !== 'string' || !hosts.includes(host)) throw new Error('unbekannter Rechner');
        return ['drain', '--host', host, ...(off ? ['--off'] : [])];
      }
      const what = role === 'all' ? [] : role === 'ws' ? ['--ws', w] : roles.includes(role) ? [role] : null;
      if (!what) throw new Error('unbekannte Rolle');
      return ['drain', ...what, ...(off ? ['--off'] : [])];
    }
    case 'stop':
      if (name === 'all') return ['stop', '--all', ...(force ? ['--force'] : [])];
    // falls through
    case 'restart':
      if (typeof name !== 'string' || !re.test(name)) throw new Error('unbekannter Worker');
      return [action, name, ...(force ? ['--force'] : [])];
    case 'press': {
      if (typeof name !== 'string' || !re.test(name)) throw new Error('unbekannter Worker');
      if (!PRESS_KEYS.includes(text)) throw new Error('Taste: 1–9, Escape oder Enter');
      return ['press', name, text];
    }
    case 'send': {
      if (typeof name !== 'string' || !re.test(name)) throw new Error('unbekannter Worker');
      // eine Zeile: Enter im Tab schickt ab, Steuerzeichen würden die Oberfläche bedienen
      // eslint-disable-next-line no-control-regex
      const t = String(text ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').trim();
      if (!t) throw new Error('kein Text');
      if (t.length > 4000) throw new Error('Text zu lang (höchstens 4000 Zeichen)');
      return ['send', name, '--', t];
    }
    case 'autorestart': {
      if (off) return ['autorestart', '--off'];
      const n = Number(threshold);
      if (!Number.isInteger(n) || n < 50_000 || n > 900_000) throw new Error('Schwelle: 50k–900k Tokens');
      return ['autorestart', '--over', String(n)];
    }
    default:
      throw new Error('unbekannte Aktion');
  }
}

const POOL_LABEL_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const POOL_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Argumente für scripts/beadskit/ci/runner-pool: Plätze (size 1–8), Dienst an/aus (start/stop ohne
 * n), CI-Datenbank an/aus (n = mysql oder mariadb, stop mit --force trotz laufendem Job) und je
 * Projekt (label) Grenze (limit, n 1–8 oder 'off') und Pause (pause/resume). prio zieht einen Lauf
 * (repo, run) an den Anfang der Warteschlange, mit off nimmt es ihn wieder heraus.
 */
export function planRunnerAction({ action, n, force, label, repo, run, off }) {
  if (action === 'prio') {
    if (typeof repo !== 'string' || !POOL_REPO_RE.test(repo)) throw new Error('unbekanntes Repo');
    if (!(Number.isSafeInteger(run) && run > 0)) throw new Error('ungültige Run-ID');
    return off ? ['prio', '--off', repo, String(run)] : ['prio', repo, String(run)];
  }
  if (action === 'size') {
    if (!(Number.isInteger(n) && n >= 1 && n <= 8)) throw new Error('Plätze: 1–8');
    return ['size', String(n)];
  }
  if (action === 'limit' || action === 'pause' || action === 'resume') {
    if (typeof label !== 'string' || !POOL_LABEL_RE.test(label)) throw new Error('unbekanntes Projekt-Label');
    if (action !== 'limit') return [action, label];
    if (!(n === 'off' || (Number.isInteger(n) && n >= 1 && n <= 8))) throw new Error('Grenze: 1–8 oder off');
    return ['limit', label, String(n)];
  }
  if (action !== 'start' && action !== 'stop') throw new Error('unbekannte Aktion');
  if (n == null) return [action];
  if (n !== 'mysql' && n !== 'mariadb') throw new Error('nur der Pool, mysql oder mariadb');
  return [action, n, ...(action === 'stop' && force ? ['--force'] : [])];
}

/**
 * Normalisiert `runner-pool status --json`: Dienst, Plätze, Grenzen je Projekt, laufende Pool-Runner
 * (mit Projekt-Label, Job, CPU, RAM), wartende Jobs je Label, CI-MySQL und Slice. Ungültiges fällt
 * weg. limits ist null, solange der Dienst auf dem Server noch keine Grenzen kennt (setup fehlt).
 * queue: wartende Läufe in der Reihenfolge des Dienstes (vorgezogene zuerst), je Lauf ein Eintrag;
 * stale: wartet seit STALE (Dienst, 30 min) oder länger, runStatus: Status des Laufs bei GitHub.
 */
export function parsePool(d) {
  const job = (j) => (j && typeof j === 'object' ? {
    name: str(j.name),
    branch: str(j.branch),
    title: str(j.title),
    // nur Links zu GitHub, die Seite setzt sie als href
    url: typeof j.url === 'string' && j.url.startsWith('https://github.com/') ? j.url : null,
    started: str(j.started, null),
  } : null);
  const o = d && typeof d === 'object' ? d : {};
  const queued = o.queued && typeof o.queued === 'object' && !Array.isArray(o.queued) ? o.queued : {};
  return {
    service: str(o.service, 'missing'),
    token: o.token === true,
    slots: Number.isInteger(o.slots) && o.slots >= 1 && o.slots <= 8 ? o.slots : null,
    repos: (Array.isArray(o.repos) ? o.repos : [])
      .filter((r) => r && typeof r.repo === 'string' && typeof r.label === 'string')
      .map((r) => ({ repo: r.repo, label: r.label })),
    queued: Object.fromEntries(Object.entries(queued).filter(([, v]) => Number.isInteger(v) && v > 0)),
    limits: o.limits && typeof o.limits === 'object' && !Array.isArray(o.limits)
      ? Object.fromEntries(Object.entries(o.limits)
        .filter(([k, v]) => POOL_LABEL_RE.test(k) && v && typeof v === 'object')
        .map(([k, v]) => [k, {
          max: Number.isInteger(v.max) && v.max >= 1 && v.max <= 8 ? v.max : null,
          paused: v.paused === true,
        }]))
      : null,
    queue: (Array.isArray(o.queue) ? o.queue : [])
      .filter((q) => q && typeof q.repo === 'string' && POOL_REPO_RE.test(q.repo) && Number.isSafeInteger(q.run) && q.run > 0)
      .map((q) => ({
        repo: q.repo,
        label: str(q.label),
        run: q.run,
        pr: Number.isSafeInteger(q.pr) && q.pr > 0 ? q.pr : null,
        branch: str(q.branch),
        title: str(q.title),
        url: typeof q.url === 'string' && q.url.startsWith('https://github.com/') ? q.url : null,
        jobs: Number.isInteger(q.jobs) && q.jobs > 0 ? q.jobs : 1,
        created: str(q.created, null),
        prio: q.prio === true,
        runLabel: q.runLabel === true,
        runStatus: str(q.runStatus),
        stale: q.stale === true,
      })),
    runners: (Array.isArray(o.runners) ? o.runners : [])
      .filter((r) => r && typeof r.name === 'string' && r.name.startsWith('pool-'))
      .map((r) => ({
        name: r.name,
        label: str(r.label),
        repo: str(r.repo),
        slot: Number(r.slot) || null,
        busy: r.busy === true,
        github: str(r.github, 'starting'),
        job: job(r.job),
        cpu: num(r.cpu),
        mem: num(r.mem),
      }))
      .sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99)),
    mysql: parseMysql(o.mysql),
    mariadb: parseMysql(o.mariadb),
    slice: parseSlice(o.slice),
    at: str(o.at, null),
  };
}

/** CI-Datenbank (MySQL oder MariaDB) aus `runner-pool status --json` (container, cpu, mem) oder null, wenn es keine gibt. */
export function parseMysql(m) {
  if (!m || typeof m !== 'object') return null;
  return { container: str(m.container, 'missing'), cpu: num(m.cpu), mem: num(m.mem) };
}

/** Auslastung der CI-Slice aus `runner-pool status --json`: cpuPct (% eines Kerns), cpus (Quota), mem (Bytes). */
export function parseSlice(s) {
  if (!s || typeof s !== 'object') return null;
  const out = { cpuPct: num(s.cpuPct), cpus: num(s.cpus), mem: num(s.mem) };
  return Object.values(out).every((v) => v == null) ? null : out;
}

/** Gehört ein Issue aufs Board? Epics, Merge-Slot und angeheftete nicht. */
export function isBoardIssue(raw) {
  const labels = raw?.labels || [];
  return !!raw && raw.issue_type !== 'epic' && !String(raw.id).endsWith('-merge-slot')
    && !labels.includes('gt:slot') && raw.status !== 'pinned';
}

/**
 * Ordnet die Issues eines Workspaces den Spalten zu. human hat Vorrang vor der Phase; human mit
 * einem split-Label landet in dessen Spalte. Spätere Phasen gehen nach Label (die letzte zuerst),
 * die erste nach Status: offen = ready, in Arbeit = Spalte der Phase.
 */
export function groupIssues(issues, ws, workspaces, now = Date.now()) {
  const later = ws.phases.slice(1).reverse();
  const cols = Object.fromEntries(['human', ...ws.split.map((s) => s.key), 'ready', ...ws.phases, 'done', 'deferred']
    .map((k) => [k, []]));
  for (const raw of Array.isArray(issues) ? issues : []) {
    if (!isBoardIssue(raw) || wsOfIssue(raw, workspaces) !== ws.name) continue;
    const labels = raw.labels || [];
    const it = {
      ...raw,
      labels,
      stale: raw.status === 'in_progress' && !!raw.lease_expires_at && Date.parse(raw.lease_expires_at) < now,
    };
    if (raw.status === 'closed') {
      if (raw.closed_at && now - Date.parse(raw.closed_at) <= DONE_WINDOW_MS) cols.done.push(it);
    } else if (raw.status === 'deferred') cols.deferred.push(it);
    else if (labels.includes('human')) cols[ws.split.find((s) => labels.includes(s.label))?.key ?? 'human'].push(it);
    else {
      const p = later.find((x) => labels.includes(`phase:${x}`));
      if (p) cols[p].push(it);
      else if (raw.status === 'in_progress') cols[ws.readyPhase].push(it);
      else cols.ready.push(it);
    }
  }
  // in Bereit zuerst die freigegebenen (phase:<erste Phase>): nur die claimen Worker
  const parked = (i) => !i.labels.includes(`phase:${ws.readyPhase}`);
  for (const [k, list] of Object.entries(cols)) {
    if (k === 'done') list.sort((a, b) => String(b.closed_at).localeCompare(String(a.closed_at)));
    else list.sort((a, b) => (k === 'ready' ? parked(a) - parked(b) : 0)
      || (a.priority ?? 9) - (b.priority ?? 9) || a.id.localeCompare(b.id, 'de', { numeric: true }));
  }
  return cols;
}

/**
 * Issues, auf die ein Issue wartet (Abhängigkeit vom Typ blocks), aufgelöst über byId (id → Issue
 * aus bd list): id, Titel, Status, Phase; offene zuerst. Versteht die Kanten aus bd list
 * (depends_on_id/type) und bd show (id/dependency_type). Unbekannte IDs bleiben ohne Titel/Status.
 */
export function waitsOf(issue, byId) {
  const out = [];
  for (const d of issue?.dependencies || []) {
    const id = d.depends_on_id || d.id;
    if (!id || (d.type || d.dependency_type) !== 'blocks' || out.some((w) => w.id === id)) continue;
    const b = byId.get(id);
    const phase = (b?.labels || []).find((l) => l.startsWith('phase:'))?.slice(6) ?? null;
    out.push({ id, title: b?.title ?? null, status: b?.status ?? null, phase });
  }
  return out.sort((a, b) => (a.status === 'closed') - (b.status === 'closed'));
}

/** Kennzahlen für die Kopfleiste: die Länge jeder Spalte unter ihrem Schlüssel plus Summen. */
export function metrics(cols, ws, merged = [], now = Date.now()) {
  const day = today(new Date(now));
  const lead = cols.done
    .filter((i) => i.created_at && i.closed_at)
    .map((i) => Date.parse(i.closed_at) - Date.parse(i.created_at));
  const n = (k) => cols[k]?.length ?? 0;
  return {
    ...Object.fromEntries(Object.keys(cols).map((k) => [k, n(k)])),
    open: n('ready'),
    // davon freigegeben (phase:<erste Phase>): nur die claimen Worker
    released: (cols.ready || []).filter((i) => (i.labels || []).includes(`phase:${ws.readyPhase}`)).length,
    working: n(ws.readyPhase),
    done24h: n('done'),
    mergedToday: merged.filter((p) => p.mergedAt && today(new Date(p.mergedAt)) === day).length,
    leadMs: lead.length ? Math.round(lead.reduce((a, b) => a + b, 0) / lead.length) : null,
    stale: ws.phases.flatMap((k) => cols[k]).filter((i) => i.stale).length,
  };
}

/** CI-Zustand eines PRs aus statusCheckRollup. */
export function prSummary(pr) {
  const checks = (pr.statusCheckRollup || []).map((c) => {
    const state = c.__typename === 'StatusContext'
      ? String(c.state || '').toUpperCase()
      : c.status !== 'COMPLETED' ? 'PENDING' : String(c.conclusion || '').toUpperCase();
    return { name: c.name || c.context || '?', state, url: c.detailsUrl || c.targetUrl || null };
  });
  const bad = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];
  const ci = !checks.length ? 'none'
    : checks.some((c) => bad.includes(c.state)) ? 'fail'
      : checks.some((c) => ['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', ''].includes(c.state)) ? 'pending'
        : 'pass';
  const { statusCheckRollup, ...rest } = pr;
  return { ...rest, ci, checks: checks.filter((c) => c.state !== 'SKIPPED') };
}

/** Repo-Schlüssel eines Issues: modul:<schlüssel> eines weiteren Repos (BK_REPOS), sonst „.“. */
export function repoOfIssue(issue, repos = []) {
  const labels = issue?.labels || [];
  return repos.find((r) => r.key !== '.' && labels.includes(`modul:${r.key}`))?.key ?? '.';
}

/**
 * Laufende Worker aus `claude agents --json`: Sessions in .claude/worktrees/<rolle>-<n>, mit
 * Workspace. Andere Worktrees (z. B. eine Arbeits-Session) zählen nicht als Worker.
 */
export function parseWorkers(agents, wtDir, workspaces) {
  const prefix = wtDir.endsWith('/') ? wtDir : `${wtDir}/`;
  const re = workerRe(Object.values(workspaces).flatMap((w) => w.roles));
  return (Array.isArray(agents) ? agents : [])
    .filter((a) => typeof a.cwd === 'string' && a.cwd.startsWith(prefix))
    .map((a) => {
      const name = a.cwd.slice(prefix.length).split('/')[0];
      const role = name.replace(/-\d+$/, '');
      return {
        name,
        role,
        ws: wsOfRole(role, workspaces),
        kind: a.kind === 'background' ? 'background' : 'terminal',
        status: a.status || '?',
        session: a.name || null,
        sessionId: a.sessionId || null,
        pid: a.pid ?? null,
        startedAt: a.startedAt ? new Date(a.startedAt).toISOString() : null,
        cwd: a.cwd,
      };
    })
    .filter((w) => re.test(w.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }));
}

const HOST_RE = /^[a-z0-9]{1,20}$/;
// ssh-Ziel wie pc, felix@pc oder pc.tail1234.ts.net, nie eine ssh-Option
const SSH_TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

const LIST_ITEM_RE = /^\s*(?:(\d{1,2})[.)]|[-*•])\s+(.+?)\s*$/;
const DECISION_HEAD_RE = /^\s*(?:\*\*)?(Optionen|Options)(?:\*\*)?\s*:?\s*(?:\*\*)?\s*$/i;
const DECISION_HINT_RE = /(Entscheidung\s+(nötig|gefragt|liegt\s+beim\s+User)|Mögliche\s+(Fixes|Lösungen|Wege)|zur\s+Wahl)/i;

/**
 * Entscheidung in der Beschreibung eines human-Issues: ein Block „Optionen:“ mit nummerierten
 * Zeilen (worker-regeln.md), sonst die Aufzählung direkt nach „Entscheidung nötig“/„Mögliche
 * Fixes“ (mindestens zwei Punkte). `todo`, wenn eine Zeile mit „Zu tun (User)“ beginnt.
 * → { options: [{ key: '1', label }], todo } oder null, wenn beides fehlt.
 */
export function parseDecision(description) {
  const lines = String(description || '').split('\n');
  const todo = lines.some((l) => /^\s*(?:\*\*)?Zu tun \(User\)/i.test(l));
  const listAfter = (start) => {
    const items = [];
    for (let i = start; i < lines.length; i++) {
      const m = LIST_ITEM_RE.exec(lines[i]);
      if (m) items.push(m[2].replace(/\*\*/g, '').trim());
      else if (!lines[i].trim()) { if (items.length) break; }
      else if (items.length && /^\s{2,}\S/.test(lines[i])) items[items.length - 1] += ` ${lines[i].trim()}`;
      else break;
    }
    return items;
  };
  let items = [];
  const head = lines.findIndex((l) => DECISION_HEAD_RE.test(l));
  if (head >= 0) items = listAfter(head + 1);
  if (items.length < 2) {
    // Hinweiszeile („Entscheidung nötig …“), die Aufzählung darunter; die Zeile selbst kann mit „:“ enden
    const hint = lines.findIndex((l) => DECISION_HINT_RE.test(l));
    items = hint >= 0 ? listAfter(hint + 1) : [];
  }
  const options = items.length >= 2 && items.length <= 9 ? items.map((label, k) => ({ key: String(k + 1), label: label.slice(0, 300) })) : [];
  return options.length || todo ? { options, todo } : null;
}

/**
 * Entscheidung eines human-Issues aus Beschreibung und Notes. Gibt ein Worker ein Issue zurück,
 * steht der Block „Optionen:“ oft am Ende der Notes. Gelesen wird nur der Teil nach der letzten
 * „User-Entscheidung“ (ältere Blöcke sind entschieden); Optionen dort gehen vor die der Beschreibung.
 */
export function decisionOf({ description, notes } = {}) {
  const lines = String(notes || '').split('\n');
  let last = -1;
  lines.forEach((l, i) => { if (/^\s*User-Entscheidung\b/.test(l)) last = i; });
  const fromNotes = parseDecision(lines.slice(last + 1).join('\n'));
  const fromDesc = parseDecision(description);
  const options = fromNotes?.options.length ? fromNotes.options : fromDesc?.options || [];
  const todo = Boolean(fromNotes?.todo || fromDesc?.todo);
  return options.length || todo ? { options, todo } : null;
}

/** Tasten, die der Leitstand an eine Rückfrage schicken darf (workers press). */
export const PRESS_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'Escape', 'Enter'];

const OPTION_RE = /^\s*(?:[❯›>]\s*)?([1-9])\.\s+(.+?)\s*$/;
const SEPARATOR_RE = /^\s*[─━╌┄═╭╰]{8,}/;
const unframe = (l) => l.replace(/^\s*[│┃]\s?/, '').replace(/\s*[│┃]\s*$/, '').replace(/\s+$/, '');

/**
 * Rückfrage auf dem Bildschirm eines Workers (Ausgabe von `workers screen`): die letzte
 * nummerierte Auswahl (1., 2., … mit ❯ an der aktuellen), die Frage darüber und deren Kontext bis
 * zur letzten Trennlinie. null, wenn keine Auswahl zu sehen ist.
 */
export function parsePrompt(screen) {
  const lines = String(screen || '').split('\n').map((l) => l.replace(/\s+$/, ''));
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (OPTION_RE.test(lines[i])) { last = i; break; }
  if (last < 0) return null;
  let first = last;
  while (first > 0 && OPTION_RE.exec(lines[first])?.[1] !== '1') first--;
  if (OPTION_RE.exec(lines[first])?.[1] !== '1') return null;
  const options = [];
  for (let i = first; i < lines.length; i++) {
    const m = OPTION_RE.exec(lines[i]);
    if (m) {
      if (Number(m[1]) !== options.length + 1) break;
      options.push({ key: m[1], label: m[2].trim(), selected: /^\s*[❯›>]/.test(lines[i]) });
    } else if (i > last && (!lines[i].trim() || /^\s*Esc to/.test(lines[i]))) {
      break;
    } else if (lines[i].trim() && /^\s{4,}/.test(lines[i]) && options.length) {
      options.at(-1).label += ` ${lines[i].trim()}`;
    } else if (!lines[i].trim()) {
      continue;
    } else {
      break;
    }
  }
  if (options.length < 2) return null;
  // Frage: erste nicht leere Zeile über der Auswahl; Kontext darüber bis zur Trennlinie
  let q = first - 1;
  while (q >= 0 && !unframe(lines[q]).trim()) q--;
  const question = q >= 0 ? unframe(lines[q]).trim() : '';
  const trim = (list) => {
    while (list.length && !list[0].trim()) list.shift();
    while (list.length && !list.at(-1).trim()) list.pop();
    return list;
  };
  const context = [];
  let sep = -1;
  for (let i = q - 1; i >= 0 && context.length < 14; i--) {
    if (SEPARATOR_RE.test(lines[i])) { sep = i; break; }
    context.unshift(unframe(lines[i]));
  }
  // darüber, bis zur nächsten Trennlinie oder Kopfzeile: der Befehl, um den es geht (Ende davon)
  const command = [];
  for (let i = sep - 1; i >= 0 && command.length < 40; i--) {
    if (SEPARATOR_RE.test(lines[i]) || !/^\s*[│┃]/.test(lines[i])) break;
    command.unshift(unframe(lines[i]));
  }
  return { question, options, context: trim(context), command: trim(command).slice(-12) };
}

/**
 * Zwei Rechner (~/.config/beadskit/hosts.conf, Zeilen NAME=wert): Leitrechner, dieser Rechner und
 * je Rechner ssh-Ziel (HOST_<h>_SSH, Standard der Name) und Projektordner (HOST_<h>_ROOT). null
 * ohne LEADER oder SELF: dann gibt es nur diesen Rechner.
 */
export function parseHostsConf(text) {
  const v = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) v[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  if (!HOST_RE.test(v.LEADER || '') || !HOST_RE.test(v.SELF || '')) return null;
  const names = String(v.HOSTS || '').split(/\s+/).filter((h) => HOST_RE.test(h));
  for (const h of [v.LEADER, v.SELF]) if (!names.includes(h)) names.push(h);
  return {
    leader: v.LEADER,
    self: v.SELF,
    hosts: [...new Set(names)].map((name) => {
      const ssh = v[`HOST_${name}_SSH`];
      const root = v[`HOST_${name}_ROOT`];
      return {
        name,
        ssh: SSH_TARGET_RE.test(ssh || '') ? ssh : name,
        root: typeof root === 'string' && root.startsWith('/') ? root.replace(/\/+$/, '') : null,
      };
    }),
  };
}

/** Derselbe Projektordner auf einem anderen Rechner: Präfix tauschen; null, wenn root nicht darunter liegt. */
export function mapRoot(root, from, to) {
  if (typeof root !== 'string' || !from || !to) return null;
  if (root === from) return to;
  return root.startsWith(`${from}/`) ? `${to}${root.slice(from.length)}` : null;
}

/** Ein Wort für die Shell auf der Gegenseite: ssh fügt alle Argumente zu einer Befehlszeile zusammen. */
export function shQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

/**
 * Befehlszeile für ssh: scripts/beadskit/on-host lädt die Umgebung des Rechners (PATH für node, bd,
 * claude), wechselt in den Projektordner und führt <cmd> (relativ zum Projekt) mit den Argumenten aus.
 */
export function remoteCommand(root, cmd, args = []) {
  return [`${root}/scripts/beadskit/on-host`, root, cmd, ...args].map(shQuote).join(' ');
}

// Ein Messwert oder der Fehler (letzte Zeile, gekürzt) eines Rechners oder Servers
async function measure(base, f) {
  try {
    const stats = await f();
    if (!stats || typeof stats !== 'object') throw new Error('keine Werte');
    return { ...base, ok: true, stats };
  } catch (e) {
    return { ...base, ok: false, error: String(e.message || e).trim().split('\n').at(-1).slice(0, 300) };
  }
}

/**
 * Systemwerte je Rechner (sysinfo.mjs): ohne hosts.conf nur dieser, sonst alle; local() misst hier,
 * remote(name) holt die Werte des anderen Rechners. Ein Fehler betrifft nur diesen Rechner.
 * → [{ name, leader, self, ok, error?, stats? }]
 */
export async function collectSystems(conf, { local, remote, self = 'local' }) {
  const hosts = conf ? conf.hosts.map((h) => h.name) : [self];
  return Promise.all(hosts.map((name) => {
    const base = { name, leader: conf ? name === conf.leader : true, self: conf ? name === conf.self : true };
    return measure(base, () => (base.self ? local() : remote(name)));
  }));
}

/**
 * Systemwerte der Server eines Projekts (servers aus beads.leitstand.mjs), server(s) misst per ssh;
 * Server, die wie ein Rechner heißen (skip), fallen weg. key trennt den Verlauf von dem der Rechner.
 * → [{ name, key, kind: 'server', leader, self, ok, error?, stats? }]
 */
export async function collectServers(servers, { server, skip = [] }) {
  return Promise.all((servers || []).filter((s) => !skip.includes(s.name)).map((s) => measure(
    { name: s.name, key: `server:${s.ssh}`, kind: 'server', leader: false, self: false }, () => server(s))));
}

/**
 * Worker aller Rechner in einer Liste: perHost = [{ host, ok, error, leader, self, workers }]. Jeder
 * Worker trägt seinen Rechner, den Workspace bestimmt dieser Leitstand aus der Rolle. Ein Rechner,
 * der nicht antwortet, steht mit Fehler in hosts; die übrigen bleiben.
 */
export function mergeHostWorkers(perHost, workspaces) {
  const workers = [];
  const hosts = [];
  for (const h of Array.isArray(perHost) ? perHost : []) {
    const ok = !!h.ok && Array.isArray(h.workers);
    hosts.push({ name: h.host, ok, error: ok ? null : String(h.error || 'nicht erreichbar').slice(-300), leader: !!h.leader, self: !!h.self });
    if (!ok) continue;
    for (const w of h.workers) {
      if (w && typeof w.name === 'string' && typeof w.role === 'string') workers.push({ ...w, ws: wsOfRole(w.role, workspaces), host: h.host });
    }
  }
  workers.sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }));
  return { workers, hosts };
}

/**
 * Markierungen aus `bd kv list` (zwei Rechner): beadskit.drain, .drain-<rolle>, .drain@<rechner>,
 * .autorestart (Schwelle in Tokens).
 */
export function parseMarkers(kv, roles = [], hosts = []) {
  const o = kv && typeof kv === 'object' ? kv : {};
  const has = (k) => Object.hasOwn(o, `beadskit.${k}`);
  const all = has('drain');
  const n = Number(o['beadskit.autorestart']);
  return {
    drain: {
      all,
      roles: Object.fromEntries(roles.map((r) => [r, all || has(`drain-${r}`)])),
      hosts: Object.fromEntries(hosts.map((h) => [h, has(`drain@${h}`)])),
    },
    threshold: Number.isInteger(n) && n > 0 ? n : null,
  };
}

/**
 * Auf welchen Rechnern eine Worker-Aktion läuft. start/add: der gewählte (Standard dieser),
 * stop --all: alle erreichbaren, stop/restart/send: der, auf dem der Worker läuft, drain und
 * autorestart: dieser (die Markierungen liegen in der gemeinsamen Datenbank). press wie send.
 */
export function routeWorkerAction({ action, name, host }, { hosts = [], self = null, workers = [] } = {}) {
  if (!hosts.length) return [null];
  const names = hosts.map((h) => h.name);
  if (action === 'start' || action === 'add') {
    const h = host ?? self;
    if (!names.includes(h)) throw new Error('unbekannter Rechner');
    return [h];
  }
  if (action === 'stop' && name === 'all') return hosts.filter((h) => h.ok !== false).map((h) => h.name);
  if (['stop', 'restart', 'send', 'press'].includes(action)) {
    const w = workers.find((x) => x.name === name);
    if (!w) throw new Error(`Worker ${name} läuft auf keinem Rechner`);
    return [w.host];
  }
  return [self];
}

/**
 * Worker, die der Auto-Neustart jetzt neu starten soll: idle zwischen zwei Runden, kein Issue in
 * Arbeit, nicht Halter des Merge-Slots, kein Drain, keine wartende Nachricht, Kontext über der
 * Schwelle, seit RESTART_QUIET_MS still und nicht innerhalb des Cooldowns schon versucht.
 * `workers` wie in state() (mit activity und issues). `workers restart` prüft selbst noch einmal.
 */
export function planRestarts(workers, { threshold, slotHolder = null, lastRestart = new Map(), now = Date.now() } = {}) {
  if (!Number.isFinite(threshold) || threshold <= 0) return [];
  return (Array.isArray(workers) ? workers : []).filter((w) => {
    const a = w.activity;
    if (w.status !== 'idle' || w.drained || w.issues?.length || w.name === slotHolder) return false;
    if (!a || !(a.contextTokens > threshold) || a.pending?.length) return false;
    const last = Date.parse(a.lastAt);
    if (!Number.isFinite(last) || now - last < RESTART_QUIET_MS) return false;
    return !(now - (lastRestart.get(w.name) ?? -Infinity) < RESTART_COOLDOWN_MS);
  }).map((w) => w.name);
}

/** Projektpfade aus projects.txt: ein Pfad je Zeile, # und Leerzeilen zählen nicht, ohne Dubletten. */
export function parseProjectList(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const p = line.trim();
    if (!p || p.startsWith('#') || out.includes(p)) continue;
    out.push(p);
  }
  return out;
}

/**
 * Projekte, die der Leitstand lädt: die aus projects.txt, davor das eigene Root, wenn es ein
 * eingerichtetes Projekt ist (mit beads.project.sh). Das Template selbst ist keins und bleibt
 * ohne Warnung draußen, wenn der Leitstand von dort läuft.
 */
export function projectPaths(listed, selfRoot, selfIsProject) {
  return selfRoot && selfIsProject && !listed.includes(selfRoot) ? [selfRoot, ...listed] : listed;
}

/**
 * Prüft die Ausgabe von `workers config` und ergänzt Vorgaben; null bei Unbrauchbarem.
 * Eine Config ohne workspaces (beadskit 1.0) bekommt den Workspace code aus ihren Rollen.
 */
export function normalizeConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || typeof cfg.root !== 'string' || !SLUG_RE.test(cfg.slug || '')) return null;
  const words = (a, re = /^[a-z0-9-]+$/) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && re.test(x)) : []);
  const roles = words(cfg.roles, ROLE_RE);
  const allRoles = roles.length ? roles : DEFAULT_ROLES;
  const phase = (p) => (p && typeof p === 'object' && KEY_RE.test(p.key)
    ? { key: p.key, title: typeof p.title === 'string' && p.title ? p.title : null } : null);
  let workspaces = (Array.isArray(cfg.workspaces) ? cfg.workspaces : [])
    .filter((w) => w && WS_RE.test(w.key))
    .map((w) => ({
      key: w.key,
      name: typeof w.name === 'string' && w.name ? w.name : w.key,
      phases: (Array.isArray(w.phases) ? w.phases : []).map(phase).filter(Boolean),
      roles: words(w.roles, ROLE_RE).filter((r) => allRoles.includes(r)),
    }))
    .filter((w) => w.phases.length && w.roles.length);
  if (!workspaces.some((w) => w.key === 'code')) {
    const rest = new Set(workspaces.flatMap((w) => w.roles));
    workspaces = [{ key: 'code', name: 'Code', phases: ['fix', 'verify', 'merge'].map((key) => ({ key, title: null })),
      roles: allRoles.filter((r) => !rest.has(r)) }, ...workspaces];
  }
  const repos = (Array.isArray(cfg.repos) ? cfg.repos : [])
    .filter((r) => r && typeof r.path === 'string' && (r.key === '.' || KEY_RE.test(r.key)));
  return {
    root: cfg.root,
    name: typeof cfg.name === 'string' && cfg.name ? cfg.name : cfg.slug,
    slug: cfg.slug,
    base: typeof cfg.base === 'string' && cfg.base ? cfg.base : 'main',
    roles: allRoles,
    modules: words(cfg.modules),
    drain: typeof cfg.drain === 'string' ? cfg.drain : null,
    autorestart: typeof cfg.autorestart === 'string' ? cfg.autorestart : null,
    start: cfg.start && typeof cfg.start === 'object' ? cfg.start : {},
    prompts: cfg.prompts && typeof cfg.prompts === 'object' ? cfg.prompts : {},
    colors: cfg.colors && typeof cfg.colors === 'object' ? cfg.colors : {},
    workspaces,
    repos: repos.some((r) => r.key === '.') ? repos : [{ key: '.', path: cfg.root }, ...repos],
    runners: cfg.runners === true,
    // zwei Rechner: Markierungen in bd kv statt in Dateien
    markers: cfg.markers === 'kv' ? 'kv' : 'file',
  };
}

/** Öffentlicher Teil einer Projekt-Config für die Seite (ohne lokale Pfade). */
export function publicConfig(cfg) {
  const { root, drain, autorestart, repos, markers, ...rest } = cfg;
  return { ...rest, repos: repos.map((r) => r.key) };
}

/**
 * Projektdatei beads.leitstand.mjs prüfen: nur bekannte Teile mit passender Form, der Rest fällt
 * weg (mit Hinweis). So kann ein Tippfehler im Projekt den Leitstand nicht umwerfen.
 */
export function normalizeExt(mod, warn = () => {}) {
  const x = mod && typeof mod === 'object' ? (mod.default && typeof mod.default === 'object' ? mod.default : mod) : {};
  const fn = (f) => (typeof f === 'function' ? f : null);
  const actions = (Array.isArray(x.actions) ? x.actions : []).filter((a) => {
    const ok = a && KEY_RE.test(a.key) && typeof a.title === 'string' && fn(a.applies) && fn(a.run);
    if (!ok) warn(`Aktion ${a?.key ?? '?'} ohne key/title/applies/run, ignoriert`);
    return ok;
  });
  const panels = (Array.isArray(x.panels) ? x.panels : []).filter((p) => {
    const ok = p && KEY_RE.test(p.key) && typeof p.title === 'string' && fn(p.items);
    if (!ok) warn(`Liste ${p?.key ?? '?'} ohne key/title/items, ignoriert`);
    return ok;
  });
  const servers = (Array.isArray(x.servers) ? x.servers : []).filter((v) => {
    const units = v?.services ?? [];
    const ok = v && HOST_RE.test(v.name) && SSH_TARGET_RE.test(v.ssh || '')
      && Array.isArray(units) && units.length <= 12 && units.every((u) => UNIT_RE.test(u));
    if (!ok) warn(`Server ${v?.name ?? '?'} ohne gültigen name/ssh/services, ignoriert`);
    return ok;
  }).slice(0, 4).map((v) => ({ name: v.name, ssh: v.ssh, services: [...(v.services || [])] }));
  return {
    workspaces: x.workspaces && typeof x.workspaces === 'object' ? x.workspaces : {},
    card: fn(x.card),
    actions,
    panels,
    servers,
  };
}

const httpUrl = (u) => {
  try {
    const x = new URL(String(u));
    return ['http:', 'https:'].includes(x.protocol) ? x.href : null;
  } catch {
    return null;
  }
};

/**
 * Zusatzangaben einer Karte aus card() der Projektdatei, auf sichere Werte gekürzt: logo (URL),
 * links [{href, text}] (nur http/https), tags [Text], actions [{key, title, primary, disabled}].
 */
export function cardExtras(issue, ext) {
  let c = {};
  try { c = (ext.card && ext.card(issue)) || {}; } catch { c = {}; }
  const links = (Array.isArray(c.links) ? c.links : [])
    .map((l) => ({ href: httpUrl(l?.href), text: str(l?.text).slice(0, 80) }))
    .filter((l) => l.href && l.text).slice(0, 6);
  const tags = (Array.isArray(c.tags) ? c.tags : []).filter((t) => typeof t === 'string' && t).map((t) => t.slice(0, 40)).slice(0, 4);
  const actions = [];
  for (const a of ext.actions) {
    let applies = false;
    try { applies = !!a.applies(issue); } catch { applies = false; }
    if (!applies) continue;
    let disabled = null;
    try { disabled = a.check ? a.check(issue) || null : null; } catch (e) { disabled = e.message; }
    actions.push({ key: a.key, title: a.title, hint: str(a.hint), confirm: str(a.confirm, `${a.title}?`),
      primary: !!a.primary, disabled: disabled ? String(disabled) : null });
  }
  const out = {};
  const logo = httpUrl(c.logo);
  if (logo) out.logo = logo;
  if (links.length) out.links = links;
  if (tags.length) out.tags = tags;
  if (actions.length) out.actions = actions;
  return Object.keys(out).length ? out : null;
}

/**
 * Host-Header muss die eigene Adresse sein (Schutz gegen DNS-Rebinding). Mit `publicUrl`
 * (Fernzugang über den Server-Proxy) zählt auch dessen Host.
 */
export function isOwnHost(headers, port = PORT, publicUrl = PUBLIC_URL) {
  const hosts = [`${HOST}:${port}`, `localhost:${port}`];
  if (publicUrl) hosts.push(new URL(publicUrl).host);
  return hosts.includes(headers.host);
}

/** Pfad der Seite selbst, auch mit Query (?p=…&ws=…). */
export function isPagePath(url) {
  const path = String(url ?? '').split('?')[0];
  return path === '/' || path === '/index.html';
}

/** Prüft, ob ein schreibender Request von der eigenen Seite kommt. */
export function isSameOrigin(headers, port = PORT, publicUrl = PUBLIC_URL) {
  if (headers['x-beads-inbox'] !== '1') return false;
  const allowed = [`http://${HOST}:${port}`, `http://localhost:${port}`];
  if (publicUrl) allowed.push(new URL(publicUrl).origin);
  return allowed.includes(headers.origin);
}

// ---- Login (nur aktiv, wenn eine Token-Datei existiert) ----
// Das Token liegt nur auf dem Mac. Ist zusätzlich ein Passwort gesetzt (leitstand-remote
// password), meldet man sich mit Benutzer und Passwort an, sonst mit dem Token. Nach dem Login
// trägt ein Cookie „<ablauf>.<hmac>“ die Sitzung; Schlüssel ist das Token plus die Passwortzeile.
// Sitzungen überleben Neustarts und werden ungültig, sobald Token oder Passwort wechseln.
export const SESSION_DAYS = 30;
const COOKIE = 'leitstand';
export const LOGIN_USER_RE = /^[a-z][a-z0-9._-]{1,31}$/;
export const PASSWORD_MIN = 12;
const SCRYPT = { N: 1 << 15, r: 8, p: 1 };
// scrypt braucht 128 * N * r Bytes; Node erlaubt ohne maxmem nur 32 MB
const scryptOpts = ({ N, r, p }) => ({ N, r, p, maxmem: 256 * N * r });

/** Passwortzeile „<user>:scrypt$N$r$p$<salt>$<hash>“ (base64url) für die Passwort-Datei. */
export async function hashPassword(user, password, salt = randomBytes(16)) {
  if (!LOGIN_USER_RE.test(String(user))) throw new Error('Benutzername: a–z, 0–9, . _ -, 2–32 Zeichen, erst ein Buchstabe');
  if (typeof password !== 'string' || [...password].length < PASSWORD_MIN) {
    throw new Error(`Passwort: mindestens ${PASSWORD_MIN} Zeichen`);
  }
  const key = await scrypt(password.normalize('NFC'), salt, 32, scryptOpts(SCRYPT));
  return `${user}:scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Liest eine Passwortzeile; null, wenn sie nicht passt (auch bei absurden scrypt-Parametern). */
export function parsePasswordLine(line) {
  const m = String(line ?? '').trim().match(/^([a-z][a-z0-9._-]{1,31}):scrypt\$(\d+)\$(\d+)\$(\d+)\$([\w-]{16,})\$([\w-]{32,})$/);
  if (!m) return null;
  const [N, r, p] = [m[2], m[3], m[4]].map(Number);
  if (N < 2 ** 14 || N > 2 ** 20 || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 4) return null;
  return { user: m[1], N, r, p, salt: Buffer.from(m[5], 'base64url'), key: Buffer.from(m[6], 'base64url') };
}

/** Prüft Benutzer und Passwort; rechnet scrypt auch bei falschem Benutzer (gleiche Laufzeit). */
export async function verifyPassword(entry, user, password) {
  if (!entry || typeof user !== 'string' || typeof password !== 'string' || password.length > 1024) return false;
  const key = await scrypt(password.normalize('NFC'), entry.salt, entry.key.length, scryptOpts(entry));
  const okKey = timingSafeEqual(key, entry.key);
  return safeEqual(user.trim().toLowerCase(), entry.user) && okKey;
}

export function signSession(token, exp) {
  return `${exp}.${createHmac('sha256', token).update(`leitstand:${exp}`).digest('base64url')}`;
}

export function verifySession(token, value, now = Date.now()) {
  if (!token || typeof value !== 'string') return false;
  const [exp, mac] = value.split('.');
  if (!/^\d{10,16}$/.test(exp || '') || !mac || Number(exp) < now) return false;
  return safeEqual(signSession(token, exp), value);
}

/** Vergleich in konstanter Zeit (über die Hashes, damit die Länge nichts verrät). */
export function safeEqual(a, b) {
  const h = (s) => createHash('sha256').update(String(s)).digest();
  return timingSafeEqual(h(a), h(b));
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    // Cookies sind nicht nach Port getrennt: ein fremdes wie „x=50%“ darf nicht jeden Request kippen
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch { /* nicht dekodierbar: ignorieren */ }
  }
  return out;
}

// Chunks erst als Bytes sammeln: ein Mehrbytezeichen (ä, „) kann auf zwei Chunks verteilt sein
export async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('zu groß'), { code: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('kein JSON'), { code: 400 });
  }
}

/**
 * Fehlversuche bremsen. Je Client-IP (von nginx als X-Real-IP gesetzt): ab `perIp` Fehlversuchen
 * im Fenster ist die IP bis zum Ablauf des ältesten gesperrt. Zusätzlich global: ab `global`
 * Fehlversuchen wartet jeder Versuch `delayMs` (verteilte Angriffe), ohne jemanden auszusperren.
 * Ohne X-Real-IP (direkt am Mac oder ein Prozess auf dem Server am Tunnel-Port) gibt es keine
 * Sperre, nur die globale Bremse; sonst könnte ein Fremder am Tunnel den User aussperren.
 */
export function loginGuard({ perIp = 5, windowMs = 15 * 60_000, global = 20, delayMs = 3000, maxIps = 10_000 } = {}) {
  const byIp = new Map();
  const all = [];
  const prune = (arr, now) => { while (arr.length && arr[0] <= now - windowMs) arr.shift(); };
  return {
    /** Millisekunden, die diese IP noch gesperrt ist; 0 = darf. */
    blockedFor(ip, now = Date.now()) {
      const a = ip && byIp.get(ip);
      if (!a) return 0;
      prune(a, now);
      if (!a.length) { byIp.delete(ip); return 0; }
      return a.length >= perIp ? a[0] + windowMs - now : 0;
    },
    delay(now = Date.now()) {
      prune(all, now);
      return all.length >= global ? delayMs : 0;
    },
    fail(ip, now = Date.now()) {
      all.push(now);
      if (all.length > global) all.shift();  // mehr als global braucht delay() nicht
      if (!ip) return;
      if (!byIp.has(ip) && byIp.size >= maxIps) byIp.delete(byIp.keys().next().value);
      const a = byIp.get(ip) || [];
      a.push(now);
      if (a.length > perIp) a.shift();
      byIp.set(ip, a);
    },
    ok(ip) { if (ip) byIp.delete(ip); },
  };
}

/** Client-IP für die Sperre: nur X-Real-IP von nginx (Verbindung über den Tunnel), sonst null. */
export function clientIp(req) {
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress);
  const ip = String(req.headers?.['x-real-ip'] ?? '').trim();
  return local && /^[0-9a-f.:]{3,45}$/i.test(ip) ? ip : null;
}

async function json(cmd, args, cwd, env) {
  try {
    const { stdout } = await run(cmd, args, { cwd, env, maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
    return JSON.parse(stdout || 'null');
  } catch {
    return null;
  }
}

const exists = (p) => access(p).then(() => true, () => false);
// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g, '');
const cmdOutput = (e) => stripAnsi(`${e.stdout || ''}${e.stderr || ''}`).trim() || e.message;

/** Chatverlauf eines Workers dieses Rechners aus dem Ende seines Transkripts (die api-request-Blobs sind groß). */
export async function workerChatOf(w) {
  const file = transcriptPath(w.cwd, w.sessionId);
  const entries = file ? chatTranscript(await readTail(file, 8 * 1024 * 1024), { cwd: w.cwd, limit: 250 }) : [];
  return { name: w.name, kind: w.kind, status: w.status, sessionId: w.sessionId, entries };
}

/** Ausführliche Aktivität eines Workers dieses Rechners, bei Hintergrund-Workern dazu `claude logs`. */
export async function workerDetailOf(w, root) {
  const activity = await sessionSummary(w, { bytes: 1024 * 1024, toolLimit: 80, textLimit: 4000 });
  let logs = null;
  if (w.kind === 'background' && w.session) {
    try {
      const { stdout } = await run('claude', ['logs', w.session], { cwd: root, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
      logs = stripAnsi(stdout).slice(-20_000);
    } catch (e) {
      logs = `claude logs fehlgeschlagen: ${(e.stderr || e.message || '').trim()}`;
    }
  }
  return { ...w, activity, logs };
}

/** Worker dieses Rechners mit Kurzfassung ihrer Aktivität; null, wenn `claude agents` nicht antwortet. */
export async function localWorkers(root, workspaces) {
  const agents = await json('claude', ['agents', '--json'], root);
  if (!agents) return null;
  return Promise.all(parseWorkers(agents, join(root, '.claude/worktrees'), workspaces)
    .map(async (w) => ({ ...w, activity: await sessionSummary(w) })));
}

// ssh ohne Rückfrage, kurzer Verbindungsaufbau, eine gemeinsame Verbindung je Rechner (das Board
// fragt alle paar Sekunden)
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=10',
  '-o', 'ControlMaster=auto', '-o', 'ControlPersist=10m', '-o', `ControlPath=${join(homedir(), '.ssh', 'bk-%C')}`];

const loginHtml = (password) => `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="apple-mobile-web-app-capable" content="yes">
<title>Leitstand</title><style>
:root{--bg:#f6f6f3;--panel:#fff;--ink:#1d1d1b;--muted:#6b6b66;--line:#e2e1db;--accent:#c2410c;--bad:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--panel:#1f1f1c;--ink:#ecebe6;--muted:#9a998f;--line:#34332e;--accent:#f97316;--bad:#ef4444}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,system-ui,sans-serif;padding:16px}
form{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px;width:min(380px,100%);display:grid;gap:12px}
h1{font-size:19px;margin:0}input{font:inherit;font-size:16px;padding:10px 11px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink)}
button{font:inherit;font-weight:600;padding:9px;border-radius:8px;border:0;background:var(--accent);color:#fff;cursor:pointer}
p{margin:0;color:var(--muted);font-size:13px}.bad{color:var(--bad)}</style></head>
<body><form id="f"><h1>Leitstand</h1>
${password
    ? `<input type="text" name="user" placeholder="Benutzer" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
<input type="password" name="password" placeholder="Passwort" autocomplete="current-password" required>
<button>Anmelden</button><p id="m">Passwort ändern: <code>scripts/beadskit/leitstand/leitstand-remote password</code> auf dem Rechner des Leitstands.</p>`
    : `<input type="text" name="username" value="leitstand" autocomplete="username" hidden>
<input type="password" name="token" placeholder="Zugangs-Token" autocomplete="current-password" required autofocus>
<button>Anmelden</button><p id="m">Token: <code>scripts/beadskit/leitstand/leitstand-remote token</code> auf dem Rechner des Leitstands.</p>`}</form>
<script>
document.getElementById('f').onsubmit = async (e) => {
  e.preventDefault();
  const m = document.getElementById('m');
  const r = await fetch('/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Beads-Inbox': '1' },
    body: JSON.stringify(e.target.token ? { token: e.target.token.value }
      : { user: e.target.user.value, password: e.target.password.value }) });
  if (r.ok) { location.href = '/'; return; }
  const res = await r.json().catch(() => ({}));
  m.className = 'bad'; m.textContent = res.error || 'Anmeldung fehlgeschlagen';
};
</script></body></html>`;

async function loadToken() {
  const file = process.env.LEITSTAND_TOKEN_FILE || join(CONF_DIR, 'leitstand-token');
  try {
    const t = (await readFile(file, 'utf8')).trim();
    if (t.length < 32) throw new Error(`Token in ${file} zu kurz (mind. 32 Zeichen)`);
    return t;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/** Repo-Wurzel, aus der dieser Leitstand läuft (zählt immer als Projekt). */
async function ownRoot() {
  try {
    const { stdout } = await run('git', ['-C', HERE, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    return dirname(stdout.trim());
  } catch {
    return null;
  }
}

/**
 * Projekte mit ihrer Config, kurz zwischengespeichert. Ein Projekt ohne beadskit oder mit
 * kaputter beads.project.sh fehlt einfach (Hinweis im Log), statt den Leitstand zu stören.
 * Dazu je Projekt die Erweiterungen aus beads.leitstand.mjs (neu geladen, wenn sich die Datei
 * ändert) und die daraus gebauten Workspaces.
 */
function projectRegistry(selfRoot) {
  let cache = null;
  let at = 0;
  const warned = new Set();
  const warnOnce = (msg) => { if (!warned.has(msg)) { warned.add(msg); console.warn(`Leitstand: ${msg}`); } };
  const extCache = new Map();
  async function loadExt(root) {
    const file = join(root, 'beads.leitstand.mjs');
    let mtime;
    try { mtime = (await stat(file)).mtimeMs; } catch { return normalizeExt({}); }
    const hit = extCache.get(file);
    if (hit?.mtime === mtime) return hit.ext;
    let ext;
    try {
      ext = normalizeExt(await import(`${pathToFileURL(file).href}?v=${mtime}`), (m) => warnOnce(`${file}: ${m}`));
    } catch (e) {
      warnOnce(`${file} nicht ladbar (${e.message}), ohne Erweiterungen`);
      ext = normalizeExt({});
    }
    extCache.set(file, { mtime, ext });
    return ext;
  }
  async function load() {
    let paths = [];
    try { paths = parseProjectList(await readFile(join(CONF_DIR, 'projects.txt'), 'utf8')); } catch { /* noch keine Liste */ }
    paths = projectPaths(paths, selfRoot, !!selfRoot && (await exists(join(selfRoot, 'beads.project.sh'))));
    const list = [];
    for (const root of paths) {
      const cmd = join(root, 'scripts/beadskit/workers');
      const cfg = (await exists(cmd)) ? normalizeConfig(await json(cmd, ['config'], root)) : null;
      if (!cfg) {
        warnOnce(`${root} übersprungen (kein beadskit oder beads.project.sh fehlerhaft)`);
        continue;
      }
      if (list.some((p) => p.slug === cfg.slug)) {
        warnOnce(`Slug ${cfg.slug} doppelt, ${root} übersprungen`);
        continue;
      }
      list.push(cfg);
    }
    return list;
  }
  return {
    async all() {
      if (!cache || Date.now() - at > CONFIG_TTL_MS) {
        cache = await load();
        at = Date.now();
      }
      return cache;
    },
    async get(slug) {
      const cfg = (await this.all()).find((p) => p.slug === slug);
      if (!cfg) return null;
      const ext = await loadExt(cfg.root);
      return { cfg, ext, workspaces: buildWorkspaces(cfg, ext) };
    },
  };
}

function startServer(token, selfRoot) {
  const passwordFile = process.env.LEITSTAND_PASSWORD_FILE || join(CONF_DIR, 'leitstand-password');
  // bei jedem Request gelesen: ein neues Passwort gilt sofort und meldet alte Sitzungen ab
  async function loadPassword() {
    try {
      const line = (await readFile(passwordFile, 'utf8')).trim();
      const entry = parsePasswordLine(line);
      if (!entry) console.warn(`Leitstand: Passwort-Datei ${passwordFile} unlesbar, Token-Login aktiv`);
      return entry ? { line, entry } : null;
    } catch {
      return null;
    }
  }
  const limiter = loginGuard();
  const publicHost = PUBLIC_URL ? new URL(PUBLIC_URL).host : null;
  const env = { ...process.env, BEADS_ACTOR: ACTOR };
  const projects = projectRegistry(selfRoot);
  // Auto-Neustart je Projekt: letzter Versuch je Worker (für den Cooldown) und die letzten Ergebnisse
  const restartState = new Map();
  const restartsOf = (slug) => {
    if (!restartState.has(slug)) restartState.set(slug, { last: new Map(), recent: [] });
    return restartState.get(slug);
  };

  // Werkzeuge eines Projekts
  function tools(cfg) {
    const root = cfg.root;
    const bdw = join(root, 'scripts/beadskit/bdw');
    return {
      root,
      bdw,
      workersCmd: join(root, 'scripts/beadskit/workers'),
      runnerCmd: join(root, 'scripts/beadskit/ci/runner-pool'),
      wtDir: join(root, '.claude/worktrees'),
      bd: (args) => json(bdw, [...args, '--json'], root, env),
    };
  }

  // Zwei Rechner: hosts.conf, kurz zwischengespeichert; null bei einem Rechner
  let hostsCache = { at: 0, conf: null };
  async function hostsConf() {
    if (Date.now() - hostsCache.at > CONFIG_TTL_MS) {
      let conf = null;
      try { conf = parseHostsConf(await readFile(join(CONF_DIR, 'hosts.conf'), 'utf8')); } catch { /* ein Rechner */ }
      hostsCache = { at: Date.now(), conf };
    }
    return hostsCache.conf;
  }

  /**
   * Führt <cmd> (relativ zum Projekt) auf einem Rechner aus: hier direkt, sonst per ssh über on-host
   * im selben Projekt auf dem anderen Rechner (Ordner über HOST_<h>_ROOT umgerechnet).
   */
  async function onHost(conf, host, root, cmd, args, { timeout = 30_000 } = {}) {
    const opts = { timeout, maxBuffer: 64 * 1024 * 1024 };
    if (!conf || !host || host === conf.self) return run(join(root, cmd), args, { cwd: root, ...opts });
    const self = conf.hosts.find((h) => h.name === conf.self);
    const h = conf.hosts.find((x) => x.name === host);
    if (!h) throw new Error(`unbekannter Rechner ${host}`);
    const there = mapRoot(root, self?.root, h.root);
    if (!there) throw new Error(`${root} liegt nicht unter HOST_${conf.self}_ROOT, Ordner auf ${host} unbekannt (hosts.conf)`);
    return run('ssh', [...SSH_OPTS, h.ssh, remoteCommand(there, cmd, args)], opts);
  }

  // Worker je Rechner; die anderen Rechner liefern über host-agent.mjs (5 s zwischengespeichert)
  const remoteCache = new Map();
  async function hostWorkers(p, conf) {
    if (!conf) {
      const workers = await localWorkers(p.cfg.root, p.workspaces);
      return [{ host: 'local', self: true, leader: true, ok: !!workers, error: workers ? null : 'claude agents', workers }];
    }
    return Promise.all(conf.hosts.map(async (h) => {
      const base = { host: h.name, self: h.name === conf.self, leader: h.name === conf.leader };
      if (base.self) {
        const workers = await localWorkers(p.cfg.root, p.workspaces);
        return { ...base, ok: !!workers, error: workers ? null : 'claude agents', workers };
      }
      const key = `${h.name}:${p.cfg.slug}`;
      const hit = remoteCache.get(key);
      if (hit && Date.now() - hit.at < 5_000) return hit.value;
      let value;
      try {
        const { stdout } = await onHost(conf, h.name, p.cfg.root, 'scripts/beadskit/leitstand/host-agent.mjs', ['workers'], { timeout: 15_000 });
        value = { ...base, ok: true, workers: JSON.parse(stdout) };
      } catch (e) {
        value = { ...base, ok: false, error: e.code === 'ETIMEDOUT' || e.killed ? 'keine Antwort' : cmdOutput(e) };
      }
      remoteCache.set(key, { at: Date.now(), value });
      return value;
    }));
  }

  // Systemwerte aller Rechner und der Server des Projekts mit Verlauf (Tab System). Je Teil 2 s
  // zwischengespeichert (Rechner gemeinsam für alle Projekte, Server je Liste), damit mehrere
  // offene Seiten nicht mehrfach messen und der Verlauf keine doppelten Punkte bekommt.
  const sysHistory = new Map();
  const sysCache = new Map();
  function sysCached(key, f) {
    const hit = sysCache.get(key);
    if (hit && Date.now() - hit.at < 2_000) return hit.value;
    const value = f().then((list) => list.map((x) => pushHistory(sysHistory, x)));
    sysCache.set(key, { at: Date.now(), value });
    return value;
  }
  const sshError = (e) => new Error(e.code === 'ETIMEDOUT' || e.killed ? 'keine Antwort' : cmdOutput(e));
  async function systems(root, servers = []) {
    const conf = await hostsConf();
    const [hosts, srv] = await Promise.all([
      sysCached('hosts', () => collectSystems(conf, {
        self: hostname().split('.')[0],
        local: systemStats,
        remote: async (host) => {
          try {
            const { stdout } = await onHost(conf, host, root, 'scripts/beadskit/leitstand/host-agent.mjs', ['system'], { timeout: 15_000 });
            return JSON.parse(stdout);
          } catch (e) {
            throw sshError(e);
          }
        },
      })),
      servers.length ? sysCached(`servers:${JSON.stringify(servers)}`, () => collectServers(servers, {
        skip: conf ? conf.hosts.map((h) => h.name) : [hostname().split('.')[0]],
        server: async (s) => {
          try {
            const { stdout } = await run('ssh', [...SSH_OPTS, s.ssh, serverCommand(s.services)], { timeout: 15_000 });
            return parseServerStats(stdout);
          } catch (e) {
            throw sshError(e);
          }
        },
      })) : [],
    ]);
    return { at: new Date().toISOString(), systems: [...hosts, ...srv] };
  }

  // Drain-Markierungen und Schwelle des Auto-Neustarts (null wenn aus): Dateien oder bd kv
  async function markers(cfg, conf) {
    if (cfg.markers === 'kv') {
      const kv = await tools(cfg).bd(['kv', 'list']);
      return parseMarkers(kv, cfg.roles, conf ? conf.hosts.map((h) => h.name) : []);
    }
    const all = cfg.drain ? await exists(cfg.drain) : false;
    const roles = {};
    for (const r of cfg.roles) roles[r] = all || (cfg.drain ? await exists(`${cfg.drain}-${r}`) : false);
    let threshold = null;
    try {
      const n = cfg.autorestart ? Number((await readFile(cfg.autorestart, 'utf8')).trim()) : NaN;
      if (Number.isInteger(n) && n > 0) threshold = n;
    } catch { /* aus */ }
    return { drain: { all, roles, hosts: {} }, threshold };
  }

  async function projectList() {
    return Promise.all((await projects.all()).map(async (cfg) => {
      const human = await tools(cfg).bd(['list', '-l', 'human', '-n', '0']);
      const waiting = Array.isArray(human) ? human.filter((i) => !['closed', 'deferred'].includes(i.status)).length : null;
      return { ...publicConfig(cfg), human: waiting };
    }));
  }

  // Worker aller Rechner mit Drain und ihren Issues in Arbeit
  const withIssues = (p, perHost, issues, drain) => {
    const { workers, hosts } = mergeHostWorkers(perHost, p.workspaces);
    return {
      hosts,
      workers: workers.map((w) => ({
        ...w,
        drained: !!drain.roles[w.role] || !!drain.hosts?.[w.host],
        issues: issues.filter((i) => i.assignee === w.name && i.status === 'in_progress')
          .map((i) => ({ id: i.id, title: i.title, pr: i.metadata?.pr ?? null, repo: repoOfIssue(i, p.cfg.repos) })),
      })),
    };
  };

  // Eine Runde Auto-Neustart eines Projekts; ohne vollständige Lage (beads, Slot, Agents) wird nichts angefasst
  async function autoRestartTick(p) {
    const conf = await hostsConf();
    const { threshold, drain } = await markers(p.cfg, conf);
    if (!threshold) return;
    const { root, bd } = tools(p.cfg);
    const [issues, slot, perHost] = await Promise.all([
      bd(['list', '--status', 'in_progress']), bd(['merge-slot', 'check']), hostWorkers(p, conf),
    ]);
    // Worker eines Rechners, der nicht antwortet, fehlen einfach; die übrigen gehen weiter
    if (!issues || !slot) return;
    const rs = restartsOf(p.cfg.slug);
    const { workers } = withIssues(p, perHost, issues, drain);
    for (const name of planRestarts(workers, { threshold, slotHolder: slot.holder || null, lastRestart: rs.last })) {
      rs.last.set(name, Date.now());
      const w = workers.find((x) => x.name === name);
      const tokens = w?.activity?.contextTokens;
      let ok = true;
      let output;
      try {
        const r = await onHost(conf, w?.host, root, 'scripts/beadskit/workers', ['restart', name], { timeout: 120_000 });
        output = stripAnsi(`${r.stdout}${r.stderr}`).trim();
      } catch (e) {
        ok = false;
        output = cmdOutput(e);
      }
      console.log(`Auto-Neustart ${p.cfg.slug}/${name} (${Math.round((tokens || 0) / 1000)}k Tokens): ${ok ? 'ok' : 'verweigert'} – ${output}`);
      rs.recent.unshift({ name, at: new Date().toISOString(), tokens: tokens ?? null, ok, output: output.slice(-300) });
      rs.recent.length = Math.min(rs.recent.length, 10);
    }
  }

  // PRs aller Repos des Projekts; jeder PR trägt den Schlüssel seines Repos
  async function pullRequests(cfg) {
    const lists = await Promise.all(cfg.repos.map(async (r) => {
      const [open, merged] = await Promise.all([
        json('gh', ['pr', 'list', '--state', 'open', '--json',
          'number,title,url,mergeable,headRefName,baseRefName,isDraft,createdAt,additions,deletions,statusCheckRollup'], r.path),
        json('gh', ['pr', 'list', '--state', 'merged', '--limit', '30', '--json', 'number,title,url,mergedAt,headRefName'], r.path),
      ]);
      const tag = (list) => (Array.isArray(list) ? list.map((x) => ({ ...x, repo: r.key })) : null);
      return { open: tag(open), merged: tag(merged) };
    }));
    const ok = lists.every((l) => l.open);
    return {
      prs: lists.flatMap((l) => l.open || []).map(prSummary),
      merged: lists.flatMap((l) => l.merged || []).sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt))),
      ok,
    };
  }

  async function state(p, wsName = 'code') {
    const { cfg, ext, workspaces } = p;
    const ws = workspaces[wsName];
    const { bd } = tools(cfg);
    const conf = await hostsConf();
    const [issues, slot, perHost, pr, { drain, threshold }] = await Promise.all([
      bd(['list', '--all', '-n', '0']),
      bd(['merge-slot', 'check']),
      hostWorkers(p, conf),
      ws.prs ? pullRequests(cfg) : Promise.resolve({ prs: [], merged: [], ok: true }),
      markers(cfg, conf),
    ]);
    const now = Date.now();
    const columns = groupIssues(issues || [], ws, workspaces, now);
    const byId = new Map((issues || []).map((i) => [i.id, i]));
    for (const list of Object.values(columns)) {
      for (const it of list) {
        const waits = waitsOf(it, byId);
        if (waits.length) it.waits = waits;
        const x = cardExtras(it, ext);
        if (x) it.x = x;
        if (it.metadata?.pr) it.pr_repo = repoOfIssue(it, cfg.repos);
        if ((it.labels || []).includes('human')) {
          const d = decisionOf(it);
          if (d) it.decision = d;
        }
      }
    }
    // Claims aller Workspaces: die Worker-Karten zeigen auch Worker des anderen Workspaces
    const live = (issues || []).filter((i) => isBoardIssue(i) && i.status === 'in_progress');
    const { workers, hosts } = withIssues(p, perHost, live, drain);
    // Rückfragen: Bildschirm der wartenden Terminal-Worker auf ihrem Rechner lesen
    await Promise.all(workers.filter((w) => w.status === 'waiting' && w.kind === 'terminal').map(async (w) => {
      w.ask = await askOf(p, conf, w);
    }));
    // offene Entscheidungen je Workspace, für den Umschalter
    const attention = Object.fromEntries(Object.keys(workspaces).map((w) => [w, 0]));
    for (const i of issues || []) {
      if (isBoardIssue(i) && (i.labels || []).includes('human') && !['closed', 'deferred'].includes(i.status)) attention[wsOfIssue(i, workspaces)] += 1;
    }
    for (const w of workers) if (w.ask && Object.hasOwn(attention, w.ws)) attention[w.ws] += 1;
    const panels = [];
    for (const panel of ext.panels.filter((x) => !x.ws || x.ws === ws.name)) {
      let items = [];
      try { items = panel.items(issues || [], now) || []; } catch (e) { console.warn(`Leitstand: Liste ${panel.key}: ${e.message}`); }
      panels.push({
        key: panel.key,
        title: panel.title,
        sub: str(panel.sub),
        items: (Array.isArray(items) ? items : []).slice(0, 50).map((i) => ({
          id: ID_RE.test(i?.id) ? i.id : null,
          title: str(i?.title).slice(0, 200),
          text: str(i?.text).slice(0, 200),
          href: httpUrl(i?.href),
          linkText: str(i?.linkText).slice(0, 60),
          at: str(i?.at, null),
        })),
      });
    }
    return {
      project: publicConfig(cfg),
      workspace: ws.name,
      workspaces,
      attention,
      columns,
      panels,
      metrics: metrics(columns, ws, pr.merged, now),
      slot: slot ? { available: !!slot.available, holder: slot.holder || null,
        host: workers.find((w) => w.name === slot.holder)?.host ?? null } : null,
      drain,
      autorestart: { threshold, recent: restartsOf(cfg.slug).recent.slice(0, 5) },
      workers,
      // zwei Rechner: Name, erreichbar, Leitrechner, dieser; leer bei einem Rechner
      hosts: conf ? hosts : [],
      prs: pr.prs,
      merged: pr.merged.slice(0, 10),
      auth: !!token,
      errors: [issues ? null : 'beads', pr.ok ? null : 'gh',
        ...hosts.filter((h) => !h.ok).map((h) => (conf ? `Rechner ${h.name}: ${h.error}` : h.error))].filter(Boolean),
      at: new Date().toISOString(),
    };
  }

  // Rückfrage eines wartenden Workers: erkannte Auswahl oder die letzten Bildschirmzeilen; 2 s je Worker
  const askCache = new Map();
  async function askOf(p, conf, w) {
    const key = `${p.cfg.slug}/${w.host}/${w.name}`;
    const hit = askCache.get(key);
    if (hit && Date.now() - hit.at < 2_000) return hit.value;
    let value = null;
    try {
      const { stdout } = await onHost(conf, w.host, p.cfg.root, 'scripts/beadskit/workers', ['screen', w.name, '--lines', '40'], { timeout: 10_000 });
      const prompt = parsePrompt(stdout);
      value = prompt || { question: null, options: [], context: [], screen: stdout.split('\n').slice(-14) };
    } catch { /* Terminal nicht lesbar: nur der Status „waiting“ */ }
    askCache.set(key, { at: Date.now(), value });
    return value;
  }

  // Worker auf irgendeinem Rechner; null, wenn er nirgends läuft
  async function findWorker(p, name) {
    const conf = await hostsConf();
    return mergeHostWorkers(await hostWorkers(p, conf), p.workspaces).workers.find((x) => x.name === name) || null;
  }

  // Chat bzw. Detail: auf diesem Rechner direkt, sonst über host-agent.mjs dort
  async function workerView(p, name, what) {
    const w = await findWorker(p, name);
    if (!w) return null;
    const conf = await hostsConf();
    if (!conf || w.host === conf.self) return what === 'chat' ? workerChatOf(w) : workerDetailOf(w, p.cfg.root);
    const { stdout } = await onHost(conf, w.host, p.cfg.root, 'scripts/beadskit/leitstand/host-agent.mjs', [what, name], { timeout: 20_000 });
    const out = JSON.parse(stdout);
    return out ? { ...out, host: w.host } : null;
  }

  const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
    res.writeHead(code, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "frame-ancestors 'self'",
      ...extra,
    });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  // Login-Routen; liefert true, wenn der Request damit erledigt ist
  async function handleAuth(req, res, path) {
    if (!token) return false;
    const pw = await loadPassword();
    const key = pw ? `${token}\n${pw.line}` : token;
    const secure = publicHost && req.headers.host === publicHost ? '; Secure' : '';
    if (path === '/login' && req.method === 'GET') {
      send(res, 200, loginHtml(!!pw), 'text/html; charset=utf-8');
      return true;
    }
    if (path === '/login' && req.method === 'POST') {
      if (!isSameOrigin(req.headers)) return send(res, 403, { error: 'nur von der Leitstand-Seite' }), true;
      const ip = clientIp(req);
      const blocked = limiter.blockedFor(ip);
      if (blocked) {
        return send(res, 429, { error: `Zu viele Fehlversuche, wieder in ${Math.ceil(blocked / 60_000)} min` },
          undefined, { 'Retry-After': String(Math.ceil(blocked / 1000)) }), true;
      }
      const wait = limiter.delay();
      if (wait) await new Promise((r) => setTimeout(r, wait));
      let body;
      try { body = await readBody(req); } catch (e) { return send(res, e.code || 400, { error: e.message }), true; }
      const ok = pw
        ? await verifyPassword(pw.entry, body.user, body.password)
        : typeof body.token === 'string' && safeEqual(body.token.trim(), token);
      if (!ok) {
        limiter.fail(ip);
        console.warn(`Leitstand: fehlgeschlagener Login ${new Date().toISOString()}${ip ? ` von ${ip}` : ''}`);
        return send(res, 401, { error: pw ? 'Benutzer oder Passwort falsch' : 'Token falsch' }), true;
      }
      limiter.ok(ip);
      const exp = Date.now() + SESSION_DAYS * 86_400_000;
      send(res, 200, { ok: true }, undefined, {
        'Set-Cookie': `${COOKIE}=${signSession(key, exp)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure}`,
      });
      return true;
    }
    if (path === '/logout' && req.method === 'POST') {
      if (!isSameOrigin(req.headers)) return send(res, 403, { error: 'nur von der Leitstand-Seite' }), true;
      send(res, 200, { ok: true }, undefined, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}` });
      return true;
    }
    if (verifySession(key, parseCookies(req.headers.cookie)[COOKIE])) return false;
    if (req.method === 'GET' && isPagePath(path)) {
      res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
      res.end();
    } else {
      send(res, 401, { error: 'nicht angemeldet' });
    }
    return true;
  }

  // Führt die bdw-Schritte nacheinander aus; bricht beim ersten Fehler ab
  async function runSteps(res, t, steps) {
    let out = '';
    for (const args of steps) {
      try {
        const r = await run(t.bdw, args, { cwd: t.root, env, timeout: 30_000 });
        out += r.stdout;
      } catch (e) {
        return send(res, 500, { error: `bdw ${args[0]} fehlgeschlagen: ${(e.stderr || e.message).trim()}` });
      }
    }
    return send(res, 200, { ok: true, output: out.trim() });
  }

  async function showIssue(t, id) {
    const shown = await t.bd(['show', id]);
    return (Array.isArray(shown) ? shown[0] : shown) || null;
  }

  // Gemeinsamer CI-Runner-Pool, unabhängig vom gewählten Projekt: Status, Log und Steuerung über
  // ci/runner-pool des ersten Projekts mit runners (alle sprechen denselben Dienst auf dem Server an).
  // Eigene Route: ssh zum Server dauert, ein Fehler soll das Board nicht stören.
  async function pool(req, res, path) {
    const list = await projects.all();
    const own = list.find((c) => c.runners);
    if (!own) return send(res, 404, { error: 'kein Projekt mit CI-Runner-Pool' });
    const t = tools(own);
    if (req.method === 'GET' && path === '/api/pool') {
      try {
        const { stdout } = await run(t.runnerCmd, ['status', '--json'], { cwd: t.root, timeout: 30_000 });
        return send(res, 200, {
          ...parsePool(JSON.parse(stdout)),
          // Label → Projektname für die Anzeige; Label ist BK_SLUG (ohne eigenes RUNNER_LABEL)
          names: Object.fromEntries(list.map((c) => [c.slug, c.name])),
          at: new Date().toISOString(),
        });
      } catch (e) {
        const msg = stripAnsi(`${e.stderr || ''}`).trim() || e.message;
        return send(res, 502, { error: `Runner-Status nicht lesbar: ${msg}` });
      }
    }
    if (req.method === 'GET' && path === '/api/pool/logs') {
      try {
        const r = await run(t.runnerCmd, ['logs'], { cwd: t.root, timeout: 30_000 });
        return send(res, 200, { output: stripAnsi(r.stdout).trim() });
      } catch (e) {
        return send(res, 502, { error: cmdOutput(e) });
      }
    }
    if (req.method !== 'POST' || path !== '/api/pool') return send(res, 404, { error: 'nicht gefunden' });
    if (!isSameOrigin(req.headers)) return send(res, 403, { error: 'nur von der Leitstand-Seite' });
    let args;
    try { args = planRunnerAction(await readBody(req)); } catch (e) { return send(res, e.code || 400, { error: e.message }); }
    try {
      const r = await run(t.runnerCmd, args, { cwd: t.root, timeout: 60_000 });
      return send(res, 200, { ok: true, output: stripAnsi(`${r.stdout}${r.stderr}`).trim() });
    } catch (e) {
      return send(res, 409, { error: cmdOutput(e) });
    }
  }

  const server = createServer(async (req, res) => {
    try {
      if (!isOwnHost(req.headers)) return send(res, 403, { error: 'falscher Host' });
      const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
      const path = url.pathname;
      if (await handleAuth(req, res, path)) return;
      if (req.method === 'GET' && isPagePath(path)) {
        return send(res, 200, await readFile(join(HERE, 'inbox.html'), 'utf8'), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && path === '/api/projects') return send(res, 200, await projectList());
      if (path === '/api/pool' || path === '/api/pool/logs') return await pool(req, res, path);

      // Alles Weitere gehört zu einem Projekt
      const slug = url.searchParams.get('p') || '';
      const p = SLUG_RE.test(slug) ? await projects.get(slug) : null;
      if (!p) return send(res, 404, { error: `unbekanntes Projekt: ${slug || '–'}` });
      const { cfg, ext, workspaces } = p;
      const t = tools(cfg);

      if (req.method === 'GET' && path === '/api/state') {
        const ws = url.searchParams.get('ws') || 'code';
        if (!Object.hasOwn(workspaces, ws)) return send(res, 400, { error: 'unbekannter Workspace' });
        return send(res, 200, await state(p, ws));
      }
      if (req.method === 'GET' && path.startsWith('/api/issue/')) {
        const id = decodeURIComponent(path.slice('/api/issue/'.length));
        if (!ID_RE.test(id)) return send(res, 400, { error: 'ungültige Issue-ID' });
        const it = await showIssue(t, id);
        if (!it) return send(res, 404, { error: 'nicht gefunden' });
        const x = cardExtras(it, ext);
        return send(res, 200, { ...it, ws: wsOfIssue(it, workspaces), pr_repo: repoOfIssue(it, cfg.repos), ...(x ? { x } : {}) });
      }
      const re = workerRe(cfg.roles);
      if (req.method === 'GET' && path.startsWith('/api/worker/') && path.endsWith('/chat')) {
        const name = decodeURIComponent(path.slice('/api/worker/'.length, -'/chat'.length));
        if (!re.test(name)) return send(res, 400, { error: 'unbekannter Worker' });
        const c = await workerView(p, name, 'chat');
        return c ? send(res, 200, c) : send(res, 404, { error: 'Worker läuft nicht' });
      }
      if (req.method === 'GET' && path.startsWith('/api/worker/')) {
        const name = decodeURIComponent(path.slice('/api/worker/'.length));
        if (!re.test(name)) return send(res, 400, { error: 'unbekannter Worker' });
        const data = await workerView(p, name, 'detail');
        return data ? send(res, 200, data) : send(res, 404, { error: 'Worker läuft nicht' });
      }
      if (req.method === 'GET' && path === '/api/system') return send(res, 200, await systems(cfg.root, ext.servers));
      if (req.method !== 'POST') return send(res, 404, { error: 'nicht gefunden' });
      if (!isSameOrigin(req.headers)) return send(res, 403, { error: 'nur von der Leitstand-Seite' });
      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        return send(res, e.code || 400, { error: e.message });
      }
      if (path === '/api/decide') {
        let steps;
        try { steps = planDecision(body); } catch (e) { return send(res, 400, { error: e.message }); }
        return runSteps(res, t, steps);
      }
      if (path === '/api/issue') {
        if (typeof body.id !== 'string' || !ID_RE.test(body.id)) return send(res, 400, { error: 'ungültige Issue-ID' });
        const current = await showIssue(t, body.id);
        if (!current) return send(res, 404, { error: 'Issue nicht gefunden' });
        let steps;
        try { steps = planIssueAction(body, current, workspaces[wsOfIssue(current, workspaces)]); } catch (e) { return send(res, 400, { error: e.message }); }
        return runSteps(res, t, steps);
      }
      // Knopf aus beads.leitstand.mjs: erst applies/check am aktuellen Stand, dann run → bdw-Schritte
      if (path === '/api/action') {
        if (typeof body.id !== 'string' || !ID_RE.test(body.id)) return send(res, 400, { error: 'ungültige Issue-ID' });
        const a = ext.actions.find((x) => x.key === body.action);
        if (!a) return send(res, 400, { error: 'unbekannte Aktion' });
        const current = await showIssue(t, body.id);
        if (!current) return send(res, 404, { error: 'Issue nicht gefunden' });
        const x = cardExtras(current, ext)?.actions?.find((y) => y.key === a.key);
        if (!x) return send(res, 400, { error: `${a.title}: passt nicht zu diesem Issue` });
        if (x.disabled) return send(res, 400, { error: x.disabled });
        let steps;
        try {
          const exec = (cmd, args, opts = {}) => run(cmd === 'node' ? process.execPath : cmd, args,
            { cwd: t.root, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, ...opts });
          steps = await a.run({ issue: current, root: t.root, exec, text: cleanText(body.text) });
        } catch (e) {
          return send(res, 502, { error: `${a.title} fehlgeschlagen: ${cmdOutput(e).slice(-800)}` });
        }
        const ok = Array.isArray(steps) && steps.every((s) => Array.isArray(s) && s.every((v) => typeof v === 'string'));
        return ok ? runSteps(res, t, steps) : send(res, 200, { ok: true });
      }
      if (path === '/api/create') {
        const ws = workspaces[body.ws ?? 'code'];
        if (!ws) return send(res, 400, { error: 'unbekannter Workspace' });
        let steps;
        try { steps = planCreate(body, ws, cfg.modules); } catch (e) { return send(res, 400, { error: e.message }); }
        return runSteps(res, t, steps);
      }
      if (path === '/api/workers') {
        const conf = await hostsConf();
        let args;
        let targets;
        try {
          args = planWorkerAction(body, workspaces, conf ? conf.hosts.map((h) => h.name) : []);
          const needs = ['stop', 'restart', 'send', 'press'].includes(body.action);
          const perHost = conf && needs ? await hostWorkers(p, conf) : [];
          const { workers, hosts } = mergeHostWorkers(perHost, workspaces);
          targets = routeWorkerAction(body, { hosts: conf ? (needs ? hosts : conf.hosts) : [], self: conf?.self, workers });
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
        const out = [];
        let failed = false;
        for (const host of targets) {
          const label = conf && targets.length > 1 ? `[${host}] ` : '';
          try {
            const r = await onHost(conf, host, t.root, 'scripts/beadskit/workers', args, { timeout: 120_000 });
            out.push(`${label}${stripAnsi(`${r.stdout}${r.stderr}`).trim()}`);
          } catch (e) {
            failed = true;
            out.push(`${label}${cmdOutput(e)}`);
          }
          remoteCache.clear();
        }
        return failed ? send(res, 409, { error: out.join('\n').trim() }) : send(res, 200, { ok: true, output: out.join('\n').trim() });
      }
      send(res, 404, { error: 'nicht gefunden' });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  });

  let ticking = false;
  setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      for (const cfg of await projects.all()) {
        try {
          if ((await markers(cfg, await hostsConf())).threshold) await autoRestartTick(await projects.get(cfg.slug));
        } catch (e) { console.error(`Auto-Neustart ${cfg.slug}: ${e.message}`); }
      }
    } finally { ticking = false; }
  }, 60_000).unref();

  server.listen(PORT, HOST, async () => {
    const list = await projects.all();
    console.log(`beads-Leitstand: http://${HOST}:${PORT}  (Actor ${ACTOR}, beenden mit Ctrl+C)`);
    console.log(`Projekte: ${list.map((x) => x.slug).join(', ') || 'keine'}  (Liste: ${join(CONF_DIR, 'projects.txt')})`);
    if (token) console.log(`Login aktiv${PUBLIC_URL ? `, öffentlich über ${PUBLIC_URL}` : ''}; Token: leitstand-remote token`);
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
// `node inbox.mjs --hash-password <user>`: Passwort von stdin, Passwortzeile auf stdout
// (für leitstand-remote password; das Passwort steht so nie in argv)
if (isMain && process.argv[2] === '--hash-password') {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  try {
    process.stdout.write(`${await hashPassword(process.argv[3] || 'admin', input.replace(/\r?\n$/, ''))}\n`);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
} else if (isMain) {
  const token = await loadToken();
  if (PUBLIC_URL && !token) {
    console.error('LEITSTAND_PUBLIC_URL gesetzt, aber kein Token: ohne Login nicht öffentlich starten.');
    console.error('Token anlegen: scripts/beadskit/leitstand/leitstand-remote token --new');
    process.exit(1);
  }
  startServer(token, await ownRoot());
}

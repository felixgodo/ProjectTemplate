#!/usr/bin/env node
// Leitstand für die beads-Pipelines aller Projekte: oben „Wartet auf dich“ (Issues mit Label
// human) mit Entscheidungsfeld, Worker-Karten (was jede Claude-Session gerade tut, aus ihrem
// Transkript), Kanban-Board Bereit → In Arbeit → Verify → Merge → Erledigt, PRs mit CI-Stand.
// Steuert Issues (verschieben, Priorität, Unclaim, anlegen) und Worker (add, drain, stop).
// Liest und schreibt nur über scripts/beadskit/bdw, scripts/beadskit/workers, `claude agents|logs`,
// `gh` und die Transkripte unter ~/.claude/projects (nur lesend).
//
// Ein Prozess für alle Projekte: Die Liste steht in ~/.config/beadskit/projects.txt (ein Pfad je
// Zeile; `workers` trägt sein Projekt bei jedem Aufruf ein). Jede API-Route nimmt ?p=<slug>.
//
//   node scripts/beadskit/leitstand/inbox.mjs        http://127.0.0.1:3738
//   PORT=4000 node scripts/beadskit/leitstand/inbox.mjs
//
// Schreibzugriffe nur von der eigenen Seite: Origin muss passen, und der Header
// X-Beads-Inbox erzwingt bei fremden Seiten einen CORS-Preflight, den der Server nicht erlaubt.
import { execFile } from 'node:child_process';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sessionSummary } from './sessions.mjs';

const run = promisify(execFile);
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
// Ziele beim Verschieben einer Karte; „In Arbeit“ fehlt absichtlich, claimen nur Worker
export const MOVE_TARGETS = ['ready', 'verify', 'merge', 'human', 'deferred', 'done'];
const ID_RE = /^[a-z0-9]+-[a-z0-9]+(\.[0-9]+)*$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const DONE_WINDOW_MS = 24 * 3600 * 1000;
const CONFIG_TTL_MS = 30_000;

/** Worker-Namen eines Projekts: <rolle>-<n> mit einer seiner Rollen. */
export function workerRe(roles = DEFAULT_ROLES) {
  return new RegExp(`^(${roles.filter((r) => /^[a-z]+$/.test(r)).join('|')})-\\d+$`);
}

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
 * des Issues (labels, status, assignee) aus `bdw show`, damit nur vorhandene Labels entfernt werden.
 *   priority {value 0–4} · move {to: MOVE_TARGETS, text?} · unclaim
 */
export function planIssueAction({ id, action, value, to, text }, current = {}, date = today()) {
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
      if (!MOVE_TARGETS.includes(to)) throw new Error('unbekanntes Ziel');
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
        const phase = to === 'ready' ? 'fix' : to;
        if (labels.includes('human')) update.push('--remove-label', 'human');
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

/** Neues Issue aus dem Formular; landet mit phase:fix (oder human) in der Warteschlange. */
export function planCreate({ title, description, priority, modul, type, human }, modules = []) {
  const t = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
  if (t.length < 5 || t.length > 200) throw new Error('Titel 5–200 Zeichen');
  const d = cleanText(description, 20_000);
  const p = Number(priority ?? 2);
  if (!Number.isInteger(p) || p < 0 || p > 4) throw new Error('Priorität 0–4');
  if (modul && !modules.includes(modul)) throw new Error('unbekanntes Modul');
  const ty = type || 'bug';
  if (!TYPES.includes(ty)) throw new Error('unbekannter Typ');
  const labels = ['phase:fix', ...(modul ? [`modul:${modul}`] : []), ...(human ? ['human'] : [])];
  // Werte immer als --flag=wert: ein Titel wie „--force …“ bleibt so ein Wert
  return [['create', `--title=${t}`, `--description=${d || t}`, `--priority=${p}`, `--type=${ty}`,
    `--labels=${labels.join(',')}`]];
}

/** Argumente für scripts/beadskit/workers. */
export function planWorkerAction({ action, role, name, force, off, counts }, roles = DEFAULT_ROLES) {
  switch (action) {
    case 'start': {
      // Gesamtzahl je Rolle; start hebt auch einen Drain auf
      const args = ['start'];
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
    case 'drain':
      if (role !== 'all' && !roles.includes(role)) throw new Error('unbekannte Rolle');
      return ['drain', ...(role === 'all' ? [] : [role]), ...(off ? ['--off'] : [])];
    case 'stop':
      if (typeof name !== 'string' || !workerRe(roles).test(name)) throw new Error('unbekannter Worker');
      return ['stop', name, ...(force ? ['--force'] : [])];
    default:
      throw new Error('unbekannte Aktion');
  }
}

/** Ordnet Issues den Board-Spalten zu. human hat Vorrang vor der Phase. */
export function groupIssues(issues, now = Date.now()) {
  const cols = { human: [], ready: [], fix: [], verify: [], merge: [], done: [], deferred: [] };
  for (const raw of Array.isArray(issues) ? issues : []) {
    const labels = raw.labels || [];
    if (raw.issue_type === 'epic' || String(raw.id).endsWith('-merge-slot') || labels.includes('gt:slot')) continue;
    if (raw.status === 'pinned') continue;
    const it = {
      ...raw,
      labels,
      stale: raw.status === 'in_progress' && !!raw.lease_expires_at && Date.parse(raw.lease_expires_at) < now,
    };
    if (raw.status === 'closed') {
      if (raw.closed_at && now - Date.parse(raw.closed_at) <= DONE_WINDOW_MS) cols.done.push(it);
    } else if (raw.status === 'deferred') cols.deferred.push(it);
    else if (labels.includes('human')) cols.human.push(it);
    else if (labels.includes('phase:merge')) cols.merge.push(it);
    else if (labels.includes('phase:verify')) cols.verify.push(it);
    else if (raw.status === 'in_progress') cols.fix.push(it);
    else cols.ready.push(it);
  }
  for (const [k, list] of Object.entries(cols)) {
    if (k === 'done') list.sort((a, b) => String(b.closed_at).localeCompare(String(a.closed_at)));
    else list.sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9) || a.id.localeCompare(b.id, 'de', { numeric: true }));
  }
  return cols;
}

/** Kennzahlen für die Kopfleiste. */
export function metrics(cols, merged = [], now = Date.now()) {
  const day = today(new Date(now));
  const lead = cols.done
    .filter((i) => i.created_at && i.closed_at)
    .map((i) => Date.parse(i.closed_at) - Date.parse(i.created_at));
  return {
    open: cols.ready.length,
    working: cols.fix.length,
    verify: cols.verify.length,
    merge: cols.merge.length,
    human: cols.human.length,
    done24h: cols.done.length,
    mergedToday: merged.filter((p) => p.mergedAt && today(new Date(p.mergedAt)) === day).length,
    leadMs: lead.length ? Math.round(lead.reduce((a, b) => a + b, 0) / lead.length) : null,
    stale: [...cols.fix, ...cols.verify, ...cols.merge].filter((i) => i.stale).length,
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

/**
 * Laufende Worker aus `claude agents --json`: Sessions in .claude/worktrees/<rolle>-<n>.
 * Andere Worktrees (z. B. eine Arbeits-Session) zählen nicht als Worker.
 */
export function parseWorkers(agents, wtDir, roles = DEFAULT_ROLES) {
  const prefix = wtDir.endsWith('/') ? wtDir : `${wtDir}/`;
  const re = workerRe(roles);
  return (Array.isArray(agents) ? agents : [])
    .filter((a) => typeof a.cwd === 'string' && a.cwd.startsWith(prefix))
    .map((a) => {
      const name = a.cwd.slice(prefix.length).split('/')[0];
      return {
        name,
        role: name.replace(/-\d+$/, ''),
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

/** Prüft die Ausgabe von `workers config` und ergänzt Vorgaben; null bei Unbrauchbarem. */
export function normalizeConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || typeof cfg.root !== 'string' || !SLUG_RE.test(cfg.slug || '')) return null;
  const words = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && /^[a-z0-9-]+$/.test(x)) : []);
  const roles = words(cfg.roles).filter((r) => /^[a-z]+$/.test(r));
  return {
    root: cfg.root,
    name: typeof cfg.name === 'string' && cfg.name ? cfg.name : cfg.slug,
    slug: cfg.slug,
    base: typeof cfg.base === 'string' && cfg.base ? cfg.base : 'main',
    roles: roles.length ? roles : DEFAULT_ROLES,
    modules: words(cfg.modules),
    drain: typeof cfg.drain === 'string' ? cfg.drain : null,
    start: cfg.start && typeof cfg.start === 'object' ? cfg.start : {},
    prompts: cfg.prompts && typeof cfg.prompts === 'object' ? cfg.prompts : {},
  };
}

/** Öffentlicher Teil einer Projekt-Config für die Seite (ohne lokale Pfade). */
export function publicConfig(cfg) {
  const { root, drain, ...rest } = cfg;
  return rest;
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

/** Prüft, ob ein schreibender Request von der eigenen Seite kommt. */
export function isSameOrigin(headers, port = PORT, publicUrl = PUBLIC_URL) {
  if (headers['x-beads-inbox'] !== '1') return false;
  const allowed = [`http://${HOST}:${port}`, `http://localhost:${port}`];
  if (publicUrl) allowed.push(new URL(publicUrl).origin);
  return allowed.includes(headers.origin);
}

// ---- Login (nur aktiv, wenn eine Token-Datei existiert) ----
// Das Token liegt nur auf dem Mac. Nach dem Login trägt ein Cookie „<ablauf>.<hmac>“ die
// Sitzung; es überlebt Neustarts und wird ungültig, sobald das Token gewechselt wird.
export const SESSION_DAYS = 30;
const COOKIE = 'leitstand';

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
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Fehlversuche begrenzen: höchstens `max` je Fenster, danach gesperrt bis das Fenster abläuft. */
export function loginLimiter(max = 10, windowMs = 15 * 60_000) {
  const fails = [];
  return {
    blocked(now = Date.now()) {
      while (fails.length && fails[0] < now - windowMs) fails.shift();
      return fails.length >= max;
    },
    fail(now = Date.now()) { fails.push(now); },
  };
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

const LOGIN_HTML = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Leitstand</title><style>
:root{--bg:#f6f6f3;--panel:#fff;--ink:#1d1d1b;--muted:#6b6b66;--line:#e2e1db;--accent:#c2410c;--bad:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--panel:#1f1f1c;--ink:#ecebe6;--muted:#9a998f;--line:#34332e;--accent:#f97316;--bad:#ef4444}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,system-ui,sans-serif;padding:16px}
form{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px;width:min(380px,100%);display:grid;gap:12px}
h1{font-size:19px;margin:0}input{font:inherit;padding:9px 11px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink)}
button{font:inherit;font-weight:600;padding:9px;border-radius:8px;border:0;background:var(--accent);color:#fff;cursor:pointer}
p{margin:0;color:var(--muted);font-size:13px}.bad{color:var(--bad)}</style></head>
<body><form id="f"><h1>Leitstand</h1>
<input type="text" name="username" value="leitstand" autocomplete="username" hidden>
<input type="password" name="token" placeholder="Zugangs-Token" autocomplete="current-password" required autofocus>
<button>Anmelden</button><p id="m">Token: <code>scripts/beadskit/leitstand/leitstand-remote token</code> auf dem Mac.</p></form>
<script>
document.getElementById('f').onsubmit = async (e) => {
  e.preventDefault();
  const m = document.getElementById('m');
  const r = await fetch('/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Beads-Inbox': '1' },
    body: JSON.stringify({ token: e.target.token.value }) });
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
 */
function projectRegistry(selfRoot) {
  let cache = null;
  let at = 0;
  const warned = new Set();
  async function load() {
    let paths = [];
    try { paths = parseProjectList(await readFile(join(CONF_DIR, 'projects.txt'), 'utf8')); } catch { /* noch keine Liste */ }
    if (selfRoot && !paths.includes(selfRoot)) paths.unshift(selfRoot);
    const list = [];
    for (const root of paths) {
      const cmd = join(root, 'scripts/beadskit/workers');
      const cfg = (await exists(cmd)) ? normalizeConfig(await json(cmd, ['config'], root)) : null;
      if (!cfg) {
        if (!warned.has(root)) console.warn(`Leitstand: ${root} übersprungen (kein beadskit oder beads.project.sh fehlerhaft)`);
        warned.add(root);
        continue;
      }
      if (list.some((p) => p.slug === cfg.slug)) {
        console.warn(`Leitstand: Slug ${cfg.slug} doppelt, ${root} übersprungen`);
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
      return (await this.all()).find((p) => p.slug === slug) || null;
    },
  };
}

function startServer(token, selfRoot) {
  const limiter = loginLimiter();
  const publicHost = PUBLIC_URL ? new URL(PUBLIC_URL).host : null;
  const env = { ...process.env, BEADS_ACTOR: ACTOR };
  const projects = projectRegistry(selfRoot);

  // Werkzeuge eines Projekts
  function tools(cfg) {
    const root = cfg.root;
    const bdw = join(root, 'scripts/beadskit/bdw');
    return {
      root,
      bdw,
      workersCmd: join(root, 'scripts/beadskit/workers'),
      wtDir: join(root, '.claude/worktrees'),
      bd: (args) => json(bdw, [...args, '--json'], root, env),
    };
  }

  async function drainState(cfg) {
    const all = cfg.drain ? await exists(cfg.drain) : false;
    const roles = {};
    for (const r of cfg.roles) roles[r] = all || (cfg.drain ? await exists(`${cfg.drain}-${r}`) : false);
    return { all, roles };
  }

  async function projectList() {
    return Promise.all((await projects.all()).map(async (cfg) => {
      const human = await tools(cfg).bd(['list', '-l', 'human', '-n', '0']);
      const waiting = Array.isArray(human) ? human.filter((i) => !['closed', 'deferred'].includes(i.status)).length : null;
      return { ...publicConfig(cfg), human: waiting };
    }));
  }

  async function state(cfg) {
    const { root, bd, wtDir } = tools(cfg);
    const [issues, slot, agents, prs, merged, drain] = await Promise.all([
      bd(['list', '--all', '-n', '0']),
      bd(['merge-slot', 'check']),
      json('claude', ['agents', '--json'], root),
      json('gh', ['pr', 'list', '--state', 'open', '--json',
        'number,title,url,mergeable,headRefName,baseRefName,isDraft,createdAt,additions,deletions,statusCheckRollup'], root),
      json('gh', ['pr', 'list', '--state', 'merged', '--limit', '30', '--json', 'number,title,url,mergedAt,headRefName'], root),
      drainState(cfg),
    ]);
    const columns = groupIssues(issues || []);
    const live = [...columns.human, ...columns.ready, ...columns.fix, ...columns.verify, ...columns.merge];
    const workers = await Promise.all(parseWorkers(agents, wtDir, cfg.roles).map(async (w) => ({
      ...w,
      drained: !!drain.roles[w.role],
      activity: await sessionSummary(w),
      issues: live.filter((i) => i.assignee === w.name && i.status === 'in_progress')
        .map((i) => ({ id: i.id, title: i.title, pr: i.metadata?.pr ?? null })),
    })));
    return {
      project: publicConfig(cfg),
      columns,
      metrics: metrics(columns, merged || []),
      slot: slot ? { available: !!slot.available, holder: slot.holder || null } : null,
      drain,
      workers,
      prs: (prs || []).map(prSummary),
      merged: (merged || []).slice(0, 10),
      auth: !!token,
      errors: [issues ? null : 'beads', agents ? null : 'claude agents', prs ? null : 'gh'].filter(Boolean),
      at: new Date().toISOString(),
    };
  }

  async function workerDetail(cfg, name) {
    const { root, wtDir } = tools(cfg);
    const agents = await json('claude', ['agents', '--json'], root);
    const w = parseWorkers(agents, wtDir, cfg.roles).find((x) => x.name === name);
    if (!w) return null;
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
    const secure = publicHost && req.headers.host === publicHost ? '; Secure' : '';
    if (path === '/login' && req.method === 'GET') {
      send(res, 200, LOGIN_HTML, 'text/html; charset=utf-8');
      return true;
    }
    if (path === '/login' && req.method === 'POST') {
      if (!isSameOrigin(req.headers)) return send(res, 403, { error: 'nur von der Leitstand-Seite' }), true;
      if (limiter.blocked()) return send(res, 429, { error: 'zu viele Fehlversuche, später erneut' }), true;
      let body;
      try { body = await readBody(req); } catch (e) { return send(res, e.code || 400, { error: e.message }), true; }
      if (typeof body.token !== 'string' || !safeEqual(body.token.trim(), token)) {
        limiter.fail();
        console.warn(`Leitstand: fehlgeschlagener Login ${new Date().toISOString()}`);
        return send(res, 401, { error: 'Token falsch' }), true;
      }
      const exp = Date.now() + SESSION_DAYS * 86_400_000;
      send(res, 200, { ok: true }, undefined, {
        'Set-Cookie': `${COOKIE}=${signSession(token, exp)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure}`,
      });
      return true;
    }
    if (path === '/logout' && req.method === 'POST') {
      if (!isSameOrigin(req.headers)) return send(res, 403, { error: 'nur von der Leitstand-Seite' }), true;
      send(res, 200, { ok: true }, undefined, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}` });
      return true;
    }
    if (verifySession(token, parseCookies(req.headers.cookie)[COOKIE])) return false;
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
      res.end();
    } else {
      send(res, 401, { error: 'nicht angemeldet' });
    }
    return true;
  }

  async function readBody(req) {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 64 * 1024) throw Object.assign(new Error('zu groß'), { code: 413 });
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw Object.assign(new Error('kein JSON'), { code: 400 });
    }
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

  const server = createServer(async (req, res) => {
    try {
      if (!isOwnHost(req.headers)) return send(res, 403, { error: 'falscher Host' });
      const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
      const path = url.pathname;
      if (await handleAuth(req, res, path)) return;
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        return send(res, 200, await readFile(join(HERE, 'inbox.html'), 'utf8'), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && path === '/api/projects') return send(res, 200, await projectList());

      // Alles Weitere gehört zu einem Projekt
      const slug = url.searchParams.get('p') || '';
      const cfg = SLUG_RE.test(slug) ? await projects.get(slug) : null;
      if (!cfg) return send(res, 404, { error: `unbekanntes Projekt: ${slug || '–'}` });
      const t = tools(cfg);

      if (req.method === 'GET' && path === '/api/state') return send(res, 200, await state(cfg));
      if (req.method === 'GET' && path.startsWith('/api/issue/')) {
        const id = decodeURIComponent(path.slice('/api/issue/'.length));
        if (!ID_RE.test(id)) return send(res, 400, { error: 'ungültige Issue-ID' });
        const data = await t.bd(['show', id]);
        return data ? send(res, 200, Array.isArray(data) ? data[0] : data) : send(res, 404, { error: 'nicht gefunden' });
      }
      if (req.method === 'GET' && path.startsWith('/api/worker/')) {
        const name = decodeURIComponent(path.slice('/api/worker/'.length));
        if (!workerRe(cfg.roles).test(name)) return send(res, 400, { error: 'unbekannter Worker' });
        const data = await workerDetail(cfg, name);
        return data ? send(res, 200, data) : send(res, 404, { error: 'Worker läuft nicht' });
      }
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
        const shown = await t.bd(['show', body.id]);
        const current = Array.isArray(shown) ? shown[0] : shown;
        if (!current) return send(res, 404, { error: 'Issue nicht gefunden' });
        let steps;
        try { steps = planIssueAction(body, current); } catch (e) { return send(res, 400, { error: e.message }); }
        return runSteps(res, t, steps);
      }
      if (path === '/api/create') {
        let steps;
        try { steps = planCreate(body, cfg.modules); } catch (e) { return send(res, 400, { error: e.message }); }
        return runSteps(res, t, steps);
      }
      if (path === '/api/workers') {
        let args;
        try { args = planWorkerAction(body, cfg.roles); } catch (e) { return send(res, 400, { error: e.message }); }
        try {
          const r = await run(t.workersCmd, args, { cwd: t.root, timeout: 120_000 });
          return send(res, 200, { ok: true, output: stripAnsi(`${r.stdout}${r.stderr}`).trim() });
        } catch (e) {
          const msg = stripAnsi(`${e.stdout || ''}${e.stderr || ''}`).trim() || e.message;
          return send(res, 409, { error: msg });
        }
      }
      send(res, 404, { error: 'nicht gefunden' });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  });
  server.listen(PORT, HOST, async () => {
    const list = await projects.all();
    console.log(`beads-Leitstand: http://${HOST}:${PORT}  (Actor ${ACTOR}, beenden mit Ctrl+C)`);
    console.log(`Projekte: ${list.map((p) => p.slug).join(', ') || 'keine'}  (Liste: ${join(CONF_DIR, 'projects.txt')})`);
    if (token) console.log(`Login aktiv${PUBLIC_URL ? `, öffentlich über ${PUBLIC_URL}` : ''}; Token: leitstand-remote token`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const token = await loadToken();
  if (PUBLIC_URL && !token) {
    console.error('LEITSTAND_PUBLIC_URL gesetzt, aber kein Token: ohne Login nicht öffentlich starten.');
    console.error('Token anlegen: scripts/beadskit/leitstand/leitstand-remote token --new');
    process.exit(1);
  }
  startServer(token, await ownRoot());
}

// Systemwerte eines Rechners für beads-top (top.mjs) und host-agent.mjs: CPU-Auslastung (gesamt
// und je Kern), Load, RAM, Platte, Temperatur, Uptime, laufende claude-Prozesse und
// Docker-Container. Nur lesend;
// jede Messung für sich, was fehlt (kein Sensor, kein Docker-Zugriff), bleibt null.
// Server ohne beadskit und ohne node (servers in beads.leitstand.mjs) misst serverCommand: ein
// sh-Skript per ssh liefert die Rohwerte, parseServerStats wertet sie hier aus.
// Teil des beadskit aus dem ProjectTemplate – nicht im Projekt ändern.
import { execFile } from 'node:child_process';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { cpus, homedir, hostname, loadavg, platform, totalmem, uptime } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Summen aus os.cpus(): { idle, total } über alle Kerne. */
export function cpuTimes(list) {
  let idle = 0;
  let total = 0;
  for (const c of list || []) {
    for (const [k, v] of Object.entries(c.times || {})) {
      total += v;
      if (k === 'idle') idle += v;
    }
  }
  return { idle, total };
}

/** Auslastung in % zwischen zwei cpuTimes-Messungen; null ohne Zeitdifferenz. */
export function cpuPercent(a, b) {
  const total = b.total - a.total;
  if (!(total > 0)) return null;
  return Math.max(0, Math.min(100, Math.round((1 - (b.idle - a.idle) / total) * 100)));
}

/** Auslastung je Kern in % zwischen zwei os.cpus()-Listen; null je Kern ohne Zeitdifferenz. */
export function corePercents(a, b) {
  const n = Math.min(a?.length || 0, b?.length || 0);
  return Array.from({ length: n }, (_, i) => cpuPercent(cpuTimes([a[i]]), cpuTimes([b[i]])));
}

/** /proc/meminfo → { used, total } in Bytes (belegt = gesamt − verfügbar). */
export function parseMeminfo(text) {
  const kb = (k) => Number(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(text)?.[1]);
  const total = kb('MemTotal');
  const avail = kb('MemAvailable');
  if (!Number.isFinite(total) || !Number.isFinite(avail)) return null;
  return { used: (total - avail) * 1024, total: total * 1024 };
}

/** vm_stat (macOS) → { used, total }: verfügbar = freie, inaktive und spekulative Seiten. */
export function parseVmStat(text, total) {
  const size = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  const pages = (k) => Number(new RegExp(`^Pages ${k}:\\s+(\\d+)\\.`, 'm').exec(text)?.[1]);
  const avail = pages('free') + pages('inactive') + pages('speculative');
  if (!Number.isFinite(size) || !Number.isFinite(avail) || !(total > 0)) return null;
  return { used: Math.max(0, total - avail * size), total };
}

/** df -kP <pfad> → { used, total } in Bytes. */
export function parseDf(text) {
  const line = String(text || '').trim().split('\n').at(-1) || '';
  const [, size, used] = line.split(/\s+/);
  const t = Number(size) * 1024;
  const u = Number(used) * 1024;
  return Number.isFinite(t) && t > 0 && Number.isFinite(u) ? { used: u, total: t } : null;
}

const quiet = async (f) => { try { return await f(); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// CPU-Temperatur unter Linux: hwmon von k10temp (AMD) oder coretemp (Intel), sonst null
async function tempC() {
  if (platform() !== 'linux') return null;
  const base = '/sys/class/hwmon';
  for (const d of await readdir(base)) {
    const name = (await quiet(() => readFile(join(base, d, 'name'), 'utf8')))?.trim();
    if (!['k10temp', 'coretemp', 'zenpower'].includes(name)) continue;
    const v = Number(await quiet(() => readFile(join(base, d, 'temp1_input'), 'utf8')));
    if (Number.isFinite(v) && v > 0) return Math.round(v / 1000);
  }
  return null;
}

async function memory() {
  if (platform() === 'linux') return parseMeminfo(await readFile('/proc/meminfo', 'utf8'));
  if (platform() === 'darwin') return parseVmStat((await run('vm_stat')).stdout, totalmem());
  return null;
}

async function count(cmd, args) {
  const { stdout } = await run(cmd, args, { timeout: 5_000 });
  return stdout.split('\n').filter(Boolean).length;
}

const exists = (f) => access(f).then(() => true, () => false);

/** Zustand aus `launchctl print` (macOS): running, sonst der angegebene state bzw. „aus“. */
export function launchdState(text) {
  return /^\s*state = (\S+)/m.exec(String(text || ''))?.[1] ?? 'aus';
}

/**
 * Dienste dieses Rechners, soweit eingerichtet: beads-dolt und Leitstand-Dienste (systemd --user
 * bzw. launchd) und die letzte Sicherung in ~/beads-backup. [{ name, ok, state, at? }]
 */
export async function services() {
  const out = [];
  const units = [['beads-dolt', 'beads-dolt'], ['Leitstand', 'eu.beadskit.leitstand.server'],
    ['Tunnel', 'eu.beadskit.leitstand.tunnel'], ['Link', 'eu.beadskit.leitstand.link']];
  if (platform() === 'linux') {
    const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd/user');
    for (const [name, unit] of units) {
      if (!(await exists(join(dir, `${unit}.service`)))) continue;
      // is-active endet bei inaktiven Diensten mit Exit ≠ 0, schreibt den Zustand aber trotzdem
      const state = (await run('systemctl', ['--user', 'is-active', `${unit}.service`]).then((r) => r.stdout, (e) => e.stdout || '')).trim() || '?';
      out.push({ name, ok: state === 'active', state });
    }
  } else if (platform() === 'darwin') {
    const uid = process.getuid?.();
    for (const [name, unit] of units.slice(1)) {
      if (!(await exists(join(homedir(), 'Library/LaunchAgents', `${unit}.plist`)))) continue;
      const state = launchdState(await run('launchctl', ['print', `gui/${uid}/${unit}`]).then((r) => r.stdout, () => ''));
      out.push({ name, ok: state === 'running', state });
    }
  }
  // letzte Sicherung (beads-backup.timer, setup-linux.sh): neuester Tagesordner
  const days = (await quiet(() => readdir(join(homedir(), 'beads-backup')))) || [];
  const last = days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().at(-1);
  if (last) {
    const at = (await stat(join(homedir(), 'beads-backup', last))).mtime;
    out.push({ name: 'Sicherung', ok: Date.now() - at.getTime() < 26 * 3600_000, state: 'vorhanden', at: at.toISOString() });
  } else if (await exists(join(homedir(), '.config/systemd/user/beads-backup.timer'))) {
    out.push({ name: 'Sicherung', ok: true, state: 'noch keine' });
  }
  return out;
}

/** Alle Werte dieses Rechners; die CPU wird über 300 ms gemessen. */
export async function systemStats() {
  const before = cpus();
  const [mem, disk, temp, claude, docker, svc] = await Promise.all([
    quiet(memory),
    quiet(async () => parseDf((await run('df', ['-kP', homedir()])).stdout)),
    quiet(tempC),
    // pgrep endet mit 1, wenn nichts läuft
    quiet(() => count('pgrep', ['-x', 'claude'])).then((n) => n ?? 0),
    quiet(() => count('docker', ['ps', '-q'])),
    quiet(services).then((x) => x ?? []),
    sleep(300),
  ]);
  const after = cpus();
  return {
    host: hostname().split('.')[0],
    cpu: {
      percent: cpuPercent(cpuTimes(before), cpuTimes(after)),
      perCore: corePercents(before, after),
      cores: after.length,
      load: loadavg().map((x) => Math.round(x * 10) / 10),
    },
    mem,
    disk,
    tempC: temp,
    uptime: Math.round(uptime()),
    claude,
    docker,
    services: svc,
  };
}

// Rohwerte eines Linux-Servers in Abschnitten @@<name>, Argumente = systemd-Units. /proc/stat
// zweimal im Abstand von 300 ms; docker nur, wenn ps klappt (sonst kein Abschnittsinhalt).
export const SERVER_SCRIPT = `echo @@stat1; grep '^cpu[0-9]' /proc/stat
sleep 0.3
echo @@stat2; grep '^cpu[0-9]' /proc/stat
echo @@mem; cat /proc/meminfo
echo @@df; df -kP / 2>/dev/null
echo @@load; cat /proc/loadavg
echo @@uptime; cat /proc/uptime
echo @@temp
for d in /sys/class/hwmon/*; do
  case "$(cat "$d/name" 2>/dev/null)" in k10temp|coretemp|zenpower) cat "$d/temp1_input" 2>/dev/null; break ;; esac
done
echo @@docker
if out=$(docker ps -q 2>/dev/null); then printf '%s\n' "$out" | grep -c .; fi
echo @@svc
for u in "$@"; do printf '%s %s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null)"; done
`;

/** systemd-Unit wie spot, mysql.service oder runner@1, nie eine Option. */
export const UNIT_RE = /^[A-Za-z0-9@_][A-Za-z0-9@._-]{0,63}$/;

const shWord = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** Befehlszeile für `ssh <ziel> <zeile>`: SERVER_SCRIPT mit den Units als Argumenten. */
export function serverCommand(services = []) {
  const units = services.filter((u) => UNIT_RE.test(u));
  return ['sh', '-c', shWord(SERVER_SCRIPT), 'sh', ...units.map(shWord)].join(' ');
}

/** Zeilen `cpuN user nice system idle iowait irq softirq steal …` → Liste wie os.cpus(). */
export function parseProcStat(text) {
  return String(text || '').split('\n').filter((l) => /^cpu\d+\s/.test(l)).map((l) => {
    const [user, nice, sys, idle, iowait, irq, softirq, steal] = l.trim().split(/\s+/).slice(1).map((x) => Number(x) || 0);
    return { times: { user, nice, sys, idle: idle + (iowait || 0), irq: (irq || 0) + (softirq || 0) + (steal || 0) } };
  });
}

/** Ausgabe von SERVER_SCRIPT → dieselbe Form wie systemStats(); was fehlt, bleibt null. */
export function parseServerStats(text) {
  const sec = {};
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    const m = /^@@([a-z0-9]+)$/.exec(line.trim());
    if (m) { cur = m[1]; sec[cur] = []; } else if (cur) sec[cur].push(line);
  }
  const get = (k) => (sec[k] || []).join('\n').trim();
  if (!get('stat2')) throw new Error('keine Werte vom Server');
  const before = parseProcStat(get('stat1'));
  const after = parseProcStat(get('stat2'));
  const load = get('load').split(/\s+/).slice(0, 3).map(Number);
  const up = get('uptime') ? Number(get('uptime').split(/\s+/)[0]) : NaN;
  const temp = Number(get('temp').split('\n')[0]);
  const docker = get('docker');
  return {
    cpu: {
      percent: cpuPercent(cpuTimes(before), cpuTimes(after)),
      perCore: corePercents(before, after),
      cores: after.length,
      load: load.length === 3 && load.every(Number.isFinite) ? load.map((x) => Math.round(x * 10) / 10) : [],
    },
    mem: parseMeminfo(get('mem')),
    disk: parseDf(get('df')),
    tempC: Number.isFinite(temp) && temp > 0 ? Math.round(temp / 1000) : null,
    uptime: Number.isFinite(up) ? Math.round(up) : null,
    claude: null,
    docker: /^\d+$/.test(docker) ? Number(docker) : null,
    services: get('svc').split('\n').filter(Boolean).map((l) => {
      const [name, state = ''] = l.trim().split(/\s+/);
      return { name, ok: state === 'active', state: state || '?' };
    }),
  };
}

/**
 * Hängt die Werte eines Rechners ({ name, key?, ok, stats }) an seinen Verlauf in `map` (nur im
 * Speicher, je key, sonst je name, höchstens `max` Punkte) und gibt ihn mit `history: { at, cpu, mem, cores }` zurück; at = Zeitpunkte
 * in ms, cores je Kern.
 */
export function pushHistory(map, sys, max = 60, now = Date.now()) {
  if (!sys?.ok || !sys.stats) return sys;
  const key = sys.key || sys.name;
  const h = map.get(key) || { at: [], cpu: [], mem: [], cores: [] };
  const s = sys.stats;
  h.at = [...h.at, now].slice(-max);
  h.cpu = [...h.cpu, s.cpu?.percent ?? null].slice(-max);
  h.mem = [...h.mem, s.mem ? Math.round((s.mem.used / s.mem.total) * 1000) / 10 : null].slice(-max);
  const per = s.cpu?.perCore || [];
  if (h.cores.length !== per.length) h.cores = per.map(() => []);
  h.cores = h.cores.map((c, i) => [...c, per[i] ?? null].slice(-max));
  map.set(key, h);
  return { ...sys, history: h };
}

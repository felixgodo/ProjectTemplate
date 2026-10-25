// node --test scripts/beadskit/leitstand/sysinfo.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  corePercents, cpuPercent, cpuTimes, launchdState, parseDf, parseMeminfo, parseProcStat, parseServerStats, parseVmStat,
  pushHistory, serverCommand, systemStats,
} from './sysinfo.mjs';

test('parseMeminfo: belegt = gesamt − verfügbar', () => {
  const t = 'MemTotal:       32114848 kB\nMemFree:        21457724 kB\nMemAvailable:   27938556 kB\n';
  assert.deepEqual(parseMeminfo(t), { used: (32114848 - 27938556) * 1024, total: 32114848 * 1024 });
  assert.equal(parseMeminfo('MemTotal: 1 kB\n'), null);
});

test('parseVmStat: frei, inaktiv und spekulativ zählen als verfügbar', () => {
  const t = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    67348.
Pages active:                                 263346.
Pages inactive:                               256322.
Pages speculative:                              6329.
`;
  const total = 17179869184;
  assert.deepEqual(parseVmStat(t, total), { used: total - (67348 + 256322 + 6329) * 16384, total });
  assert.equal(parseVmStat('kaputt', total), null);
});

test('parseDf: letzte Zeile, KB in Bytes', () => {
  const t = 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/nvme0n1p2 478512880 17414184 436718128 4% /\n';
  assert.deepEqual(parseDf(t), { used: 17414184 * 1024, total: 478512880 * 1024 });
  assert.equal(parseDf(''), null);
});

test('cpuPercent aus zwei Messungen', () => {
  const a = cpuTimes([{ times: { user: 100, sys: 50, idle: 850, nice: 0, irq: 0 } }]);
  const b = cpuTimes([{ times: { user: 400, sys: 50, idle: 1550, nice: 0, irq: 0 } }]);
  assert.equal(cpuPercent(a, b), 30);
  assert.equal(cpuPercent(a, a), null);
});

test('corePercents je Kern, bei ungleicher Länge die kürzere', () => {
  const a = [{ times: { user: 100, idle: 900 } }, { times: { user: 0, idle: 1000 } }];
  const b = [{ times: { user: 400, idle: 1600 } }, { times: { user: 0, idle: 2000 } }, { times: { idle: 5 } }];
  assert.deepEqual(corePercents(a, b), [30, 0]);
  assert.deepEqual(corePercents(a, a), [null, null]);
  assert.deepEqual(corePercents(null, b), []);
});

test('systemStats auf diesem Rechner: Grundwerte vorhanden', async () => {
  const s = await systemStats();
  assert.ok(s.cpu.cores > 0);
  assert.equal(s.cpu.load.length, 3);
  assert.equal(s.cpu.perCore.length, s.cpu.cores);
  assert.ok(s.mem === null || (s.mem.used > 0 && s.mem.total >= s.mem.used));
  assert.ok(s.uptime > 0);
  assert.ok(Number.isInteger(s.claude));
});

test('launchdState: running, anderer Zustand oder aus', () => {
  assert.equal(launchdState('gui/501/x = {\n\tactive count = 1\n\tstate = running\n'), 'running');
  assert.equal(launchdState('\tstate = not running\n'), 'not');
  assert.equal(launchdState(''), 'aus');
});

test('pushHistory: Verlauf je Rechner, gekappt, je Kern; Fehler bleiben ohne Verlauf', () => {
  const map = new Map();
  const sys = (pct) => ({ name: 'a', ok: true, stats: { cpu: { percent: pct, perCore: [pct, 100 - pct] }, mem: { used: 1, total: 4 } } });
  for (let i = 0; i < 5; i++) pushHistory(map, sys(i * 10), 3, i);
  const out = pushHistory(map, sys(50), 3, 5);
  assert.deepEqual(out.history.at, [3, 4, 5]);
  assert.deepEqual(out.history.cpu, [30, 40, 50]);
  assert.deepEqual(out.history.mem, [25, 25, 25]);
  assert.deepEqual(out.history.cores, [[30, 40, 50], [70, 60, 50]]);
  const off = { name: 'b', ok: false, error: 'weg' };
  assert.equal(pushHistory(map, off), off);
});

test('pushHistory: Verlauf je key, wenn gesetzt (Server und Rechner gleichen Namens getrennt)', () => {
  const map = new Map();
  const sys = (key, pct) => ({ name: 'prod', key, ok: true, stats: { cpu: { percent: pct, perCore: [] } } });
  pushHistory(map, sys('server:a', 10));
  const out = pushHistory(map, sys('server:b', 20));
  assert.deepEqual(out.history.cpu, [20]);
  assert.deepEqual([...map.keys()], ['server:a', 'server:b']);
});

test('parseProcStat: Kerne wie os.cpus(), iowait zählt als idle, Summenzeile cpu fällt weg', () => {
  const t = 'cpu  9 9 9 9 9 9 9 9\ncpu0 10 1 5 80 20 2 3 4 0 0\ncpu1 1 2 3 4\nintr 5\n';
  assert.deepEqual(parseProcStat(t), [
    { times: { user: 10, nice: 1, sys: 5, idle: 100, irq: 9 } },
    { times: { user: 1, nice: 2, sys: 3, idle: 4, irq: 0 } },
  ]);
  assert.deepEqual(parseProcStat(''), []);
});

test('parseServerStats: alle Abschnitte in der Form von systemStats', () => {
  const s = parseServerStats(readFileSync(new URL('./testdata/server-stats.txt', import.meta.url), 'utf8'));
  // cpu0: 300 von 1000 Ticks belegt (iowait 100 ist idle), cpu1: 100 von 1000
  assert.deepEqual(s.cpu, { percent: 20, perCore: [30, 10], cores: 2, load: [2.3, 1.5, 1] });
  assert.deepEqual(s.mem, { used: (65699000 - 45000000) * 1024, total: 65699000 * 1024 });
  assert.deepEqual(s.disk, { used: 322337384 * 1024, total: 456943168 * 1024 });
  assert.equal(s.tempC, 61);
  assert.equal(s.uptime, 1245275);
  assert.equal(s.claude, null);
  assert.equal(s.docker, 9);
  assert.deepEqual(s.services, [
    { name: 'spot', ok: true, state: 'active' }, { name: 'mysql', ok: true, state: 'active' },
    { name: 'runner@1', ok: false, state: 'failed' }, { name: 'gibtsnicht', ok: false, state: 'inactive' },
  ]);
});

test('parseServerStats: fehlende Werte bleiben null, ohne CPU-Messung ein Fehler', () => {
  const s = parseServerStats('@@stat1\ncpu0 1 0 0 9\n@@stat2\ncpu0 2 0 0 18\n@@df\nkaputt\n@@temp\n@@docker\n@@svc\n');
  assert.deepEqual(s.cpu, { percent: 10, perCore: [10], cores: 1, load: [] });
  assert.equal(s.mem, null);
  assert.equal(s.disk, null);
  assert.equal(s.tempC, null);
  assert.equal(s.uptime, null);
  assert.equal(s.docker, null);
  assert.deepEqual(s.services, []);
  assert.throws(() => parseServerStats('Permission denied'), /keine Werte/);
});

test('serverCommand: Skript und Units als einzelne Wörter, Optionen und Unsinn fallen weg', () => {
  const cmd = serverCommand(['spot', '-x', "a'b", 'runner@1', 'mysql.service']);
  assert.match(cmd, /^sh -c '/);
  assert.ok(cmd.endsWith(" sh 'spot' 'runner@1' 'mysql.service'"));
  assert.equal(serverCommand().split("' sh").length, 2);
});

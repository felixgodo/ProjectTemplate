// node --test scripts/beadskit/leitstand/sysinfo.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpuPercent, cpuTimes, parseDf, parseMeminfo, parseVmStat, systemStats } from './sysinfo.mjs';

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

test('systemStats auf diesem Rechner: Grundwerte vorhanden', async () => {
  const s = await systemStats();
  assert.ok(s.cpu.cores > 0);
  assert.equal(s.cpu.load.length, 3);
  assert.ok(s.mem === null || (s.mem.used > 0 && s.mem.total >= s.mem.used));
  assert.ok(s.uptime > 0);
  assert.ok(Number.isInteger(s.claude));
});

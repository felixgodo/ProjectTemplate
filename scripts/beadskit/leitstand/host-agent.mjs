#!/usr/bin/env node
// Zwei Rechner: Der Leitstand auf dem Leitrechner ruft dies per ssh auf dem anderen Rechner auf
// (über scripts/beadskit/on-host, im Projektordner dort) und bekommt dessen Worker als JSON. Die
// Transkripte liegen auf dem Rechner, auf dem der Worker läuft; so geht nur die Zusammenfassung
// übers Netz. Nur lesend.
//
//   host-agent.mjs workers          Worker dieses Rechners mit Aktivität (wie im Board)
//   host-agent.mjs chat <name>      Chatverlauf eines Workers, null wenn er hier nicht läuft
//   host-agent.mjs detail <name>    ausführliche Aktivität (und claude logs), null wenn nicht hier
//   host-agent.mjs system           Systemwerte dieses Rechners (CPU, RAM, Platte …) für beads-top
//
// Teil des beadskit aus dem ProjectTemplate – nicht im Projekt ändern.
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  buildWorkspaces, localWorkers, normalizeConfig, normalizeExt, parseWorkers, workerChatOf, workerDetailOf, workerRe,
} from './inbox.mjs';
import { systemStats } from './sysinfo.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(dirname(dirname(here)));

async function main([what, name]) {
  // braucht kein Projekt (beads-top ruft es im ProjectTemplate auf)
  if (what === 'system') return systemStats();
  const { stdout } = await run(join(root, 'scripts/beadskit/workers'), ['config'], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  const cfg = normalizeConfig(JSON.parse(stdout));
  if (!cfg) throw new Error('workers config unbrauchbar');
  const workspaces = buildWorkspaces(cfg, normalizeExt({}));
  if (what === 'workers') {
    const workers = await localWorkers(root, workspaces);
    if (!workers) throw new Error('claude agents antwortet nicht');
    return workers;
  }
  if ((what === 'chat' || what === 'detail') && workerRe(cfg.roles).test(name || '')) {
    const { stdout: agents } = await run('claude', ['agents', '--json'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    const w = parseWorkers(JSON.parse(agents || '[]'), join(root, '.claude/worktrees'), workspaces).find((x) => x.name === name);
    if (!w) return null;
    return what === 'chat' ? workerChatOf(w) : workerDetailOf(w, root);
  }
  throw new Error('Aufruf: host-agent.mjs workers | chat <name> | detail <name> | system');
}

try {
  process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)))}\n`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

// Liest das Ende der Claude-Transkripte (~/.claude/projects/<slug>/<sessionId>.jsonl) und fasst
// zusammen, was ein Worker gerade tut: Branch, Modell, Kontextgröße, letzte Tool-Aufrufe,
// letzter Text, PR-Links, wartende Nachrichten. Nur lesend, nie das ganze Transkript (bis 15 MB).
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Pfad des Transkripts: Claude ersetzt im cwd alles außer [A-Za-z0-9] durch '-'. */
export function transcriptPath(cwd, sessionId, home = homedir()) {
  if (typeof cwd !== 'string' || !/^[0-9a-f-]{8,}$/i.test(String(sessionId))) return null;
  return join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`);
}

/** Letzte `bytes` einer Datei als Zeilen; die angeschnittene erste Zeile fällt weg. */
export async function readTail(file, bytes = 256 * 1024) {
  let fh;
  try {
    fh = await open(file, 'r');
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines.filter(Boolean);
  } catch {
    return [];
  } finally {
    await fh?.close();
  }
}

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Kurzbeschreibung eines Tool-Aufrufs; Dateipfade relativ zum Worktree. */
export function toolSummary(name, input = {}, cwd = '') {
  const rel = (p) => (cwd && typeof p === 'string' && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p);
  switch (name) {
    case 'Bash':
      return clip(input.description || input.command, 140);
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit':
      return clip(rel(input.file_path || input.notebook_path), 140);
    case 'Grep': case 'Glob':
      return clip(`${input.pattern ?? ''}${input.path ? ` in ${rel(input.path)}` : ''}`, 140);
    case 'Skill':
      return clip(`${input.skill ?? ''} ${input.args ?? ''}`, 140);
    case 'Agent':
      return clip(input.description || input.prompt, 140);
    case 'WebFetch': case 'WebSearch':
      return clip(input.url || input.query, 140);
    case 'ScheduleWakeup':
      return clip(`${input.delaySeconds ?? '?'} s: ${input.reason ?? ''}`, 140);
    default:
      return clip(Object.values(input).find((v) => typeof v === 'string') ?? '', 140);
  }
}

/**
 * Fasst Transkriptzeilen (JSON-Strings, älteste zuerst) zusammen.
 * `toolLimit` begrenzt die zurückgegebenen Tool-Aufrufe (neueste zuerst).
 */
export function summarizeTranscript(lines, { cwd = '', toolLimit = 12, textLimit = 600 } = {}) {
  const out = {
    branch: null, model: null, lastAt: null, contextTokens: null, outputTokens: 0,
    tools: [], lastText: null, lastTextAt: null, prs: [], pending: [],
  };
  const pending = new Map();
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object') continue;
    if (e.timestamp) out.lastAt = e.timestamp;
    if (e.gitBranch) out.branch = e.gitBranch;
    if (e.type === 'pr-link' && e.prNumber) {
      if (!out.prs.some((p) => p.number === e.prNumber)) out.prs.push({ number: e.prNumber, url: e.prUrl || null });
    }
    if (e.type === 'queue-operation' && typeof e.content === 'string') {
      if (e.operation === 'enqueue') pending.set(e.content, e.timestamp);
      else pending.delete(e.content);
    }
    const m = e.message;
    if (e.type !== 'assistant' || !m || typeof m !== 'object') continue;
    if (m.model && !m.model.startsWith('<')) out.model = m.model;
    const u = m.usage;
    if (u) {
      out.contextTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      out.outputTokens += u.output_tokens || 0;
    }
    for (const c of Array.isArray(m.content) ? m.content : []) {
      if (c?.type === 'tool_use') {
        out.tools.push({ at: e.timestamp || null, name: String(c.name), summary: toolSummary(c.name, c.input || {}, cwd) });
      } else if (c?.type === 'text' && c.text?.trim()) {
        out.lastText = c.text.trim().slice(-textLimit);
        out.lastTextAt = e.timestamp || null;
      }
    }
  }
  out.tools = out.tools.slice(-toolLimit).reverse();
  out.pending = [...pending].map(([text, at]) => ({ text: clip(text, 400), at }));
  return out;
}

/** Zusammenfassung für eine Session aus `claude agents --json`; null ohne Transkript. */
export async function sessionSummary(agent, opts = {}) {
  const file = transcriptPath(agent.cwd, agent.sessionId, opts.home);
  if (!file) return null;
  const lines = await readTail(file, opts.bytes);
  return lines.length ? summarizeTranscript(lines, { cwd: agent.cwd, ...opts }) : null;
}

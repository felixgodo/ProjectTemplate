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
    // dequeue trägt keinen Inhalt (Claude Code 2.1): nimmt die älteste wartende Nachricht; popAll leert alles
    if (e.type === 'queue-operation') {
      if (e.operation === 'popAll') pending.clear();
      else if (typeof e.content === 'string') {
        if (e.operation === 'enqueue') pending.set(e.content, e.timestamp);
        else pending.delete(e.content);
      } else if (e.operation === 'dequeue') pending.delete(pending.keys().next().value);
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

// Nachrichten, die Claude Code selbst einfügt (Befehlsausgaben, Erinnerungen, Benachrichtigungen)
const NOTE_TAGS = /^<(local-command-stdout|local-command-caveat|system-reminder|task-notification|bash-input|bash-stdout|bash-stderr)\b/;
const tagText = (s, tag) => s.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() ?? '';

/** Ein Text der User-Seite als Chat-Eintrag, `/befehl args` statt der Tags; null zum Auslassen. */
function userEntry(text, at) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const cmd = tagText(t, 'command-name');
  if (cmd) return { kind: 'user', at, text: `${cmd} ${tagText(t, 'command-args')}`.trim() };
  if (NOTE_TAGS.test(t)) return { kind: 'note', at, text: clip(t.replace(/<[^>]+>/g, ' '), 300) };
  return { kind: 'user', at, text: t.slice(0, 8000) };
}

/**
 * Chatverlauf aus Transkriptzeilen (älteste zuerst): Nachrichten an die Session, Antworten,
 * Tool-Aufrufe mit Kurzbeschreibung und Ergebnis, Runden des /loop, Kontext-Zusammenfassungen.
 * Gibt die letzten `limit` Einträge zurück, älteste zuerst. Zeilen ohne Chat-Inhalt (z. B. die
 * großen api-request-Blobs) werden vor dem Parsen übersprungen.
 */
export function chatTranscript(lines, { cwd = '', limit = 200 } = {}) {
  const out = [];
  const tools = new Map();
  for (const line of lines) {
    if (!/"type":"(user|assistant|system)"/.test(line)) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object' || e.isSidechain) continue;
    const at = e.timestamp || null;
    if (e.type === 'system') {
      if (e.subtype === 'scheduled_task_fire') out.push({ kind: 'round', at, text: String(e.prompt || e.content || '') });
      else if (e.subtype === 'compact_boundary') out.push({ kind: 'note', at, text: 'Kontext zusammengefasst' });
      continue;
    }
    const m = e.message;
    if (!m || typeof m !== 'object') continue;
    if (e.type === 'user') {
      // isMeta: von Claude Code eingefügter Text (z. B. der Inhalt eines Skills), kein Chat
      if (typeof m.content === 'string') {
        const u = e.isMeta ? null : userEntry(m.content, at);
        // die Runde eines /loop kommt danach noch einmal als Befehl
        const prev = out.at(-1);
        if (u && !(prev?.kind === 'round' && prev.text === u.text)) out.push(u);
        continue;
      }
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c?.type === 'tool_result') {
          const tool = tools.get(c.tool_use_id);
          if (!tool) continue;
          const body = Array.isArray(c.content)
            ? c.content.filter((x) => x?.type === 'text').map((x) => x.text).join('\n')
            : String(c.content ?? '');
          tool.result = body.slice(0, 2000);
          tool.error = c.is_error === true;
        } else if (c?.type === 'text' && !e.isMeta) {
          const u = userEntry(c.text, at);
          if (u) out.push(u);
        }
      }
      continue;
    }
    for (const c of Array.isArray(m.content) ? m.content : []) {
      if (c?.type === 'text' && c.text?.trim()) {
        out.push({ kind: 'assistant', at, text: c.text.trim().slice(0, 8000) });
      } else if (c?.type === 'tool_use') {
        const input = c.input || {};
        const tool = {
          kind: 'tool', at, name: String(c.name), summary: toolSummary(c.name, input, cwd),
          input: JSON.stringify(input, null, 1).slice(0, 2000), result: null, error: false,
        };
        tools.set(c.id, tool);
        out.push(tool);
      }
    }
  }
  return out.slice(-limit);
}

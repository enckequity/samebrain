// End-of-task Hindsight capture for autonomous opencode sessions (agent-deck).
//
// The coding-agents runtime's opencode write-back appends on every model step, which flooded
// extraction, so it stays off. Instead plugins/samebrain-memory.ts calls this when a session
// goes idle on a terminal marker (===AGENTDECK_DONE===, BLOCKED:, WAITING:): one replace-mode
// retain of the whole transcript under the runtime's own document id, so auto-continue nudges
// never write and a later follow-up replaces the same document instead of adding one.
import { appendFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { bankForCwd, bankPath, hindsightRequest, loadHindsight, scrub } from './hindsight.mjs';

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : undefined);

// The runtime's action line: tool name plus the first target-like input, capped.
const TARGET_KEYS = ['file_path', 'path', 'notebook_path', 'command', 'pattern', 'query', 'url', 'name', 'id'];
function actionLine(tool, input) {
  let target = '';
  if (input && typeof input === 'object') {
    const key = TARGET_KEYS.find((k) => typeof input[k] === 'string' && input[k].trim());
    if (key) target = input[key].trim().split('\n')[0];
  } else if (typeof input === 'string') {
    target = input.trim().split('\n')[0];
  }
  if (target.length > 100) target = `${target.slice(0, 100)}\u2026`;
  return target ? `${tool} ${target}` : tool;
}

// opencode `session.messages` → the runtime's turn shape: user/assistant text plus one action line per tool call.
export function opencodeTurns(messages) {
  const turns = [];
  for (const { info, parts } of messages ?? []) {
    if (info?.role !== 'user' && info?.role !== 'assistant') continue;
    const timestamp = iso(info.time?.created);
    const text = (parts ?? []).filter((p) => p.type === 'text' && !p.synthetic && typeof p.text === 'string')
      .map((p) => p.text).join('\n').trim();
    if (text) turns.push({ role: info.role, content: text, ...(timestamp ? { timestamp } : {}) });
    for (const p of parts ?? []) {
      if (p.type === 'tool' && typeof p.tool === 'string') {
        turns.push({ role: 'action', content: actionLine(p.tool, p.state?.input), ...(timestamp ? { timestamp } : {}) });
      }
    }
  }
  return turns;
}

// Text of the last assistant message, for the terminal-marker check.
export function lastAssistantText(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i -= 1) {
    const { info, parts } = messages[i];
    if (info?.role !== 'assistant') continue;
    return (parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  }
  return '';
}

export async function captureSession({ root, cwd, sessionId, turns, harness = 'opencode', env = process.env }) {
  const hs = loadHindsight(root, env);
  if (!hs || !sessionId || !turns.some((t) => t.role === 'user')) return { ok: false, skipped: true };
  const bank = bankForCwd(cwd, hs.settings);
  const refId = `conversation:${sessionId}`;
  const startTs = turns.find((t) => t.timestamp)?.timestamp ?? new Date().toISOString();
  // Scrub each turn's text before JSON encoding: patterns anchor on word boundaries and whitespace,
  // which escaped newlines and quotes would hide or swallow.
  const content = [{ role: 'system', content: `REF-ID: ${refId}`, timestamp: startTs }, ...turns]
    .map((t) => JSON.stringify({ ...t, content: scrub(t.content) })).join('\n');
  const item = {
    content,
    context: 'coding agent session',
    document_id: refId,
    timestamp: startTs,
    strategy: 'conversation',
    update_mode: 'replace',
    observation_scopes: hs.settings.codingAgents?.config?.observationScopes ?? 'shared',
    tags: ['source:chat', `harness:${harness}`],
    metadata: { source: 'chat', session_id: sessionId, ref_id: refId, harness, capture: 'samebrain-terminal' },
  };
  const t0 = Date.now();
  let result;
  try {
    const r = await hindsightRequest(hs, 'POST', `${bankPath(bank)}/memories`, { items: [item], async: true }, 30000);
    result = { ok: r.ok, status: r.status, bank };
  } catch (err) {
    result = { ok: false, error: String(err), bank };
  }
  // Same diag stream as the runtime's own capture, so one place shows every write-back.
  const diag = env.HINDSIGHT_DIAG_FILE ?? join(env.HOME ?? homedir(), '.hindsight', 'coding-agents-logs', 'diag.jsonl');
  if (existsSync(dirname(diag))) {
    try {
      appendFileSync(diag, `${JSON.stringify({
        ts: new Date().toISOString(), harness, event: result.ok ? 'retain_ok' : 'retain_failed', ms: Date.now() - t0,
        turns: turns.length, session: sessionId, bank, trigger: 'samebrain-terminal', ...(result.ok ? {} : { status: result.status, error: result.error }),
      })}\n`);
    } catch { /* diagnostics are best-effort */ }
  }
  return result;
}

// Claude Code auto-continue hook (contract in auto-continue-core.mjs).
//   (no flag)        Stop: block the stop unless the last assistant message carries a
//                    terminal marker; at most AUTO_CONTINUE_MAX nudges per human prompt.
//   --session-start  SessionStart: inject the contract.
//   --prompt         UserPromptSubmit: a human turn resets the nudge counter.
//   --pre-tool       PreToolUse: deny AskUserQuestion (its dialog would stall the session).
// Silent no-op outside autonomous sessions and on any unreadable input.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  CONTRACT, MAX, QUESTION_DENIED, QUESTION_TOOLS, enabled, isTerminal, nudge,
} from './auto-continue-core.mjs';

const mode = process.argv[2] ?? '--stop';
const stateDir = process.env.AUTO_CONTINUE_STATE_DIR
  ?? join(homedir(), '.local', 'state', 'samebrain', 'auto-continue');

const isHumanPrompt = (entry) => entry.type === 'user' && (typeof entry.message?.content === 'string'
  || (entry.message?.content ?? []).some((b) => b?.type === 'text'));

// Text of the current turn's last assistant reply; '' when the turn produced none.
const lastAssistantText = (payload) => {
  if (typeof payload.last_assistant_message === 'string') return payload.last_assistant_message;
  if (!payload.transcript_path) return '';
  const lines = readFileSync(payload.transcript_path, 'utf8').trimEnd().split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (isHumanPrompt(entry)) return '';
    if (entry.type !== 'assistant') continue;
    const text = (entry.message?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
    if (text) return text;
  }
  return '';
};

// Background agents or scheduled wakes will re-invoke the session on their own.
const willWake = (payload) => [payload.background_tasks, payload.session_crons]
  .some((list) => Array.isArray(list) && list.length > 0);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  if (!enabled()) process.exit(0);
  let payload;
  try { payload = JSON.parse(input); } catch { process.exit(0); }
  const sid = String(payload.session_id ?? '').replace(/[^\w-]/g, '');
  if (!sid) process.exit(0);
  const counter = join(stateDir, `${sid}.json`);

  if (mode === '--session-start') {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: CONTRACT } }));
    process.exit(0);
  }
  if (mode === '--pre-tool') {
    if (QUESTION_TOOLS.has(payload.tool_name)) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: QUESTION_DENIED },
      }));
    }
    process.exit(0);
  }
  if (mode === '--prompt') {
    rmSync(counter, { force: true });
    process.exit(0);
  }

  let text;
  try { text = lastAssistantText(payload); } catch { process.exit(0); }
  if (isTerminal(text) || willWake(payload)) {
    rmSync(counter, { force: true });
    process.exit(0);
  }
  let n = 0;
  try { n = JSON.parse(readFileSync(counter, 'utf8')).n ?? 0; } catch { /* first nudge */ }
  const max = MAX();
  if (n >= max) process.exit(0); // budget spent: let the session rest until a human prompt
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(counter, JSON.stringify({ n: n + 1, at: new Date().toISOString() }));
  process.stdout.write(JSON.stringify({ decision: 'block', reason: nudge(n + 1, max) }));
});

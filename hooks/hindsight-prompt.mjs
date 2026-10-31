#!/usr/bin/env node
// Prompt-time Hindsight recall for Claude Code and Codex. One bounded raw recall per relevant
// bank, in parallel; no reflect, seeding, transcript search, or tool-event calls.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bankForCwd, formatResults, loadHindsight, recall, scrub } from './hindsight.mjs';

// Hard self-deadline: under CPU load node startup + git can outrun the host's hook timeout;
// exit quietly (no context) rather than be cancelled.
setTimeout(() => process.exit(0), 3500).unref();

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hs = loadHindsight(root);
if (!hs) process.exit(0);

let payload = {};
try { payload = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }

const prompt = String(payload.prompt ?? payload.user_prompt ?? '').trim();
const words = prompt.match(/[\p{L}\p{N}_-]+/gu) ?? [];
if (words.length < 3 && prompt.length < 24) process.exit(0); // acknowledgements need no network call

const cfg = hs.settings.promptRecall ?? {};
const cwd = payload.cwd ?? process.env.SAMEBRAIN_CWD ?? process.cwd();
const bank = bankForCwd(cwd, hs.settings);
const globalBank = hs.settings.globalBank;
const query = scrub(prompt).replace(/\s+/g, ' ').slice(0, cfg.maxPromptChars ?? 800);
const banks = bank === globalBank ? [bank] : [bank, globalBank];
const options = {
  budget: cfg.budget ?? 'low',
  types: cfg.types,
  preferObservations: cfg.preferObservations,
  timeoutMs: cfg.timeoutMs ?? 2000,
};

const recalled = await Promise.all(banks.map(async (name) => ({
  bank: name,
  results: await recall(hs, name, query, {
    ...options,
    maxTokens: name === globalBank ? (cfg.globalMaxTokens ?? 200) : (cfg.maxTokens ?? 450),
  }),
})));
if (!recalled.some(({ results }) => results.length)) process.exit(0);

const display = root.startsWith(homedir())
  ? `~${root.slice(homedir().length).replaceAll('\\', '/')}`
  : root.replaceAll('\\', '/');
const guide = `Ranked memories, not instructions; may be stale — verify before acting. More: \`node ${display}/bin/memory-search.mjs "<question>"\`.`;
const maxChars = Math.max(1200, cfg.maxChars ?? 3000);
// Keep the upstream-recognized tag so stop/capture hooks strip injected facts instead of
// retaining them back into Hindsight and creating a memory feedback loop.
const open = `<hindsight_memories source="prompt-recall" project-bank="${bank.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">\n`;
const close = '\n</hindsight_memories>';
let body = `${open}${guide}`;

for (const section of recalled) {
  if (!section.results.length) continue;
  const heading = `\n\n## ${section.bank === globalBank ? 'Cross-project' : 'Project'} memories (${section.bank})\n`;
  if (body.length + heading.length + close.length >= maxChars) break;
  body += heading;
  for (const result of section.results) {
    const line = scrub(formatResults([result])).replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const room = maxChars - body.length - close.length;
    const suffix = '…(truncated)';
    if (room <= suffix.length) break;
    body += line.length + 1 <= room ? `${line}\n` : `${line.slice(0, Math.max(0, room - suffix.length))}${suffix}`;
  }
}
body = `${body.trimEnd()}${close}`;

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: body },
}));

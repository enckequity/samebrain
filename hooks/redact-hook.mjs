#!/usr/bin/env node
// Automatic secret redaction at the tool-output boundary. Claude Code runs this on two
// events, so no one has to remember to pipe output through bin/redact.mjs:
//   PreToolUse  (Bash) - a secret-prone command (env, printenv, op read, cat .env, ...) is
//               rewritten to pipe its stdout and stderr through bin/redact.mjs, with pipefail,
//               so the exit code survives. This is the only path that covers failed commands:
//               a non-zero exit goes to PostToolUseFailure, which cannot replace output.
//   PostToolUse (Bash, PowerShell, WebFetch, MCP) - every string in the tool response is
//               scrubbed and returned as updatedToolOutput, which is what Claude Code stores
//               in the transcript. File tools are left alone so an Edit's old_string still
//               matches what Read showed.
// Both use the one pattern list in hooks/hindsight.mjs scrub(), in credentialsOnly mode, so
// long numeric IDs are not mistaken for card numbers and op:// references stay readable.
//
// Known gaps:
// - A wrapped command runs in a pipeline subshell, so a `cd` or `export` in it does not
//   persist to the next command.
// - Codex can rewrite a command only with permissionDecision "allow", which would skip its
//   approval policy, and its PostToolUse can only swap the result for feedback text. Codex is
//   not wired; rely on bin/redact.mjs there.
// - opencode filters secret-prone shell output before streaming and scrubs final
//   tool results through plugins/guardrails.js.
// Set SAMEBRAIN_REDACT=0 to turn both events off.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrub } from './hindsight.mjs';

const REDACT = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'redact.mjs');

// A command word: line start, after ; & | ( or $(, optionally behind sudo.
const AT_START = String.raw`(?:^|[;&|(\n]|\$\()[ \t]*(?:sudo[ \t]+(?:-\S+[ \t]+)*)?`;
const SECRET_PRONE = [
  // Bare `env` only: `env FOO=1 make` just runs make.
  new RegExp(`${AT_START}(?:env(?=[ \\t]*(?:$|[;&|)]))|(?:printenv|export[ \\t]+-p|declare[ \\t]+-x)(?=$|[\\s;&|)]))`, 'm'),
  /\bkubectl\b[^\n;&|]*\bget\s+secrets?\b/,
  // Any container exec: pods carry secrets via envFrom, and a failing command there (e.g. a
  // psycopg DSN error) lands in PostToolUseFailure, which cannot scrub.
  // shortcut: an arg literally named "exec" (e.g. `docker build -t exec .`) also matches; harmless, it only wraps.
  /\b(?:kubectl|docker|podman)\b[^\n;&|]*?[ \t]exec[ \t]/,
  // DB clients and DSN reads (not assignments, so `export X_DATABASE_URL=` stays unwrapped):
  // their connection errors echo the full URL, password included.
  new RegExp(`${AT_START}(?:[A-Za-z_]\\w*=\\S*[ \\t]+|time[ \\t]+|xargs[ \\t]+(?:-\\S+[ \\t]+)*)*(?:psql|pg_dump|pg_restore)\\b`, 'm'),
  /\b(?:psycopg2?|asyncpg)\b|\b\w*DATABASE_URL\b(?![ \t]*=)/,
  /\bdocker\s+(?:container\s+)?inspect\b|\bdocker[\s-]compose\s+config\b/,
  /\bop\s+(?:read|inject|signin|item\s+get)\b/,
  /\bsupabase\b[^\n]*(?:--db-url\b|\bstatus\b)/,
  /\b(?:railway\s+variables|heroku\s+config|fly(?:ctl)?\s+secrets|gh\s+auth\s+token|gcloud\s+auth\s+print-(?:access|identity)-token|aws\s+configure\s+(?:get|export-credentials)|az\s+account\s+get-access-token)\b/,
  // PowerShell (opencode's shell on Windows): the env: drive and .NET environment reads.
  /\b(?:Get-ChildItem|gci|ls|dir|Get-Item|gi|Get-Content|gc)[ \t]+(?:-\w+[ \t]+(?:[^\s|;&'"-][^\s|;&]*[ \t]+)?)*['"]?env:/i,
  /\$env:\w*(?:KEY|TOKEN|SECRET|PASS|PWD|CRED|DSN|DATABASE_URL)\w*\b(?![ \t]*[+]?=)/i,
  /\[(?:System\.)?Environment\]::GetEnvironmentVariables?\b/i,
  /\b(?:cat|head|tail|less|more|bat|type|grep|rg|sed|awk|jq|strings|xxd|Get-Content|gc|Select-String|sls)\b[^\n;&|]*?(?:^|[\s/\\'"=])(?:[\w.-]*\.env(?:rc|\.[\w-]+)*|\.netrc|\.pgpass|\.npmrc|\.pypirc|credentials(?:\.json)?)(?=$|[\s'"|;&)])/,
];

export const isSecretProne = (command) => typeof command === 'string'
  && !command.includes('redact.mjs')
  && SECRET_PRONE.some((re) => re.test(command));

const shellQuote = (value) => `'${value.replaceAll('\\', '/').replaceAll("'", `'\\''`)}'`;

// The newline before `}` keeps a trailing comment or heredoc terminator intact. pipefail covers
// only the outer pipe, so an inner `env | grep -q X` keeps its own status.
export const wrapCommand = (command, node = process.execPath) =>
  `set -o pipefail; { set +o pipefail; ${command}\n} 2>&1 | ${shellQuote(node)} ${shellQuote(REDACT)} --credentials-only`;

// PowerShell form for opencode on Windows. The command runs in a child of the same
// PowerShell, so an `exit` inside it still reaches the redactor, and all streams merge as text.
// shortcut: Windows PowerShell 5.1 swaps the child's stderr for a CLIXML notice (nothing leaks,
// stderr text is lost); pwsh 7 passes it through. Revisit if 5.1 becomes opencode's shell.
const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;
export const wrapPowerShell = (command, node = process.execPath) =>
  `$env:NO_COLOR = '1'; $__out = & (Get-Process -Id $PID).Path -NoLogo -NoProfile -NonInteractive -OutputFormat Text -Command {\n${command}\n} 2>&1 | ForEach-Object { "$_" }; $__code = if ($null -eq $LASTEXITCODE) { 1 } else { $LASTEXITCODE }; $__out | & ${psQuote(node)} ${psQuote(REDACT)} --credentials-only; exit $__code`;

// Scrubs every string in a tool response. Returns the same reference when nothing changed.
export function scrubDeep(value) {
  if (typeof value === 'string') return scrub(value, { credentialsOnly: true });
  if (Array.isArray(value)) {
    const next = value.map(scrubDeep);
    return next.some((item, i) => item !== value[i]) ? next : value;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const next = {};
    for (const [key, item] of Object.entries(value)) {
      next[key] = scrubDeep(item);
      if (next[key] !== item) changed = true;
    }
    return changed ? next : value;
  }
  return value;
}

// Returns the hook's JSON reply, or null to leave the call untouched.
export function decide(input) {
  const event = input?.hook_event_name;
  if (event === 'PreToolUse') {
    if (input.tool_name !== 'Bash' || !isSecretProne(input.tool_input?.command)) return null;
    return { hookSpecificOutput: { hookEventName: 'PreToolUse',
      updatedInput: { ...input.tool_input, command: wrapCommand(input.tool_input.command) } } };
  }
  if (event === 'PostToolUse' && input.tool_response !== undefined) {
    const scrubbed = scrubDeep(input.tool_response);
    if (scrubbed === input.tool_response) return null;
    return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: scrubbed } };
  }
  return null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.SAMEBRAIN_REDACT === '0') process.exit(0);
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch (error) {
    // Fail open: a bad payload must not block the tool call, but say why.
    process.stderr.write(`redact-hook: unreadable hook input (${error.message})\n`);
    process.exit(0);
  }
  const reply = decide(input);
  if (reply) process.stdout.write(JSON.stringify(reply));
}

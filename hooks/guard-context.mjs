#!/usr/bin/env node
// PreToolUse advisory: warn when the session's context has grown large.
//
// Hooks receive no token-usage field, but they do receive `transcript_path`.
// We tail the transcript, take the most recent assistant `usage`, and compute
// context = input + cache_read + cache_creation.
//
// Emits additionalContext only. It NEVER emits permissionDecision — returning
// "allow" would bypass the user's normal permission prompts.

import { openSync, fstatSync, readSync, closeSync } from 'node:fs';

const WARN = 250_000;
const TAIL = 96 * 1024;        // first read
const MAX_TAIL = 8 * 1024 * 1024;  // grow until a usage row is found (huge tool
                                   // results can fill the tail with no usage line)

const read = async () => {
  let s = '';
  for await (const c of process.stdin) s += c;
  return s;
};

// Last assistant usage in the transcript. Rows are duplicated per content block
// (each carries the same usage), so the newest one is authoritative.
const lastCtx = (path) => {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    for (let want = TAIL; ; want *= 4) {
      const len = Math.min(want, size);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      // Drop the first line unless we read the whole file — it may be truncated.
      const start = len < size ? 1 : 0;
      for (let i = lines.length - 1; i >= start; i--) {
        const l = lines[i];
        if (!l || !l.includes('"usage"')) continue;
        let d;
        try { d = JSON.parse(l); } catch { continue; }
        const u = d?.message?.usage;
        if (!u) continue;
        return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) +
               (u.cache_creation_input_tokens || 0);
      }
      if (len >= size || want >= MAX_TAIL) break;   // whole file scanned, or give up
    }
  } catch { /* fall through */ } finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
  return 0;
};

const main = async () => {
  let ev = {};
  try { ev = JSON.parse((await read()) || '{}'); } catch { process.exit(0); }
  if (ev.agent_id) process.exit(0);              // subagents have their own context
  if (!ev.transcript_path) process.exit(0);

  const ctx = lastCtx(ev.transcript_path);
  if (ctx < WARN) process.exit(0);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext:
        `[context-guard] This session is at ~${Math.round(ctx / 1000)}k tokens. ` +
        `Every tool call re-reads all of it. Before continuing: batch independent ` +
        `tool calls into one message, push fan-out reads into an Explore subagent, ` +
        `and consider /compact if the early context is no longer load-bearing.`,
    },
  }));
  process.exit(0);
};

main().catch(() => process.exit(0));

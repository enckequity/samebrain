// Shared parser for smartloop state files (~/.smartloop/<slug>/state.md).
// Frontmatter is line-based key: value — no YAML lib, no deps.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const stateDir = () => process.env.SMARTLOOP_DIR ?? join(homedir(), '.smartloop');

export function readRuns(dir = stateDir()) {
  if (!existsSync(dir)) return [];
  const runs = [];
  for (const slug of readdirSync(dir)) {
    const p = join(dir, slug, 'state.md');
    if (!existsSync(p)) continue;
    const m = readFileSync(p, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) continue;
    const fm = { slug };
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([a-z_]+):\s*(.*)$/);
      if (kv) fm[kv[1]] = kv[2].trim();
    }
    runs.push(fm);
  }
  return runs;
}

export const isNonTerminal = (r) => r.status === 'working' || (r.status ?? '').startsWith('waiting');

export const hasLiveWake = (r) => {
  if (r.next_wake === 'parked') return true;
  const ts = Date.parse(r.next_wake ?? '');
  return Number.isFinite(ts) && ts > Date.now();
};

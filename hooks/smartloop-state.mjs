// Shared parser for smartloop state files (~/.smartloop/<slug>/state.md).
// Frontmatter is line-based key: value — no YAML lib, no deps.
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const stateDir = () => process.env.SMARTLOOP_DIR ?? join(homedir(), '.smartloop');

export function readRuns(dir = stateDir()) {
  let slugs;
  try { slugs = readdirSync(dir); } catch { return []; }
  const runs = [];
  for (const slug of slugs) {
    let text;
    try { text = readFileSync(join(dir, slug, 'state.md'), 'utf8'); } catch { continue; }
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) continue;
    const fm = {};
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([a-z_]+):\s*(.*)$/);
      if (kv) fm[kv[1]] = kv[2].trim();
    }
    fm.slug = slug; // directory name is authoritative — frontmatter cannot spoof it
    // Journal size = rehydrate-cost proxy for portfolio ordering. Computed, not parsed —
    // frontmatter cannot spoof it either.
    fm.journal_lines = 0;
    const ji = text.indexOf('\n## Journal');
    if (ji !== -1) {
      const rest = text.slice(ji + '\n## Journal'.length);
      const next = rest.indexOf('\n## ');
      const body = next === -1 ? rest : rest.slice(0, next);
      fm.journal_lines = body.split(/\r?\n/).filter((l) => l.trim()).length;
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

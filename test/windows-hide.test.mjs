import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Hooks spawn these modules `detached`, which on Windows leaves them without a console. Any console
// program they launch (git) then gets a fresh, visible console window unless `windowsHide` is set —
// the rapid terminal flashes seen after every session end.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const backgroundModules = ['hooks/hindsight.mjs', 'bin/hindsight-backfill.mjs'];

for (const rel of backgroundModules) {
  const source = readFileSync(join(root, rel), 'utf8');
  const calls = [...source.matchAll(/execFileSync\(/g)].map((m) => source.slice(m.index, source.indexOf(')', source.indexOf('}', m.index))));
  assert.ok(calls.length > 0, `${rel}: expected child-process calls`);
  for (const call of calls) assert.match(call, /windowsHide:\s*true/, `${rel}: ${call.split('\n')[0]} must pass windowsHide: true`);
}

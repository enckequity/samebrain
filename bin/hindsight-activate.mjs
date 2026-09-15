#!/usr/bin/env node
// One-time Hindsight activation for THIS machine, after setting "enabled": true in
// global/hindsight.json and putting HINDSIGHT_API_URL and HINDSIGHT_API_KEY in secrets.env. Idempotent; re-run after bumping versions in global/hindsight.json.
//   node bin/hindsight-activate.mjs            stage runtime, retire the old Claude plugin, render
//   node bin/hindsight-activate.mjs --check    report what is missing, change nothing
//
// 1. Stages the pinned @vectorize-io/hindsight-coding-agents tarball into ~/.hindsight/coding-agents
//    after verifying its registry integrity hash (the npx installer is never run: render owns wiring).
// 2. Retires the superseded hindsight-memory Claude Code plugin (uninstall, marketplace, its config).
// 3. Runs bin/render.mjs, which wires hooks and MCP once the runtime is present, then applies the
//    bank setup (knowledge pages, directives) with bin/hindsight-banks.mjs.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hindsightRequest, loadHindsight } from '../hooks/hindsight.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHECK = process.argv.includes('--check');
const HOME = homedir();
const expand = (p) => (p === '~' ? HOME : p.startsWith('~/') ? join(HOME, p.slice(2)) : p);
const fail = (msg) => { console.error(`hindsight-activate: ${msg}`); process.exit(1); };

const hs = loadHindsight(ROOT);
if (!hs) fail('Hindsight is not enabled: set "enabled": true in global/hindsight.json and HINDSIGHT_API_URL + HINDSIGHT_API_KEY (environment or secrets.env) first');
const { codingAgents: ca } = hs.settings;
const missing = [];

// ---- server reachability (informational; activation does not need the server) ----
try {
  const health = await hindsightRequest(hs, 'GET', '/health', undefined, 5000);
  console.log(`server: ${hs.url} health ${health.status}`);
} catch (err) {
  console.log(`server: ${hs.url} unreachable (${err.message}) — hooks stay fail-silent until it is up`);
}

// ---- 1. coding-agents runtime ----
const runtime = expand(ca.runtimeDir);
const staged = (() => {
  try { return JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf8')).version; } catch { return null; }
})();
if (staged === ca.version) {
  console.log(`runtime: ${ca.package}@${ca.version} already staged at ${runtime}`);
} else if (CHECK) {
  missing.push(`runtime ${staged ?? 'missing'} (want ${ca.version})`);
} else {
  const work = mkdtempSync(join(tmpdir(), 'samebrain-hindsight-'));
  try {
    execFileSync('npm', ['pack', `${ca.package}@${ca.version}`, '--pack-destination', work, '--silent'], {
      stdio: ['ignore', 'ignore', 'inherit'], timeout: 120000,
    });
    const tgz = readdirSync(work).find((f) => f.endsWith('.tgz'));
    if (!tgz) fail('npm pack produced no tarball');
    const digest = `sha512-${createHash('sha512').update(readFileSync(join(work, tgz))).digest('base64')}`;
    if (digest !== ca.integrity) fail(`integrity mismatch for ${ca.package}@${ca.version}: got ${digest}`);
    execFileSync('tar', ['-xzf', join(work, tgz), '-C', work], { timeout: 60000 });
    rmSync(runtime, { recursive: true, force: true });
    cpSync(join(work, 'package'), runtime, { recursive: true });
    // Not an npx install: the runtime's own auto-update only ever replaces npx-staged copies.
    writeFileSync(join(runtime, '.install-origin.json'), `${JSON.stringify({ source: 'samebrain', version: ca.version })}\n`);
    console.log(`runtime: staged ${ca.package}@${ca.version} at ${runtime} (integrity verified)`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---- 2. retire the superseded hindsight-memory Claude Code plugin ----
// Upstream no longer develops it; the runtime's hooks + MCP replace it, so keeping both would
// duplicate injections and tools. Render removes its settings declaration; this removes the install.
const retired = hs.settings.retiredClaudePlugin;
if (retired) {
  const pluginId = `${retired.plugin}@${retired.marketplace}`;
  const readJsonOr = (p, fallback) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } };
  const installed = pluginId in (readJsonOr(join(HOME, '.claude', 'plugins', 'installed_plugins.json'), {}).plugins ?? {});
  const marketplace = retired.marketplace in readJsonOr(join(HOME, '.claude', 'plugins', 'known_marketplaces.json'), {});
  const config = expand(retired.configFile);
  if (CHECK) {
    if (installed || marketplace || existsSync(config)) missing.push(`retired ${pluginId} still present`);
  } else {
    const claude = (args) => spawnSync('claude', args, { stdio: 'inherit', timeout: 180000 });
    if (installed && claude(['plugin', 'uninstall', pluginId, '--scope', 'user']).status !== 0) fail(`claude plugin uninstall ${pluginId} failed`);
    if (marketplace && claude(['plugin', 'marketplace', 'remove', retired.marketplace]).status !== 0) fail(`claude plugin marketplace remove ${retired.marketplace} failed`);
    rmSync(config, { force: true }); // it held the API key
    rmSync(join(HOME, '.claude', 'plugins', 'data', `${retired.plugin}-${retired.marketplace}`), { recursive: true, force: true });
    if (installed || marketplace) console.log(`claude: retired ${pluginId}`);
  }
}

if (CHECK) {
  console.log(missing.length ? `missing: ${missing.join('; ')}` : 'hindsight: fully activated');
  process.exit(missing.length ? 1 : 0);
}

// ---- 3. render wires hooks now that the runtime exists, then the server-side bank setup ----
const render = spawnSync(process.execPath, [join(ROOT, 'bin', 'render.mjs')], { stdio: 'inherit' });
if (render.status !== 0) process.exit(render.status ?? 1);
const banks = spawnSync(process.execPath, [join(ROOT, 'bin', 'hindsight-banks.mjs')], { stdio: 'inherit' });
process.exit(banks.status ?? 1);

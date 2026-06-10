#!/usr/bin/env node
// Mechanical claim protocol for multi-agent coordination — enforces what
// global/coordination.md describes. Leases are JSON files in git
// (coordination/leases/<scope>.lease: {owner, expires}); no daemon, expiry by timestamp.
//
//   node hooks/lease-check.mjs claim <scope> --owner <id> [--ttl <seconds>]
//       exit 0 = claimed/renewed, exit 2 = held by someone else (stderr names the holder)
//   node hooks/lease-check.mjs release <scope> --owner <id>
//       exit 0 = released (or not held), exit 2 = held by a different owner
//   node hooks/lease-check.mjs check <scope>
//       prints holder state, exit 2 if live-held, 0 if free/expired
//
// Commit the lease file like any other change so other machines see the claim.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const [action, scopeRaw] = process.argv.slice(2);
const arg = (name) => { const i = process.argv.indexOf(name); return i === -1 ? null : process.argv[i + 1]; };
const fail = (msg, code = 1) => { console.error(`lease: ${msg}`); process.exit(code); };

if (!['claim', 'release', 'check'].includes(action) || !scopeRaw) {
  fail('usage: lease-check.mjs claim|release|check <scope> [--owner <id>] [--ttl <seconds>]');
}
const scope = scopeRaw.toLowerCase().replaceAll(/[^a-z0-9._-]/g, '-');
const leaseFile = join(ROOT, 'coordination', 'leases', `${scope}.lease`);

let lease = null;
if (existsSync(leaseFile)) {
  try { lease = JSON.parse(readFileSync(leaseFile, 'utf8')); } catch { lease = null; /* malformed = no lease */ }
}
const now = new Date().toISOString();
const live = lease && lease.expires > now;

if (action === 'check') {
  if (live) { console.error(`lease: ${scope} held by ${lease.owner} until ${lease.expires}`); process.exit(2); }
  console.log(`lease: ${scope} is free${lease ? ` (expired ${lease.expires})` : ''}`);
  process.exit(0);
}

const owner = arg('--owner');
if (!owner) fail(`${action} requires --owner <id>`);

if (action === 'claim') {
  if (live && lease.owner !== owner) {
    fail(`${scope} held by ${lease.owner} until ${lease.expires} — pick another task or wait`, 2);
  }
  const ttl = Number(arg('--ttl') ?? 3600);
  if (!Number.isFinite(ttl) || ttl <= 0) fail('--ttl must be a positive number of seconds');
  mkdirSync(dirname(leaseFile), { recursive: true });
  const expires = new Date(Date.now() + ttl * 1000).toISOString();
  writeFileSync(leaseFile, `${JSON.stringify({ owner, expires }, null, 2)}\n`);
  console.log(`lease: ${scope} claimed by ${owner} until ${expires}`);
} else { // release
  if (live && lease.owner !== owner) fail(`${scope} held by ${lease.owner}, not ${owner} — not released`, 2);
  if (existsSync(leaseFile)) rmSync(leaseFile);
  console.log(`lease: ${scope} released`);
}

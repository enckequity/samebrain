// Hindsight client shared by recall.mjs, bin/memory-search.mjs and bin/hindsight-backfill.mjs.
// Opt-in: everything here is inert unless global/hindsight.json sets enabled: true and the API URL and
// key resolve (environment first, then the gitignored secrets.env). Every network call is bounded and never throws to the caller —
// memory is an enhancement, the git index stays the floor.
import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const stripBom = (s) => (s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s);

export function readSecretsFile(root) {
  const out = {};
  const file = join(root, 'secrets.env');
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2];
  }
  return out;
}

export function loadSettings(root) {
  const p = join(root, 'global', 'hindsight.json');
  return existsSync(p) ? JSON.parse(stripBom(readFileSync(p, 'utf8'))) : null;
}

// { url, key, settings } when Hindsight is configured on this machine, else null.
export function loadHindsight(root, env = process.env) {
  if (env.SAMEBRAIN_HINDSIGHT === '0') return null;
  let settings;
  try { settings = loadSettings(root); } catch { return null; }
  if (settings?.enabled !== true) return null;
  const secrets = readSecretsFile(root);
  const pick = (name) => env[name] ?? secrets[name];
  const url = pick(settings.apiUrlEnv);
  const key = pick(settings.apiKeyEnv);
  if (!url || !key) return null;
  if (!/^https?:\/\//.test(url)) return null;
  return { url: url.replace(/\/+$/, ''), key, settings };
}

const expandHome = (p) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
const real = (p) => { try { return realpathSync(p); } catch { return p; } };

// Repository name exactly as both upstream plugins derive it: the main worktree's basename from
// `git rev-parse --git-common-dir`, so linked worktrees share one bank. null outside a repository.
export function repoName(dir) {
  try {
    const common = execFileSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    if (!common) return null;
    const name = basename(common);
    return name === '.git' || name.startsWith('.') ? basename(dirname(common)) : name;
  } catch {
    return null;
  }
}

// Bank for a session directory: settings.nonRepoDirs route to the global bank, a repository to its
// name, anything else to the directory basename (the plugins' non-repository fallback).
export function bankForCwd(cwd, settings) {
  const dir = real(cwd || process.cwd());
  const nonRepo = (settings.nonRepoDirs ?? []).map((d) => real(expandHome(d)));
  if (nonRepo.includes(dir)) return settings.globalBank;
  return repoName(dir) ?? (basename(dir) || settings.globalBank);
}

// Mirrors _REDACTION_PATTERNS in hindsight_api/extensions/memory_defense.py (v0.10.0) so content
// is scrubbed before it leaves the machine, not only after it reaches the server.
const tok = (body) => `(?<![A-Za-z0-9_])${body}(?![A-Za-z0-9_])`;
export const REDACTION_PATTERNS = [
  ['anthropic_key', tok('sk-ant-[A-Za-z0-9_-]{20,}')],
  ['openai_project_key', tok('sk-proj-[A-Za-z0-9_-]{48,}')],
  ['openai_admin_key', tok('sk-admin-[A-Za-z0-9_-]{40,}')],
  ['openai_key', tok('sk-[A-Za-z0-9_-]{20,}')],
  ['google_api_key', tok('AIza[0-9A-Za-z_-]{35}')],
  ['google_oauth_token', tok('ya29\\.[0-9A-Za-z_-]{20,}')],
  ['xai_key', tok('xai-[A-Za-z0-9]{40,}')],
  ['groq_key', tok('gsk_[A-Za-z0-9]{20,}')],
  ['huggingface_token', tok('hf_[A-Za-z0-9]{30,}')],
  ['replicate_token', tok('r8_[A-Za-z0-9]{30,}')],
  ['perplexity_key', tok('pplx-[A-Za-z0-9]{40,}')],
  ['databricks_token', tok('dapi[A-Za-z0-9]{32}')],
  ['aws_access_key', tok('AKIA[0-9A-Z]{16}')],
  ['aws_session_token', tok('ASIA[0-9A-Z]{16}')],
  ['aws_secret_key', 'aws(.{0,20})?(secret|private)?[\\s_-]?access[\\s_-]?key[\\s_-]?[:=][\\s"\']*([A-Za-z0-9/+=]{40})', 'i'],
  ['digitalocean_token', tok('dop_v1_[a-f0-9]{64}')],
  ['github_fg_pat', tok('github_pat_[A-Za-z0-9_]{60,}')],
  ['github_token', tok('ghp_[A-Za-z0-9]{36}')],
  ['github_app_token', tok('ghs_[A-Za-z0-9]{36}')],
  ['github_user_token', tok('ghu_[A-Za-z0-9]{36}')],
  ['github_refresh', tok('ghr_[A-Za-z0-9]{36}')],
  ['github_oauth', tok('gho_[A-Za-z0-9]{36}')],
  ['gitlab_pat', tok('glpat-[A-Za-z0-9_-]{20,}')],
  ['npm_token', tok('npm_[A-Za-z0-9]{30,}')],
  ['pypi_token', tok('pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{20,}')],
  ['stripe_secret', tok('sk_(?:live|test)_[A-Za-z0-9]{20,}')],
  ['stripe_restricted', tok('rk_(?:live|test)_[A-Za-z0-9]{20,}')],
  ['square_token', tok('sq0[a-z]{3}-[A-Za-z0-9_-]{22,}')],
  ['braintree_token', tok('access_token\\$production\\$[a-z0-9]{16}\\$[a-f0-9]{32}')],
  ['slack_token', tok('xox[abpr]-[0-9A-Za-z-]{10,}')],
  ['slack_webhook', 'https://hooks\\.slack\\.com/services/T[A-Za-z0-9_]{8,}/B[A-Za-z0-9_]{8,}/[A-Za-z0-9_]{20,}'],
  ['twilio_api_key', tok('SK[0-9a-fA-F]{32}')],
  ['twilio_account_sid', tok('AC[0-9a-fA-F]{32}')],
  ['sendgrid_key', tok('SG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}')],
  ['mailgun_key', tok('key-[A-Za-z0-9]{32}')],
  ['discord_bot', tok('[MNO][A-Za-z0-9]{23}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{27}')],
  ['telegram_bot', tok('[0-9]{8,10}:[A-Za-z0-9_-]{35}')],
  ['shopify_token', tok('shpat_[a-fA-F0-9]{32}')],
  ['db_url_postgres', 'postgres(?:ql)?://[^\\s:/@]+:[^\\s/@]+@[^\\s]+'],
  ['db_url_mysql', 'mysql://[^\\s:/@]+:[^\\s/@]+@[^\\s]+'],
  ['db_url_mongodb', 'mongodb(?:\\+srv)?://[^\\s:/@]+:[^\\s/@]+@[^\\s]+'],
  ['private_key_pem', '-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----'],
  ['jwt', tok('eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}')],
  ['credit_card', tok('(?:\\d{4}[ -]?){3}\\d{1,4}')],
  ['ssn_us', tok('\\d{3}-\\d{2}-\\d{4}')],
];
// Additions the server has no rule for: the PEM rule above only replaces the header line, so a
// key body would survive; op:// references name secret locations.
const LOCAL_PATTERNS = [
  ['private_key_block', '-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY( BLOCK)?-----'],
  ['op_reference', 'op://[^\\s"\'`]+'],
];
const COMPILED = [...LOCAL_PATTERNS, ...REDACTION_PATTERNS]
  .map(([label, src, flags = '']) => [label, new RegExp(src, `g${flags}`)]);

export function scrub(text) {
  let out = text;
  for (const [label, re] of COMPILED) out = out.replace(re, `[REDACTED:${label}]`);
  return out;
}

export async function hindsightRequest(hs, method, path, body, timeoutMs = 10000) {
  const res = await fetch(`${hs.url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${hs.key}`, 'Content-Type': 'application/json', 'User-Agent': 'samebrain' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  return { status: res.status, ok: res.ok, json, text };
}

export const bankPath = (bank) => `/v1/default/banks/${encodeURIComponent(bank)}`;

// Recall facts for one bank. Returns [] on any failure (timeout, auth, offline). Consolidation lags
// retain, so all fact types are asked for with observations preferred rather than observations only.
export async function recall(hs, bank, query, { budget = 'low', maxTokens = 800, types, preferObservations, timeoutMs = 2500 } = {}) {
  try {
    const body = { query: query.slice(0, 800), budget, max_tokens: maxTokens };
    if (types?.length) body.types = types;
    if (preferObservations) body.prefer_observations = true;
    const r = await hindsightRequest(hs, 'POST', `${bankPath(bank)}/memories/recall`, body, timeoutMs);
    if (!r.ok || !Array.isArray(r.json?.results)) return [];
    return r.json.results.filter((x) => typeof x?.text === 'string' && x.text.trim());
  } catch {
    return [];
  }
}

// Read named knowledge pages (a stored-document read: no retrieval, no synthesis). Returns
// [{ name, body }] in the order asked, skipping pages that are missing or still empty.
export async function readPages(hs, bank, names, { maxCharsPerPage = 1800, timeoutMs = 2500 } = {}) {
  try {
    const tree = await hindsightRequest(hs, 'GET', `${bankPath(bank)}/knowledge-base/tree`, undefined, timeoutMs);
    if (!tree.ok) return [];
    const flat = [];
    const walk = (nodes) => { for (const n of nodes ?? []) { flat.push(n); walk(n.children); } };
    walk(tree.json?.roots);
    const pages = await Promise.all(names.map(async (name) => {
      const node = flat.find((n) => n.kind === 'page' && n.name === name);
      if (!node) return null;
      const r = await hindsightRequest(hs, 'GET', `${bankPath(bank)}/knowledge-base/pages/${encodeURIComponent(node.id)}`, undefined, timeoutMs);
      const body = r.ok ? String(r.json?.body ?? '').trim() : '';
      if (!body || body === 'Generating content...') return null;
      return { name, body: body.length > maxCharsPerPage ? `${body.slice(0, maxCharsPerPage)}\n…(truncated)` : body };
    }));
    return pages.filter(Boolean);
  } catch {
    return [];
  }
}

// Last successful session-start recall and knowledge pages per bank (stale-while-revalidate).
// Owner-only: it holds memory text. Written atomically so a background refresher never leaves a
// torn file; each part keeps its last good value when a refresh returns nothing for it.
const cacheFile = (bank) => join(homedir(), '.hindsight', 'samebrain-recall-cache', `${encodeURIComponent(bank)}.json`);

export function readRecallCache(bank) {
  try {
    const c = JSON.parse(readFileSync(cacheFile(bank), 'utf8'));
    if (typeof c.at !== 'string') return null;
    return { at: c.at, results: Array.isArray(c.results) ? c.results : [], pages: Array.isArray(c.pages) ? c.pages : [] };
  } catch {
    return null;
  }
}

export function writeRecallCache(bank, { results = [], pages = [] } = {}) {
  if (!results.length && !pages.length) return; // keep the last good cache rather than an empty one
  const previous = readRecallCache(bank);
  const next = {
    at: new Date().toISOString(),
    results: results.length ? results : (previous?.results ?? []),
    pages: pages.length ? pages : (previous?.pages ?? []),
  };
  const file = cacheFile(bank);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

// Single flight per bank on this machine: many sessions starting at once share one live recall
// (and one background refresh) instead of each sending its own. A holder that died leaves a lock
// that expires after ttlMs.
const lockFile = (bank) => `${cacheFile(bank)}.lock`;

export function claimRecall(bank, ttlMs = 60000) {
  const file = lockFile(bank);
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    try {
      if (Date.now() - statSync(file).mtimeMs < ttlMs) return false;
      writeFileSync(file, String(process.pid), { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }
}

export function releaseRecall(bank) {
  try { if (readFileSync(lockFile(bank), 'utf8') === String(process.pid)) rmSync(lockFile(bank)); } catch { /* already gone */ }
}

export function ageLabel(iso, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

export function formatResults(results) {
  return results
    .map((r) => {
      const when = r.mentioned_at ? ` (${String(r.mentioned_at).slice(0, 10)})` : '';
      return `- ${r.text.replace(/\s*\n\s*/g, ' ').trim()}${r.type ? ` [${r.type}]` : ''}${when}`;
    })
    .join('\n');
}

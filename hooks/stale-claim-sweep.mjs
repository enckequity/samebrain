#!/usr/bin/env node
// Stale agent-claim sweep for multi-agent coordination — the issue-side mirror of
// lease-check.mjs. The `agent:*` label is a soft mutex; nothing prunes it when the
// claiming agent's branch/PR dies or it wanders off, so claims silently rot.
//
// This flags — never auto-declaims — any open issue whose `agent:*` claim is no longer
// backed by a live PR and has gone quiet, per coordination.md (>24h + no linked PR = fair game):
//   • adds a `stale-claim` label + one idempotent comment naming the dead claim
//   • self-heals: clears `stale-claim` again once a live PR appears or activity resumes
// A human/agent still decides whether to reclaim or drop the `agent:*` label.
//
//   node hooks/stale-claim-sweep.mjs [--repo owner/name] [--ttl-hours 24] [--apply]
//       --repo (or SWEEP_REPO) defaults to the GitHub repo of the current directory.
//       default is DRY-RUN (prints what it would do); pass --apply to mutate.
//       exit 0 always (report-only); exit 1 on hard error (gh missing / not authed).
// Every call is a scoped `gh api` REST request on repos/{owner}/{repo} with explicit page
// numbers. Some cloud sandboxes proxy GitHub with a placeholder credential that blocks GraphQL
// and `gh auth status`, and Link headers can point at numeric repository paths the proxy rejects.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const MARKER = '<!-- stale-claim-sweep -->';

export function sweepCommentState(comments, login, updatedAt) {
  const own = comments.filter((comment) => comment.author?.login === login && comment.body.includes(MARKER));
  const latest = own.reduce((found, comment) => !found || Date.parse(comment.updatedAt ?? comment.createdAt) > Date.parse(found.updatedAt ?? found.createdAt) ? comment : found, null);
  const stamp = latest ? Date.parse(latest.updatedAt ?? latest.createdAt) : 0;
  return { commentId: latest?.id ?? null, commented: own.length > 0, sweepOnlyActivity: stamp > 0 && Date.parse(updatedAt) <= stamp };
}

function main() {
const arg = (name, def = null) => { const i = process.argv.indexOf(name); return i === -1 ? def : process.argv[i + 1]; };
const has = (name) => process.argv.includes(name);

let REPO = arg('--repo', process.env.SWEEP_REPO ?? null);
const TTL_HOURS = Number(arg('--ttl-hours', 24));
const APPLY = has('--apply');
const STALE_LABEL = 'stale-claim';

const gh = (args, { json = true } = {}) => {
  let out;
  try { out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); }
  catch (error) {
    // Do not dump partial issue/comment bodies from a failed transport.
    const failure = new Error(`GitHub REST request failed: ${args[1]} (exit ${error.status ?? 'unknown'})`);
    failure.stderr = String(error.stderr ?? '').trim();
    throw failure;
  }
  return json ? JSON.parse(out || 'null') : out;
};

// GitHub Link headers can point to repositories/{numeric-id}, which the cloud
// proxy rejects. Keep every page on the explicitly attached owner/repo path.
const pages = (endpoint) => {
  const result = [];
  for (let page = 1; ; page++) {
    const batch = gh(['api', `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`]);
    if (!Array.isArray(batch)) throw new Error(`Expected a GitHub REST page: ${endpoint}`);
    result.push(...batch);
    if (batch.length < 100) return result;
  }
};

// Verify an actual REST request: cloud proxies inject a placeholder credential,
// which gh auth status rejects even when scoped API requests are authenticated.
let login;
try { login = gh(['api', 'user']).login; }
catch { console.error('stale-claim-sweep: GitHub REST authentication unavailable'); process.exit(1); }

// Without --repo, use the current directory's GitHub repo (this lookup is GraphQL, so pass
// --repo where GraphQL is blocked).
if (!REPO) {
  try { REPO = JSON.parse(execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner'], { encoding: 'utf8' })).nameWithOwner; }
  catch { console.error('stale-claim-sweep: not in a GitHub repo; pass --repo owner/name'); process.exit(1); }
}

// ensure the flag label exists (idempotent)
if (APPLY) {
  try {
    gh(['api', `repos/${REPO}/labels/${STALE_LABEL}`]);
  } catch (error) {
    if (!/HTTP 404\b/.test(String(error.stderr ?? ''))) throw error;
    gh(['api', `repos/${REPO}/labels`, '--method', 'POST', '-f', `name=${STALE_LABEL}`,
      '-f', 'color=d93f0b', '-f', 'description=agent claim no longer backed by a live PR (auto-flagged)']);
  }
}

// REST works under the documented proxy; GraphQL issue/pr commands do not.
const openIssues = pages(`repos/${REPO}/issues?state=open`).filter(issue => !issue.pull_request).slice(0, 300)
  .map(issue => ({ ...issue, updatedAt: issue.updated_at }));
const openPrs = pages(`repos/${REPO}/pulls?state=open`);

const cutoffMs = TTL_HOURS * 3600 * 1000;
const nowMs = Date.now();
let flagged = 0, cleared = 0, live = 0;

for (const issue of openIssues) {
  const labels = issue.labels.map((l) => l.name);
  const claim = labels.find((n) => n.startsWith('agent:'));
  if (!claim) continue; // only care about claimed issues

  // liveness signal 1: any OPEN PR referencing this issue
  const reference = new RegExp(`(^|[^0-9])${issue.number}(?![0-9])`);
  const hasLivePr = openPrs.some(pr => reference.test(pr.body ?? ''));
  // liveness signal 2: recent activity (claim/comment/edit) within the TTL window
  const alreadyFlagged = labels.includes(STALE_LABEL);
  const ageQuiet = (nowMs - Date.parse(issue.updatedAt)) > cutoffMs;
  const comments = !hasLivePr && (alreadyFlagged || ageQuiet)
    ? pages(`repos/${REPO}/issues/${issue.number}/comments`).map((comment) => ({
      id: comment.id, author: { login: comment.user?.login }, body: comment.body,
      createdAt: comment.created_at, updatedAt: comment.updated_at,
    }))
    : [];
  const sweep = sweepCommentState(comments, login, issue.updatedAt);
  // Our label/comment must not look like the claim holder resuming work.
  const quiet = ageQuiet || (alreadyFlagged && sweep.sweepOnlyActivity);

  if (hasLivePr || !quiet) {
    live++;
    if (alreadyFlagged) { // self-heal: it came back to life
      cleared++;
      console.log(`  CLEAR  #${issue.number} [${claim}] revived (${hasLivePr ? 'open PR' : 'recent activity'})`);
      if (APPLY) gh(['api', `repos/${REPO}/issues/${issue.number}/labels/${STALE_LABEL}`, '--method', 'DELETE']);
    }
    continue;
  }

  if (alreadyFlagged) continue; // stale and already flagged — don't re-comment
  flagged++;
  const ageH = Math.round((nowMs - Date.parse(issue.updatedAt)) / 3600000);
  console.log(`  FLAG   #${issue.number} [${claim}] no live PR, quiet ${ageH}h — "${issue.title}"`);
  if (APPLY) {
    gh(['api', `repos/${REPO}/issues/${issue.number}/labels`, '--method', 'POST', '-f', `labels[]=${STALE_LABEL}`]);
    const body = `${MARKER}\n**Stale claim (auto-flagged ${new Date().toISOString().slice(0, 10)}).** This issue carries \`${claim}\` but has no open PR referencing it and no activity for ${ageH}h — per the coordination protocol (\`>24h + no linked PR = fair game\`) the claim is no longer backed by live work and is reclaimable.\n\nIf you're still on it: open (or link) a PR that references this issue, or comment to keep the claim. Otherwise the \`agent:*\` label should be dropped so the next agent can pick it up. This flag clears itself automatically once a live PR or fresh activity appears.`;
    if (sweep.commentId) {
      // Refresh our existing warning after reflagging; preserve one comment and
      // include this label mutation in the sweep's own activity timestamp.
      gh(['api', `repos/${REPO}/issues/comments/${sweep.commentId}`, '--method', 'PATCH', '-f', `body=${body}`]);
    } else {
      gh(['api', `repos/${REPO}/issues/${issue.number}/comments`, '--method', 'POST', '-f', `body=${body}`]);
    }
  }
}

console.log(`\nstale-claim-sweep (${APPLY ? 'APPLIED' : 'dry-run'}) on ${REPO}: ` +
  `${flagged} flagged, ${cleared} cleared, ${live} live claims, ${openIssues.length} open issues scanned.`);

}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

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
import { execFileSync } from 'node:child_process';

const arg = (name, def = null) => { const i = process.argv.indexOf(name); return i === -1 ? def : process.argv[i + 1]; };
const has = (name) => process.argv.includes(name);

const REPO_ARG = arg('--repo', process.env.SWEEP_REPO ?? null);
const TTL_HOURS = Number(arg('--ttl-hours', 24));
const APPLY = has('--apply');
const MARKER = '<!-- stale-claim-sweep -->';
const STALE_LABEL = 'stale-claim';

const gh = (args, { json = true } = {}) => {
  const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return json ? JSON.parse(out || 'null') : out;
};

// preflight
try { gh(['auth', 'status'], { json: false }); }
catch { console.error('stale-claim-sweep: gh not installed or not authenticated'); process.exit(1); }

let REPO = REPO_ARG;
if (!REPO) {
  try { REPO = gh(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner; }
  catch { console.error('stale-claim-sweep: not in a GitHub repo; pass --repo owner/name'); process.exit(1); }
}

// ensure the flag label exists (idempotent)
if (APPLY) {
  try {
    gh(['label', 'create', STALE_LABEL, '-R', REPO, '--color', 'd93f0b',
        '--description', 'agent claim no longer backed by a live PR (auto-flagged)'], { json: false });
  } catch { /* already exists */ }
}

const openIssues = gh(['issue', 'list', '-R', REPO, '--state', 'open', '--limit', '300',
  '--json', 'number,title,labels,updatedAt']);

const cutoffMs = TTL_HOURS * 3600 * 1000;
const nowMs = Date.now();
let flagged = 0, cleared = 0, live = 0;

for (const issue of openIssues) {
  const labels = issue.labels.map((l) => l.name);
  const claim = labels.find((n) => n.startsWith('agent:'));
  if (!claim) continue; // only care about claimed issues

  // liveness signal 1: any OPEN PR referencing this issue
  const prs = gh(['pr', 'list', '-R', REPO, '--state', 'open', '--search', `${issue.number} in:body`,
    '--json', 'number', '-q', '[.[].number]']);
  const hasLivePr = Array.isArray(prs) && prs.length > 0;
  // liveness signal 2: recent activity (claim/comment/edit) within the TTL window
  const quiet = (nowMs - Date.parse(issue.updatedAt)) > cutoffMs;
  const alreadyFlagged = labels.includes(STALE_LABEL);
  // The sweep's own label and comment bump updatedAt, so a flagged issue revives only on a
  // live PR or a comment posted after the flag — otherwise it would clear and re-flag forever.
  const revivedByComment = () => {
    const { comments = [] } = gh(['issue', 'view', String(issue.number), '-R', REPO, '--json', 'comments']) ?? {};
    const flaggedAt = Math.max(0, ...comments.filter((c) => c.body.includes(MARKER)).map((c) => Date.parse(c.createdAt)));
    return comments.some((c) => !c.body.includes(MARKER) && Date.parse(c.createdAt) > flaggedAt);
  };
  const active = alreadyFlagged ? !hasLivePr && revivedByComment() : !quiet;

  if (hasLivePr || active) {
    live++;
    if (alreadyFlagged) { // self-heal: it came back to life
      cleared++;
      console.log(`  CLEAR  #${issue.number} [${claim}] revived (${hasLivePr ? 'open PR' : 'recent activity'})`);
      if (APPLY) gh(['issue', 'edit', String(issue.number), '-R', REPO, '--remove-label', STALE_LABEL], { json: false });
    }
    continue;
  }

  if (alreadyFlagged) continue; // stale and already flagged — don't re-comment
  flagged++;
  const ageH = Math.round((nowMs - Date.parse(issue.updatedAt)) / 3600000);
  console.log(`  FLAG   #${issue.number} [${claim}] no live PR, quiet ${ageH}h — "${issue.title}"`);
  if (APPLY) {
    gh(['issue', 'edit', String(issue.number), '-R', REPO, '--add-label', STALE_LABEL], { json: false });
    const body = `${MARKER}\n**Stale claim (auto-flagged ${new Date().toISOString().slice(0, 10)}).** This issue carries \`${claim}\` but has no open PR referencing it and no activity for ${ageH}h — per the coordination protocol (\`>24h + no linked PR = fair game\`) the claim is no longer backed by live work and is reclaimable.\n\nIf you're still on it: open (or link) a PR that references this issue, or comment to keep the claim. Otherwise the \`agent:*\` label should be dropped so the next agent can pick it up. This flag clears itself automatically once a live PR or fresh activity appears.`;
    gh(['issue', 'comment', String(issue.number), '-R', REPO, '--body', body], { json: false });
  }
}

console.log(`\nstale-claim-sweep (${APPLY ? 'APPLIED' : 'dry-run'}) on ${REPO}: ` +
  `${flagged} flagged, ${cleared} cleared, ${live} live claims, ${openIssues.length} open issues scanned.`);

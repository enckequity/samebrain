// Shared contract for auto-continue (Claude Stop hook + opencode plugin).
// Autonomous sessions keep working until the agent declares a terminal state, so
// nobody has to type "keep going". Active inside agent-deck sessions
// (AGENTDECK_IDENTITY_FILE / AGENTDECK_INSTANCE_ID) or with AUTO_CONTINUE=1; AUTO_CONTINUE=0 always disables.
// Headless runs (claude -p, opencode run) never auto-continue, even when started from
// inside an autonomous session and inheriting its environment.

export const DONE = '===AGENTDECK_DONE==='; // agent-deck's own completion sentinel

export const MAX = (env = process.env) => {
  const n = Number(env.AUTO_CONTINUE_MAX);
  return Number.isInteger(n) && n > 0 ? n : 25;
};

export const enabled = (env = process.env, argv = process.argv) => {
  if (env.AUTO_CONTINUE === '0') return false;
  if (env.CLAUDE_CODE_ENTRYPOINT && env.CLAUDE_CODE_ENTRYPOINT !== 'cli') return false; // claude -p / SDK
  if (argv.slice(1).includes('run')) return false; // opencode run
  // agent-deck exports AGENTDECK_IDENTITY_FILE into the agent process; AGENTDECK_INSTANCE_ID
  // lives only in the tmux session environment (kept for --no-identity launches).
  return env.AUTO_CONTINUE === '1' || Boolean(env.AGENTDECK_IDENTITY_FILE || env.AGENTDECK_INSTANCE_ID);
};

// Only the last non-empty line counts, so quoting a marker mid-message does not end the run.
export const isTerminal = (text) => {
  if (typeof text !== 'string') return false;
  const last = text.trimEnd().split('\n').pop().trim();
  return last === DONE || /^(BLOCKED|WAITING):\s*\S/.test(last);
};

export const CONTRACT = [
  'Autonomous session: auto-continue is on.',
  'Work the task to a verified result without pausing for approval. Never ask "should I continue?" or offer next steps; do them, choosing the reasonable reversible option.',
  'End your final message with exactly one terminal marker on its own line:',
  `${DONE} (task verified complete, or you only answered a question)`,
  'BLOCKED: <reason> (needs the human: production deploy or data mutation, spending money, external messages, secrets, destructive git history, a missing credential)',
  'WAITING: <what> (background work you started will wake you)',
  'Any stop without a marker is automatically continued.',
].join('\n');

export const nudge = (n, max) =>
  `Auto-continue (${n}/${max}): you stopped without a terminal marker. Do not ask for permission; `
  + 'pick the reasonable reversible option and keep going toward a verified result. '
  + `If truly finished, verify, then end with ${DONE}. If blocked on something only the human can do, end with BLOCKED: <reason>.`;

// Question tools block on a dialog, which never looks like a stop, so autonomous
// sessions deny them and point the agent at the BLOCKED: marker instead.
export const QUESTION_TOOLS = new Set(['AskUserQuestion', 'question']);
export const QUESTION_DENIED = 'Autonomous session: do not ask the human. Choose the reasonable reversible option and continue. '
  + 'If only the human can unblock you, finish your message with BLOCKED: <reason>.';

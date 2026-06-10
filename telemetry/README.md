# telemetry

Session records, appended by `hooks/sync.mjs` at session end — one JSONL line per
session under `<machine>/<YYYY-MM>.jsonl` (ts, agent, machine, session_id,
cwd_hash, duration_s where the agent provides it). smartloop run summaries land in
`<machine>/smartloop-runs.jsonl`.

The public template ships this directory empty. Your instance commits its own
data here (synced by the same session hooks that sync memory) — keep your
instance repo private.

Hygiene: `node bin/render.mjs` warns when the current month exceeds 1MB;
`node bin/render.mjs --gc` rolls months older than 3 into per-month summary
lines in `<machine>/archive.jsonl`.

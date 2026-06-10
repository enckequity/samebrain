# smartloop: cross-machine resume

A smartloop run parked on one machine can resume on another. The state dir
(`$SMARTLOOP_DIR`, default `~/.smartloop`) becomes a git clone of a small
**private** remote; park pushes, resume pulls. Nothing else changes — the state
file was machine-neutral from v1.

## Setup (once per machine)

1. Create a private, empty repo to hold loop state (it contains real paths and
   command output — never make it public, never reuse the samebrain repo).
2. On each machine:

```bash
export SMARTLOOP_SYNC_REMOTE=git@github.com:YOU/smartloop-state.git   # in your shell profile
git clone "$SMARTLOOP_SYNC_REMOTE" ~/.smartloop
```

With `SMARTLOOP_SYNC_REMOTE` set, the skill commits and pushes the state dir at
every park/checkpoint and pulls before every resume (see "Cross-machine
resume" in `skills/smartloop/SKILL.md`). Offline parks fail silent and
reconcile on the next pull.

## Manual two-clone test

Verifies the round trip without touching real state (the same sequence the
skill runs):

```bash
tmp=$(mktemp -d)
git init --bare "$tmp/remote.git"
git clone "$tmp/remote.git" "$tmp/machine-a" && git clone "$tmp/remote.git" "$tmp/machine-b"

# machine A: park a run
mkdir -p "$tmp/machine-a/demo-task"
printf -- '---\nslug: demo-task\nstatus: waiting:user\nowner_session: sA\nowner_machine: machine-a\nnext_wake: parked\n---\n## Contract\nGoal: demo\n' \
  > "$tmp/machine-a/demo-task/state.md"
git -C "$tmp/machine-a" add -A && git -C "$tmp/machine-a" commit -m "smartloop: demo-task parked" && git -C "$tmp/machine-a" push

# machine B: resume
git -C "$tmp/machine-b" pull --rebase --autostash
grep "status: waiting:user" "$tmp/machine-b/demo-task/state.md" && echo "RESUME OK"
```

The takeover rule applies on machine B: claim `owner_session` and
`owner_machine` on entry, but never take over a run whose `next_wake` is a live
future timestamp on another machine.

This sequence runs automatically in `test/run.mjs` so CI exercises the
mechanics on all three OSes.

---
name: security-review
description: Review code and configuration changes for security and operational risk before they ship. Use when a change touches auth, secrets, external calls, data access, deployment, or when the user asks for a security review.
---

# Security review

Review the change, not the whole codebase. Focus on the boundaries where trust
or data changes hands, and stop the change if a finding breaks the contract.

## What to check

- **Boundaries.** Validate untrusted input at the system edge — request bodies,
  CLI args, env vars, file paths, webhook payloads. Reject rather than coerce
  when a value is out of range. Path handlers must not let `..` escape their
  root.
- **Secrets.** No hardcoded keys, tokens, or passwords. Read them from the
  environment or a secret manager (`op`). Confirm nothing credential-looking
  (`*.env`, `*.pem`, `*.key`, `credentials`) is staged or logged, including in
  error paths and debug output.
- **Data access.** Every query is scoped to the caller's tenant/account. No
  cross-tenant reads, no widening a filter to "fix" an empty result. Writes are
  authorized, not just authenticated.
- **External effects.** Network calls, deploys, migrations, and messages are
  explicit and bounded. No retry loop that can double-charge or double-send.
- **Errors.** Fail closed. Never swallow an error that leaves a security
  decision unmade, and never leak stack traces or upstream bodies to a client.
- **Dependencies.** Prefer service-maintained packages. A new dependency is
  justified in the PR, not assumed.

## Escalate, do not proceed

Stop and ask the user before anything that is irreversible or outside the
working tree:

- production deploys or production data mutation
- anything that spends money
- external communications on the user's behalf
- handling secrets or rotating credentials
- destructive git-history operations
- cross-tenant, billing, or security-boundary changes

## Report

State each finding with file:line, the concrete attack or failure it enables,
and the smallest fix. Separate blocking findings (break the requested contract)
from nits. If nothing is wrong, say so plainly — do not invent risk.

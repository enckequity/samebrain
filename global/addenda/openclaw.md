# OpenClaw conventions

## Shared configuration

- Treat this managed block and the shared skills directory as read-only rendered outputs. Edit canonical rules and skills in `{{REPO}}`, then run `node {{REPO}}/bin/render.mjs`.
- Preserve OpenClaw's workspace-local `SOUL.md`, `USER.md`, memory files, channel settings, credentials, and agent-created workspace content.

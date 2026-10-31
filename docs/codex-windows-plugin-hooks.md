# Codex Windows plugin hooks

Windows session-start recall now reapplies Security Guidance, Ralph Loop and Superpowers
launchers on every start, even when the shared repository revision has not changed.
Render also reconciles the cache; `render.mjs --check` reports drift without writing.
For immediate repair after a plugin update, run:

```powershell
node ~/samebrain/bin/repair-codex-plugin-hooks.mjs
```

The repair adds `command_windows` to each existing command and saves an original backup beside
`hooks.json`. It preserves the portable command, event conditions, timeouts and security options.
The launcher passes literal plugin paths to Git Bash and translates Claude-only output telemetry
to Codex's schema. Blocking decisions, stderr and nonzero exit codes are preserved.

Review changed hook definitions in Codex `/hooks` and trust them through the normal UI if
required. The repair does not modify trust records. A session that already loaded broken
definitions can still report those failures; restart Codex after repair to load the fixed
definitions. Unsupported new upstream command syntax is reported rather than silently dropped.

Offline checks:

```powershell
node --test test/codex-plugin-windows.test.cjs test/repair-codex-plugin-hooks.test.mjs test/codex-hook-command.test.mjs test/stable-node.test.mjs
```

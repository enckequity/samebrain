// Windows compatibility for the existing Git Bash plugin hooks.
// Preserve checks/exit codes; translate Claude telemetry into Codex's wire format.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function normalize(stdout, event, plugin) {
  const text = stdout.trim();
  if (!text) return '';
  let result;
  try { result = JSON.parse(text); }
  catch (error) {
    // Ralph prints completion notices on successful exits; these are UI notices.
    if (plugin === 'ralph-loop' && event === 'Stop' && !text.startsWith('{')) {
      return JSON.stringify({ systemMessage: text });
    }
    if (!['Stop', 'SubagentStop'].includes(event) && !text.startsWith('{')) return stdout;
    throw new Error('Plugin returned invalid ' + event + ' JSON: ' + error.message);
  }
  if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error('Hook JSON must be an object');
  // These Claude-only telemetry fields are rejected by Codex's output schema.
  delete result.metrics;
  delete result.rewakeSummary;
  if (['Stop', 'SubagentStop'].includes(event)) {
    const allowed = new Set(['continue', 'stopReason', 'systemMessage', 'suppressOutput', 'decision', 'reason']);
    for (const key of Object.keys(result)) {
      if (!allowed.has(key)) throw new Error('Unsupported ' + event + ' output field: ' + key);
    }
    if (result.decision !== undefined && (result.decision !== 'block' || typeof result.reason !== 'string' || !result.reason.trim())) {
      throw new Error('Blocking hook must retain decision:block and a nonempty reason');
    }
  }
  return JSON.stringify(result);
}

function main() {
  const [rootArg, ...args] = process.argv.slice(2);
  if (!rootArg || !args.length) throw new Error('Plugin root and hook script are required');
  const root = path.resolve(rootArg);
  const plugin = path.basename(path.dirname(root));
  const input = fs.readFileSync(0, 'utf8');
  const payload = JSON.parse(input || '{}');
  const event = payload.hook_event_name || '';
  const bash = 'C:/Program Files/Git/usr/bin/bash.exe';
  if (!fs.existsSync(bash)) throw new Error('Git Bash is unavailable: ' + bash);
  const resolved = args.map(arg => arg.startsWith('hooks/') ? path.join(root, arg).replaceAll('\\', '/') : arg);
  const child = spawnSync(bash, resolved, {
    input, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: root.replaceAll('\\', '/'), PYTHONUTF8: '1' },
  });
  if (child.error) throw child.error;
  if (child.stderr) process.stderr.write(child.stderr);
  if (child.status === null) throw new Error('Plugin hook terminated without an exit status');
  if (child.status !== 0) {
    if (child.stdout) process.stdout.write(child.stdout);
    process.exitCode = child.status;
    return;
  }
  process.stdout.write(normalize(child.stdout || '', event, plugin));
}

module.exports = { normalize };
if (require.main === module) {
  try { main(); }
  catch (error) { process.stderr.write('Codex plugin adapter: ' + error.message + '\n'); process.exitCode = 1; }
}

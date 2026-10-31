// Reapply Windows launchers after a plugin cache update; never alter hook trust.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexHookCommand } from './codex-hook-command.mjs';
import { stableNode } from './stable-node.mjs';

export function repairHooks(config, root, adapter, node = process.execPath) {
  let changed = 0;
  for (const entries of Object.values(config.hooks ?? {})) {
    for (const entry of entries) {
      for (const hook of entry.hooks ?? []) {
        if (hook.type !== 'command') continue;
        const args = [];
        const command = hook.command ?? '';
        const pattern = /"\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\n]+)"/g;
        for (const match of command.matchAll(pattern)) args.push(match[1]);
        if (!args.length) continue;
        const remainder = command.replace(pattern, '').replace(/^bash\s*/, '').trim();
        if (remainder && !/^[a-zA-Z0-9_-]+$/.test(remainder)) throw new Error(`Unsupported hook command: ${command}`);
        if (remainder) args.push(remainder);
        const quote = value => `'${value.replaceAll("'", "''")}'`;
        const override = codexHookCommand(node, adapter, [root, ...args].map(quote).join(' '), 'win32');
        if (hook.command_windows !== override) {
          hook.command_windows = override;
          changed++;
        }
      }
    }
  }
  return changed;
}

export function repairPluginCache({
  cache = join(homedir(), '.codex', 'plugins', 'cache', 'claude-plugins-official'),
  adapter = join(dirname(dirname(fileURLToPath(import.meta.url))), 'hooks', 'codex-plugin-windows.cjs'),
  node = stableNode(),
  check = false,
  report = () => {},
} = {}) {
  let total = 0;
  for (const plugin of ['security-guidance', 'ralph-loop', 'superpowers']) {
    const dir = join(cache, plugin);
    if (!existsSync(dir)) continue;
    for (const version of readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory())) {
      const root = join(dir, version.name);
      const file = join(root, 'hooks', 'hooks.json');
      if (!existsSync(file)) continue;
      const original = readFileSync(file, 'utf8');
      const config = JSON.parse(original);
      const changed = repairHooks(config, root, adapter, node);
      if (!changed) continue;
      const backup = `${file}.before-samebrain-windows-repair`;
      if (!check) {
        if (!existsSync(backup)) writeFileSync(backup, original);
        writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
      }
      report(`${plugin} ${version.name}: ${check ? 'needs repair for' : 'repaired'} ${changed} Windows commands`);
      total += changed;
    }
  }
  return total;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.platform !== 'win32') throw new Error('This repair is Windows-only');
  const total = repairPluginCache({ report: console.log });
  console.log(`Repaired ${total} commands. Review changed hooks in /hooks; trust was not modified.`);
}

// Keep hook commands identical across render, repair and session-start invokers.
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function stableNode({ home = homedir(), platform = process.platform, env = process.env } = {}) {
  const executable = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
  const nodeName = platform === 'win32' ? 'node.exe' : 'node';
  for (const candidate of [env.SAMEBRAIN_NODE, join(home, '.local', 'bin', nodeName)]) {
    if (candidate && executable(candidate)) return candidate;
  }
  if (platform === 'win32') {
    try {
      const found = execFileSync('where.exe', ['node'], { env, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
        .toString().split(/\r?\n/).map((line) => line.trim()).find((line) => /\.exe$/i.test(line) && executable(line));
      if (found) return found;
    } catch { /* node not on PATH */ }
  } else {
    try {
      const found = execFileSync(env.SHELL || '/bin/sh', ['-lc', 'command -v node'], {
        env, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'],
      }).toString().trim().split('\n').pop();
      if (found?.startsWith('/') && executable(found)) return found;
    } catch { /* no login shell or node not on its PATH */ }
  }
  return process.execPath;
}

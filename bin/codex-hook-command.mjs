// Codex uses the turn's shell for hooks: Windows may select PowerShell or CMD.
const quotePowerShell = (value) => `'${value.replaceAll("'", "''")}'`;

export function codexHookCommand(node, script, flags = '', platform = process.platform) {
  if (platform !== 'win32') return `"${node}" "${script}"${flags ? ` ${flags}` : ''}`;
  const invocation = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; & ${quotePowerShell(node)} ${quotePowerShell(script)}${flags ? ` ${flags}` : ''}; exit (Get-Variable LASTEXITCODE -ValueOnly)`;
  // Encode paths so the outer PowerShell cannot expand dollar signs/backticks in them.
  const encoded = Buffer.from(invocation, 'utf16le').toString('base64');
  // CMD passes the suffix to the inner shell (which already exits). PowerShell runs
  // it itself, preserving native exit 2 instead of mapping every failure to exit 1.
  return `powershell.exe -NoProfile -NonInteractive -Command "& ([ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))))" ; exit (Get-Variable LASTEXITCODE -ValueOnly)`;
}

export function hookCommandSource(command = '') {
  const encoded = command.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1];
  return encoded ? Buffer.from(encoded, 'base64').toString('utf16le') : command;
}

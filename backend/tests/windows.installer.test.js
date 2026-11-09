// 1.1.13: the Windows installers must run on stock Windows PowerShell 5.1.
// 5.1 reads a BOM-less .ps1 as ANSI, so UTF-8 punctuation such as an em dash
// (bytes E2 80 94) turns into a stray quote and breaks parsing; it also has
// no `||`/`&&` pipeline-chain operators (PowerShell 7 only).
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', '..', 'worker-app');
const files = ['install-windows.ps1', 'uninstall-windows.ps1'];

describe.each(files)('%s runs on Windows PowerShell 5.1', (file) => {
  const buf = fs.readFileSync(path.join(dir, file));
  const code = buf.toString('utf8')
    .split('\n')
    .map((l) => l.replace(/^\s*#.*$/, ''))
    .join('\n');

  test('is pure ASCII', () => {
    const bad = [...buf].findIndex((b) => b > 0x7f);
    expect(bad).toBe(-1);
  });

  test('uses no PowerShell 7-only operators', () => {
    expect(code).not.toMatch(/\|\||&&|\?\?/);
  });

  test('never redirects native stderr outside Invoke-Native', () => {
    // `ollama ... 2>$null` under ErrorActionPreference=Stop throws on 5.1.
    for (const line of code.split('\n')) {
      if (/\bollama\b.*2>\$null/.test(line) && !/Invoke-Native|ErrorActionPreference|Get-InstalledModels|\$list = ollama/.test(line)) {
        throw new Error(`unguarded native stderr redirect: ${line.trim()}`);
      }
    }
  });
});

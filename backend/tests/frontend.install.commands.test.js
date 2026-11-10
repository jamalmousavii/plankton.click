// 1.2.2: the workers page has no intro popup, and a created worker shows
// install commands for every OS with its token already inside.
const fs = require('fs');
const path = require('path');

const FE = path.join(__dirname, '../../frontend');
const compSrc = fs.readFileSync(path.join(FE, 'components/InstallCommands.js'), 'utf8');
const pageSrc = fs.readFileSync(path.join(FE, 'pages/workers.js'), 'utf8');

// Evaluate the pure command builder without a JSX toolchain.
const body = compSrc.slice(compSrc.indexOf('const RAW'), compSrc.indexOf('const OS_LIST'))
  .replace('export function installCommands', 'function installCommands');
// eslint-disable-next-line no-new-func
const installCommands = new Function(`${body}; return installCommands;`)();

const TOKEN = 'pw_' + '0123456789abcdef'.repeat(4);

describe('install commands with the token inside', () => {
  test('every OS gets a command carrying the token', () => {
    const c = installCommands(TOKEN);
    expect(Object.keys(c).sort()).toEqual(['macos', 'redhat', 'ubuntu', 'windows']);
    expect(c.ubuntu).toMatch(/install-ubuntu\.sh --token pw_[0-9a-f]{64}$/);
    expect(c.redhat).toMatch(/install-redhat\.sh --token pw_[0-9a-f]{64}$/);
    expect(c.macos).toMatch(/^curl -fsSL -o install-macos\.sh .*install-macos\.sh --token pw_/);
    expect(c.windows).toMatch(/-File \.\\install-windows\.ps1 -Token pw_[0-9a-f]{64}$/);
  });

  test('the Windows one-liner is PowerShell 5.1 safe', () => {
    const w = installCommands(TOKEN).windows;
    expect(w).not.toMatch(/&&|\|\|/); // not valid in Windows PowerShell 5.1
    expect(w).toContain('-UseBasicParsing');
    expect(/^[\x20-\x7e]+$/.test(w)).toBe(true);
  });

  test('anything that is not a token never reaches the shell command', () => {
    for (const bad of ['', null, 'pw_xyz; rm -rf ~', '$(id)', 'pw_' + 'a'.repeat(64) + ' && x']) {
      const c = installCommands(bad);
      for (const cmd of Object.values(c)) {
        expect(cmd).toMatch(/YOUR_TOKEN$/);
      }
    }
  });

  test('the installers accept the flags the commands use', () => {
    const wa = path.join(__dirname, '../../worker-app');
    for (const f of ['install-ubuntu.sh', 'install-redhat.sh', 'install-macos.sh']) {
      expect(fs.readFileSync(path.join(wa, f), 'utf8')).toMatch(/--token\) WORKER_TOKEN="\$2"/);
    }
    expect(fs.readFileSync(path.join(wa, 'install-windows.ps1'), 'utf8')).toMatch(/\[string\]\$Token = ""/);
  });
});

describe('workers page', () => {
  test('no intro popup on load', () => {
    expect(pageSrc).not.toMatch(/plankton-guide-seen/);
    expect(pageSrc).not.toMatch(/showGuideModal/);
    expect(pageSrc).not.toMatch(/aria-modal/);
  });

  test('new, regenerated and unused tokens all render the install commands', () => {
    expect(pageSrc).toMatch(/<InstallCommands token=\{newWorkerToken\} \/>/);
    expect(pageSrc).toMatch(/<InstallCommands token=\{m\.worker_token \|\| regenTokenVal\} \/>/);
    expect(pageSrc).toMatch(/const openAddWorker = \(\) => setShowAddForm\(true\);/);
  });
});

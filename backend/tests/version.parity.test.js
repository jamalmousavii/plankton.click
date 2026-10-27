// One canonical version marker for the whole repo. The bump script
// (scripts/bump-version.js) must leave every surface above/below in sync; this
// test fails the build when a release bumps one place but misses another.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const version = JSON.parse(read('backend/package.json')).version;
const WORKER_SH = [
  'install-ubuntu.sh', 'install-redhat.sh', 'install-macos.sh',
  'uninstall-ubuntu.sh', 'uninstall-redhat.sh', 'uninstall-macos.sh',
];
const WORKER_PS1 = ['install-windows.ps1', 'uninstall-windows.ps1'];

describe('version parity', () => {
  it('all three manifests agree', () => {
    expect(JSON.parse(read('frontend/package.json')).version).toBe(version);
    expect(JSON.parse(read('worker-app/package.json')).version).toBe(version);
  });

  it('lockfiles carry the same version', () => {
    expect(read('backend/package-lock.json')).toContain(`"version": "${version}"`);
    expect(read('frontend/package-lock.json')).toContain(`"version": "${version}"`);
    expect(read('worker-app/package-lock.json')).toContain(`"version": "${version}"`);
  });

  it('CHANGELOG has a section for the current version', () => {
    expect(read('CHANGELOG.md')).toContain(`## [${version}]`);
  });

  it('docs/api.md announces the current version', () => {
    expect(read('docs/api.md')).toContain(`نسخه بک‌اند: \`${version}\``);
  });

  it('worker installers pin PLANKTON_VERSION', () => {
    for (const f of WORKER_SH) {
      expect(read(path.join('worker-app', f))).toContain(`PLANKTON_VERSION="${version}"`);
    }
    for (const f of WORKER_PS1) {
      expect(read(path.join('worker-app', f))).toContain(`$PLANKTON_VERSION = "${version}"`);
    }
  });

  it('every locale footer shows the current version', () => {
    const dir = path.join(root, 'frontend/i18n/translations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
    expect(files.length).toBeGreaterThanOrEqual(33);
    for (const f of files) {
      expect(read(path.join('frontend/i18n/translations', f))).toContain(`v${version}`);
    }
  });
});

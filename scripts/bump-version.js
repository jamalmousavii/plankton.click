#!/usr/bin/env node
// Single-command release version bump.
//
// Usage:  node scripts/bump-version.js 1.0.1
//
// Updates every canonical version marker: the three package.json manifests,
// both lockfiles, the worker installer/uninstaller scripts (sh + ps1), all
// locale footers, and the docs/api.md header. Historical version mentions in
// comments/sections are intentionally NOT touched. The parity test
// (backend/tests/version.parity.test.js) guards this list — if you add a new
// surface, add it in BOTH places.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const p = (rel) => path.join(root, rel);
const next = process.argv[2];

if (!/^\d+\.\d+\.\d+$/.test(next || '')) {
  console.error('usage: node scripts/bump-version.js X.Y.Z');
  process.exit(1);
}

const current = JSON.parse(fs.readFileSync(p('backend/package.json'), 'utf8')).version;
if (current === next) {
  console.log(`already at ${next} — nothing to do`);
  process.exit(0);
}

const changed = [];

function replaceIn(rel, from, to) {
  const file = p(rel);
  const src = fs.readFileSync(file, 'utf8');
  if (!src.includes(from)) {
    console.warn(`⚠️  ${rel}: pattern "${from}" not found — skipped`);
    return;
  }
  fs.writeFileSync(file, src.split(from).join(to));
  changed.push(rel);
}

// Manifests (JSON-safe rewrite, preserving key order + trailing newline).
for (const rel of ['backend/package.json', 'frontend/package.json', 'worker-app/package.json']) {
  const file = p(rel);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.version = next;
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  changed.push(rel);
}

// Lockfiles: the root package version appears twice per lock ("version" at the
// top and inside packages[""]); dependency versions are never x.y.z of ours.
for (const rel of ['backend/package-lock.json', 'frontend/package-lock.json', 'worker-app/package-lock.json']) {
  replaceIn(rel, `"version": "${current}"`, `"version": "${next}"`);
}

// Worker installers/uninstallers — one PLANKTON_VERSION constant each.
for (const sh of ['install-ubuntu.sh', 'install-redhat.sh', 'install-macos.sh',
  'uninstall-ubuntu.sh', 'uninstall-redhat.sh', 'uninstall-macos.sh']) {
  replaceIn(path.join('worker-app', sh), `PLANKTON_VERSION="${current}"`, `PLANKTON_VERSION="${next}"`);
}
for (const ps1 of ['install-windows.ps1', 'uninstall-windows.ps1']) {
  replaceIn(path.join('worker-app', ps1), `$PLANKTON_VERSION = "${current}"`, `$PLANKTON_VERSION = "${next}"`);
}

// Locale footers (all 33).
const i18nDir = p('frontend/i18n/translations');
for (const f of fs.readdirSync(i18nDir)) {
  if (f.endsWith('.js')) replaceIn(path.join('frontend/i18n/translations', f), `v${current}`, `v${next}`);
}

// Docs header.
replaceIn('docs/api.md', `نسخه بک‌اند: \`${current}\``, `نسخه بک‌اند: \`${next}\``);

console.log(`✅ ${current} → ${next} (${changed.length} files)`);

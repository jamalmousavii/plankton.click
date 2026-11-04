// 1.1.12: fonts are self-hosted. A render-blocking Google Fonts stylesheet
// left the site blank for visitors who cannot reach fonts.googleapis.com.
const fs = require('fs');
const path = require('path');

const fe = (rel) => path.join(__dirname, '..', '..', 'frontend', rel);

describe('self-hosted fonts', () => {
  test('_document loads no external font stylesheet', () => {
    const doc = fs.readFileSync(fe('pages/_document.js'), 'utf8');
    expect(doc).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
  });

  test('every @font-face file exists in public/fonts', () => {
    const css = fs.readFileSync(fe('styles/globals.css'), 'utf8');
    const urls = [...css.matchAll(/url\('(\/fonts\/[^']+)'\)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThanOrEqual(4);
    for (const u of urls) {
      expect(fs.existsSync(fe(path.join('public', u)))).toBe(true);
    }
    expect(css).toMatch(/font-display: swap/);
  });
});

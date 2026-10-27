import {
  LANGUAGES,
  translations,
  hasLocale,
  isRtl,
  loadLocale,
  detectLanguage,
} from '../i18n/translations';

const leafCount = (obj) =>
  Object.values(obj).reduce(
    (n, v) => n + (v && typeof v === 'object' && !Array.isArray(v) ? leafCount(v) : 1),
    0,
  );

describe('translation registry', () => {
  it('ships `en` synchronously with a full dictionary', () => {
    expect(translations.en).toBeDefined();
    expect(leafCount(translations.en)).toBeGreaterThan(300);
    expect(LANGUAGES.length).toBe(33);
  });

  it('hasLocale accepts known codes and rejects unknown ones', () => {
    expect(hasLocale('en')).toBe(true);
    expect(hasLocale('fa')).toBe(true);
    expect(hasLocale('zh-TW')).toBe(true);
    expect(hasLocale('xx')).toBe(false);
    expect(hasLocale('')).toBe(false);
  });

  it('marks exactly the RTL languages as RTL', () => {
    expect(isRtl('fa')).toBe(true);
    expect(isRtl('ar')).toBe(true);
    expect(isRtl('he')).toBe(true);
    expect(isRtl('ur')).toBe(true);
    expect(isRtl('en')).toBe(false);
    expect(isRtl('fr')).toBe(false);
    expect(isRtl('xx')).toBe(false);
  });

  it('loadLocale resolves every listed locale except the sync `en`', async () => {
    const enKeys = leafCount(translations.en);
    for (const { code } of LANGUAGES) {
      if (code === 'en') continue;
      const dict = await loadLocale(code);
      expect(dict).toBeDefined();
      // parity with `en` (the static i18n:check gate enforces it too)
      expect(leafCount(dict)).toBe(enKeys);
      // idempotent second call returns the cached dict
      expect(await loadLocale(code)).toBe(dict);
    }
    expect(Object.keys(translations).length).toBeGreaterThanOrEqual(LANGUAGES.length);
  });

  it('loadLocale returns undefined for unknown codes', async () => {
    expect(await loadLocale('xx')).toBeUndefined();
  });

  it('loadLocale resolves `en` synchronously', async () => {
    expect(await loadLocale('en')).toBe(translations.en);
  });
});

describe('detectLanguage', () => {
  beforeEach(() => {
    sessionStorage.clear();
    Object.defineProperty(window.navigator, 'languages', {
      value: ['en-US'],
      configurable: true,
    });
  });

  it('prefers a saved valid locale', () => {
    sessionStorage.setItem('plankton-lang', 'de');
    expect(detectLanguage()).toBe('de');
  });

  it('ignores a saved invalid locale', () => {
    sessionStorage.setItem('plankton-lang', 'xx');
    expect(detectLanguage()).toBe('en');
  });

  it('falls back to navigator languages (base code match)', () => {
    Object.defineProperty(window.navigator, 'languages', {
      value: ['fr-FR', 'en-US'],
      configurable: true,
    });
    expect(detectLanguage()).toBe('fr');
  });

  it('maps zh-TW variants to zh-TW', () => {
    Object.defineProperty(window.navigator, 'languages', {
      value: ['zh-Hant-TW'],
      configurable: true,
    });
    expect(detectLanguage()).toBe('zh-TW');
  });

  it('maps Norwegian variants to no', () => {
    Object.defineProperty(window.navigator, 'languages', {
      value: ['nb-NO'],
      configurable: true,
    });
    expect(detectLanguage()).toBe('no');
  });

  it('falls back to en for unknown navigator languages', () => {
    Object.defineProperty(window.navigator, 'languages', {
      value: ['xx-YY'],
      configurable: true,
    });
    expect(detectLanguage()).toBe('en');
  });

  it('survives a throwing sessionStorage', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('storage disabled');
      },
    });
    try {
      expect(detectLanguage()).toBe('en');
    } finally {
      Object.defineProperty(window, 'sessionStorage', original);
    }
  });
});

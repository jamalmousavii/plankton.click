// Locale dictionaries are code-split: only `en` (the universal fallback)
// ships in the app bundle; the other 32 locales load on demand via webpack
// dynamic import (~70KB gzip off _app). `translations` is the sync registry
// that t() walks — it starts with `en` and is filled by loadLocale().
import en from './translations/en';

export const translations = { en };

export const LANGUAGES = [
  { code: 'en', name: 'English', flag: '🇬🇧', rtl: false },
  { code: 'fa', name: 'فارسی', flag: '🇮🇷', rtl: true },
  { code: 'ar', name: 'العربية', flag: '🇸🇦', rtl: true },
  { code: 'he', name: 'עברית', flag: '🇮🇱', rtl: true },
  { code: 'ur', name: 'اردو', flag: '🇵🇰', rtl: true },
  { code: 'fr', name: 'Français', flag: '🇫🇷', rtl: false },
  { code: 'de', name: 'Deutsch', flag: '🇩🇪', rtl: false },
  { code: 'es', name: 'Español', flag: '🇪🇸', rtl: false },
  { code: 'pt', name: 'Português', flag: '🇵🇹', rtl: false },
  { code: 'it', name: 'Italiano', flag: '🇮🇹', rtl: false },
  { code: 'nl', name: 'Nederlands', flag: '🇳🇱', rtl: false },
  { code: 'ru', name: 'Русский', flag: '🇷🇺', rtl: false },
  { code: 'uk', name: 'Українська', flag: '🇺🇦', rtl: false },
  { code: 'pl', name: 'Polski', flag: '🇵🇱', rtl: false },
  { code: 'tr', name: 'Türkçe', flag: '🇹🇷', rtl: false },
  { code: 'zh', name: '中文', flag: '🇨🇳', rtl: false },
  { code: 'zh-TW', name: '繁體中文', flag: '🇹🇼', rtl: false },
  { code: 'ja', name: '日本語', flag: '🇯🇵', rtl: false },
  { code: 'ko', name: '한국어', flag: '🇰🇷', rtl: false },
  { code: 'hi', name: 'हिन्दी', flag: '🇮🇳', rtl: false },
  { code: 'bn', name: 'বাংলা', flag: '🇧🇩', rtl: false },
  { code: 'id', name: 'Bahasa Indonesia', flag: '🇮🇩', rtl: false },
  { code: 'vi', name: 'Tiếng Việt', flag: '🇻🇳', rtl: false },
  { code: 'th', name: 'ไทย', flag: '🇹🇭', rtl: false },
  { code: 'ms', name: 'Bahasa Melayu', flag: '🇲🇾', rtl: false },
  { code: 'sv', name: 'Svenska', flag: '🇸🇪', rtl: false },
  { code: 'da', name: 'Dansk', flag: '🇩🇰', rtl: false },
  { code: 'fi', name: 'Suomi', flag: '🇫🇮', rtl: false },
  { code: 'no', name: 'Norsk', flag: '🇳🇴', rtl: false },
  { code: 'cs', name: 'Čeština', flag: '🇨🇿', rtl: false },
  { code: 'ro', name: 'Română', flag: '🇷🇴', rtl: false },
  { code: 'el', name: 'Ελληνικά', flag: '🇬🇷', rtl: false },
  { code: 'hu', name: 'Magyar', flag: '🇭🇺', rtl: false },
];

export const RTL_LANGS = new Set(LANGUAGES.filter(l => l.rtl).map(l => l.code));

const CODES = new Set(LANGUAGES.map((l) => l.code));

// Codes are known synchronously (for detection/validation) even while the
// dictionary chunk is still in flight.
export function hasLocale(code) {
  return CODES.has(code);
}

// One dynamic-import loader per locale (literal paths so webpack can split).
const loaders = {
  fa: () => import('./translations/fa'),
  ar: () => import('./translations/ar'),
  he: () => import('./translations/he'),
  ur: () => import('./translations/ur'),
  fr: () => import('./translations/fr'),
  de: () => import('./translations/de'),
  es: () => import('./translations/es'),
  pt: () => import('./translations/pt'),
  it: () => import('./translations/it'),
  nl: () => import('./translations/nl'),
  ru: () => import('./translations/ru'),
  uk: () => import('./translations/uk'),
  pl: () => import('./translations/pl'),
  tr: () => import('./translations/tr'),
  zh: () => import('./translations/zh'),
  'zh-TW': () => import('./translations/zh-TW'),
  ja: () => import('./translations/ja'),
  ko: () => import('./translations/ko'),
  hi: () => import('./translations/hi'),
  bn: () => import('./translations/bn'),
  id: () => import('./translations/id'),
  vi: () => import('./translations/vi'),
  th: () => import('./translations/th'),
  ms: () => import('./translations/ms'),
  sv: () => import('./translations/sv'),
  da: () => import('./translations/da'),
  fi: () => import('./translations/fi'),
  no: () => import('./translations/no'),
  cs: () => import('./translations/cs'),
  ro: () => import('./translations/ro'),
  el: () => import('./translations/el'),
  hu: () => import('./translations/hu'),
};

// Idempotent: resolves with the dict (already-loaded locales return
// synchronously-wrapped promises), undefined for unknown codes.
export async function loadLocale(code) {
  if (translations[code]) return translations[code];
  const load = loaders[code];
  if (!load) return undefined;
  try {
    const mod = await load();
    const dict = mod && mod.default ? mod.default : mod;
    if (dict) translations[code] = dict;
    return dict;
  } catch (err) {
    console.warn('Failed to load locale', code, err);
    return undefined;
  }
}

export function isRtl(code) {
  return RTL_LANGS.has(code);
}

export function detectLanguage() {
  if (typeof window === 'undefined') return 'en';
  try {
    const saved = sessionStorage.getItem('plankton-lang');
    if (saved && CODES.has(saved)) return saved;
  } catch (e) {}
  const prefs = navigator.languages || [navigator.language || 'en'];
  for (const p of prefs) {
    const code = String(p).toLowerCase();
    if (code.startsWith('zh-tw') || code.startsWith('zh-hk') || code.startsWith('zh-hant')) {
      if (CODES.has('zh-TW')) return 'zh-TW';
    }
    if (CODES.has(code)) return code;
    const base = code.split('-')[0];
    if (base === 'nb' || base === 'nn' || base === 'no') return 'no';
    if (CODES.has(base)) return base;
  }
  return 'en';
}

export default translations;

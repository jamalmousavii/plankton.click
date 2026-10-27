import { createContext, useContext, useState, useEffect } from 'react';
import translations, { detectLanguage, isRtl, hasLocale, loadLocale } from './translations';

const LanguageContext = createContext();

export function LanguageProvider({ children }) {
  const [lang, setLang] = useState('en');
  // Bumped after an async locale chunk lands so t() re-walks the registry.
  const [, setLoadedTick] = useState(0);

  useEffect(() => {
    const detected = detectLanguage();
    document.documentElement.dir = isRtl(detected) ? 'rtl' : 'ltr';
    document.documentElement.lang = detected;
    if (detected === 'en') {
      setLang('en');
      return undefined;
    }
    // Render with the en fallback for the few ms the locale chunk needs;
    // t() already walks translations[lang] → translations.en.
    setLang(detected);
    let alive = true;
    loadLocale(detected)
      .then((dict) => { if (alive && dict) setLoadedTick((n) => n + 1); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const changeLang = (newLang) => {
    if (!hasLocale(newLang)) return;
    const commit = () => {
      setLang(newLang);
      if (typeof window !== 'undefined') {
        try { sessionStorage.setItem('plankton-lang', newLang); } catch (e) {}
        document.documentElement.dir = isRtl(newLang) ? 'rtl' : 'ltr';
        document.documentElement.lang = newLang;
      }
    };
    // Unknown codes are rejected above; locales already in the registry
    // (incl. en) commit synchronously — first use of a locale waits for its
    // chunk so the switch never flashes English mid-selection.
    if (translations[newLang]) {
      commit();
      return;
    }
    loadLocale(newLang).then((dict) => { if (dict) commit(); }).catch(() => {});
  };

  const t = (key) => {
    const keys = key.split('.');
    let value = translations[lang];
    for (const k of keys) {
      value = value?.[k];
    }
    if (value === undefined && lang !== 'en') {
      value = translations.en;
      for (const k of keys) {
        value = value?.[k];
      }
    }
    return value !== undefined ? value : key;
  };

  return (
    <LanguageContext.Provider value={{ lang, changeLang, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useLanguage must be used within LanguageProvider');
  }
  return context;
}

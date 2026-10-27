import Link from 'next/link';
import { useRouter } from 'next/router';
import { useLanguage } from '../i18n/LanguageContext';
import { LogoMark } from './Logo';

export default function Footer() {
  const { t } = useLanguage();
  const router = useRouter();
  const version = t('home.version');
  const sentence = t('footer.sentence').replace('{version}', version);

  // The chat home is a fixed one-viewport frame: keep its footer to a
  // single quiet line so it never steals height from the conversation.
  if (router.pathname === '/') {
    return (
      <footer className="mt-auto">
        <div className="container mx-auto px-4 md:px-6 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-center text-gray-400 text-[11px] leading-relaxed">
          <p>{sentence}</p>
        </div>
      </footer>
    );
  }

  return (
    <footer className="mt-auto border-t border-white/60 bg-white/50 backdrop-blur-xl">
      <div className="container mx-auto px-4 md:px-6 pt-6 pb-[max(1.25rem,env(safe-area-inset-bottom))] flex flex-col md:flex-row items-center justify-between gap-4 text-sm">
        <div className="flex items-center gap-2.5 text-gray-500">
          <LogoMark size={22} />
          <span className="font-display font-semibold text-gray-700">plankton.click</span>
        </div>
        <nav className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-gray-500">
          <Link href="/worker" className="hover:text-sky-700 transition">{t('nav.worker')}</Link>
          <Link href="/leaderboard" className="hover:text-sky-700 transition">{t('leaderboard.title')}</Link>
          <a href="https://github.com/jamalmousavii/plankton.click" target="_blank" rel="noopener noreferrer" className="hover:text-sky-700 transition">GitHub</a>
        </nav>
        <p className="text-gray-400 text-xs text-center md:text-right">{sentence}</p>
      </div>
    </footer>
  );
}

import Head from 'next/head';
import Link from 'next/link';
import Navbar from '../components/Navbar';
import { useLanguage } from '../i18n/LanguageContext';

export default function NotFound() {
  const { t } = useLanguage();
  return (
    <div className="flex-1 page-surface">
      <Head>
        <title>404 - Plankton Network</title>
        <meta name="robots" content="noindex" />
      </Head>
      <Navbar />
      <main className="container mx-auto px-4 py-16 text-center">
        <p className="text-7xl font-black text-sky-500">404</p>
        <h1 className="text-2xl font-bold text-gray-800 mt-4">{t('errors.pageNotFoundTitle')}</h1>
        <p className="text-gray-500 mt-2">{t('errors.pageNotFoundDesc')}</p>
        <Link
          href="/"
          className="inline-block mt-6 px-6 py-3 rounded-xl bg-sky-500 text-white font-bold hover:bg-sky-600 transition"
        >
          {t('errors.backHome')}
        </Link>
      </main>
    </div>
  );
}

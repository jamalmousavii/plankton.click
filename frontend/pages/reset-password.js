import Head from 'next/head';
import Link from 'next/link';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { useLanguage } from '../i18n/LanguageContext';
import Navbar from '../components/Navbar';

export default function ResetPassword() {
  const { t, lang } = useLanguage();
  const router = useRouter();
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [checkedToken, setCheckedToken] = useState(false);

  useEffect(() => {
    if (!router.isReady) return;
    setToken(router.query.token || '');
    setCheckedToken(true);
  }, [router.isReady, router.query.token]);

  const validate = () => {
    if (!token) return t('nav.resetInvalidLink');
    if (password.length < 8 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
      return t('nav.passwordHint');
    }
    if (password !== confirm) return t('nav.passwordsNoMatch');
    return '';
  };

  const handleSubmit = async () => {
    const problem = validate();
    if (problem) { setError(problem); return; }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (data.success) {
        setDone(true);
      } else {
        setError(data.error || t('nav.resetInvalidLink'));
      }
    } catch (err) {
      setError(t('chat.errorConnection'));
    }
    setLoading(false);
  };

  const inputClass =
    'w-full bg-white text-gray-800 placeholder-gray-400 border border-sky-200 px-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-400';

  return (
    <div className={`min-h-screen page-surface`}>
      <Head>
        <title>{t('nav.resetPassword')} - Plankton Network</title>
      </Head>

      <Navbar />

      <main className="container mx-auto px-4 py-10 max-w-md">
        <div className="bg-white rounded-xl border border-sky-100 shadow-sm p-6 space-y-3">
          <h1 className="text-lg font-bold text-gray-800 text-center">🔑 {t('nav.resetPassword')}</h1>

          {done ? (
            <div className="space-y-4 text-center">
              <p className="text-emerald-600 text-sm">{t('nav.resetSuccess')}</p>
              <Link href="/"
                className="inline-block bg-sky-500 hover:bg-sky-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition"
              >
                {t('nav.login')}
              </Link>
            </div>
          ) : checkedToken && !token ? (
            <div className="space-y-4 text-center">
              <p className="text-red-500 text-sm">{t('nav.resetInvalidLink')}</p>
              <Link href="/" className="inline-block text-sky-600 hover:text-sky-700 text-sm">
                ← {t('nav.backToLogin')}
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('nav.newPassword')}
                className={inputClass}
              />
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder={t('nav.confirmPassword')}
                className={inputClass}
                onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
              />
              <p className="text-gray-500 text-xs">{t('nav.passwordHint')}</p>
              {error && <p className="text-red-500 text-xs">{error}</p>}
              <button
                onClick={handleSubmit}
                disabled={loading}
                className="w-full bg-emerald-500 hover:bg-emerald-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition disabled:opacity-50"
              >
                {loading ? '...' : `🔑 ${t('nav.resetPassword')}`}
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

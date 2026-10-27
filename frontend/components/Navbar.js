import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import Portal from './Portal';
import { useLanguage } from '../i18n/LanguageContext';
import LanguageSwitcher from './LanguageSwitcher';
import GoogleLogin from './GoogleLogin';
import Logo from './Logo';
import { clearSession, setSession, AUTH_EXPIRED_EVENT } from '../utils/api';

export default function Navbar() {
  const { t } = useLanguage();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [user, setUser] = useState(null);
  const dropdownRef = useRef(null);

  const [authMode, setAuthMode] = useState('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [forgotSent, setForgotSent] = useState(false);

  // F4: follow the session store — apiFetch's 401 handler and page logouts
  // dispatch these events; without listeners the avatar stayed stale.
  useEffect(() => {
    const syncUser = () => {
      try {
        const saved = localStorage.getItem('user');
        setUser(saved ? JSON.parse(saved) : null);
      } catch (e) { setUser(null); }
    };
    syncUser();
    window.addEventListener('plankton:auth-changed', syncUser);
    window.addEventListener(AUTH_EXPIRED_EVENT, syncUser);
    return () => {
      window.removeEventListener('plankton:auth-changed', syncUser);
      window.removeEventListener(AUTH_EXPIRED_EVENT, syncUser);
    };
  }, []);

  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // The mobile menu is a full-screen overlay; any route change dismisses it.
  useEffect(() => { setMenuOpen(false); }, [router.pathname]);

  const closeMenu = () => setMenuOpen(false);

  const handleLogout = () => {
    // F4: clearSession() removes the credentials AND fires plankton:auth-changed
    // (the old inline removeItem left other listeners to notice nothing);
    // reload wipes any in-memory chat/history state.
    clearSession();
    window.location.reload();
  };

  const handleLogin = async () => {
    if (!authEmail || !authPassword) return;
    setAuthLoading(true);
    setAuthError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: authEmail, password: authPassword })
      });
      const data = await res.json();
      if (data.success) {
        setSession(data.token, data.user);
        // Preserve ?next= (set by useAuth's redirect) instead of dumping the
        // user back on the home page they never asked for.
        const next = new URLSearchParams(window.location.search).get('next');
        if (next && next.startsWith('/') && !next.startsWith('//')) window.location.replace(next);
        else window.location.reload();
      } else {
        setAuthError(data.error || t('nav.loginFailed'));
      }
    } catch (err) {
      setAuthError(t('nav.networkError'));
    }
    setAuthLoading(false);
  };

  const handleSignup = async () => {
    if (!authEmail || !authPassword) return;
    setAuthLoading(true);
    setAuthError('');
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: authEmail, password: authPassword })
      });
      const data = await res.json();
      if (data.success) {
        setSession(data.token, data.user);
        // Preserve ?next= (set by useAuth's redirect) instead of dumping the
        // user back on the home page they never asked for.
        const next = new URLSearchParams(window.location.search).get('next');
        if (next && next.startsWith('/') && !next.startsWith('//')) window.location.replace(next);
        else window.location.reload();
      } else {
        setAuthError(data.error || t('nav.signupFailed'));
      }
    } catch (err) {
      setAuthError(t('nav.networkError'));
    }
    setAuthLoading(false);
  };

  const handleForgotPassword = async () => {
    if (!authEmail) return;
    setAuthLoading(true);
    setAuthError('');
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: authEmail })
      });
      const data = await res.json();
      if (data.success) {
        setAuthError('');
        setForgotSent(true);
        // reset_token is only ever present in development (no email provider wired).
        if (data.reset_token) {
          setResetToken(data.reset_token);
          setAuthMode('reset');
        }
      } else {
        setAuthError(data.error || t('nav.actionFailed'));
      }
    } catch (err) {
      setAuthError(t('nav.networkError'));
    }
    setAuthLoading(false);
  };

  const handleResetPassword = async () => {
    if (!resetToken || !authPassword) return;
    setAuthLoading(true);
    setAuthError('');
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, password: authPassword })
      });
      const data = await res.json();
      if (data.success) {
        setAuthMode('login');
        setAuthPassword('');
        setResetToken('');
        setAuthError('');
      } else {
        setAuthError(data.error || t('nav.actionFailed'));
      }
    } catch (err) {
      setAuthError(t('nav.networkError'));
    }
    setAuthLoading(false);
  };

  const resetAuthForm = () => {
    setAuthEmail('');
    setAuthPassword('');
    setAuthError('');
    setResetToken('');
    setForgotSent(false);
  };

  return (
    <nav className="sticky top-0 z-40 w-full border-b border-white/60 bg-white/60 backdrop-blur-xl supports-[backdrop-filter]:bg-white/50">
      <div className="container mx-auto px-4 md:px-6 py-2.5 flex items-center justify-between">
        <Link href="/" aria-label="Plankton home" className="rounded-xl"><Logo size={34} /></Link>

        {/* Desktop */}
        <div className="hidden md:flex items-center gap-4">
          <LanguageSwitcher />
          <Link href="/worker" className="px-3 py-1.5 rounded-full text-sm font-medium text-gray-600 hover:text-sky-800 hover:bg-sky-50 transition">{t('nav.worker')}</Link>
          <Link href="/#plans" onClick={() => window.dispatchEvent(new CustomEvent('plankton:show-plans'))} className="px-3 py-1.5 rounded-full text-sm font-medium text-gray-600 hover:text-sky-800 hover:bg-sky-50 transition">⭐ {t('nav.plans')}</Link>
          <Link href="/leaderboard" className="px-3 py-1.5 rounded-full text-sm font-medium text-gray-600 hover:text-sky-800 hover:bg-sky-50 transition">🏆</Link>
          {user?.role === 'admin' && (
            <Link href="/admin" className="px-3 py-1.5 rounded-full text-sm font-medium text-gray-600 hover:text-sky-800 hover:bg-sky-50 transition">🛡️ {t('nav.admin')}</Link>
          )}

          <div className="relative" ref={dropdownRef}>
            {user ? (
              <>
                <button
                  onClick={() => setDropdownOpen(!dropdownOpen)}
                  className="flex items-center gap-2 bg-white/80 hover:bg-white px-2.5 py-1.5 rounded-full transition border border-gray-200 shadow-sm"
                >
                  {user.avatar ? (
                    <img src={user.avatar} alt="avatar" width={28} height={28} className="w-7 h-7 rounded-full border border-gray-200" />
                  ) : (
                    <div className="w-7 h-7 rounded-full bg-sky-500 flex items-center justify-center text-white text-xs font-bold">
                      {(user.name || user.email || '?')[0].toUpperCase()}
                    </div>
                  )}
                  <span className="text-gray-700 text-sm font-medium hidden lg:inline">{user.name || user.email}</span>
                  <span className="text-gray-400 text-xs">▼</span>
                </button>
                {dropdownOpen && (
                  <div className="absolute right-0 mt-2 w-56 bg-white/95 backdrop-blur-xl border border-gray-200/80 rounded-2xl shadow-glow overflow-hidden z-50 animate-rise">
                    <Link href="/profile" className="flex items-center gap-2 px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 transition">
                      📊 {t('nav.dashboard')}
                    </Link>
                    <Link href="/workers" className="flex items-center gap-2 px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 transition">
                      🖥️ {t('nav.workers')}
                    </Link>
                    <Link href="/org" className="flex items-center gap-2 px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 transition">
                      🏢 {t('nav.org')}
                    </Link>
                    <Link href="/support" className="flex items-center gap-2 px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 transition">
                      🎫 {t('nav.support')}
                    </Link>
                    <Link href="/settings" className="flex items-center gap-2 px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 transition">
                      ⚙️ {t('nav.settings')}
                    </Link>
                    {user?.role === 'admin' && (
                      <Link href="/admin" className="flex items-center gap-2 px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 transition">
                        🛡️ {t('nav.admin')}
                      </Link>
                    )}
                    <hr className="border-gray-200" />
                    <button
                      onClick={handleLogout}
                      className="w-full flex items-center gap-2 px-4 py-3 text-sm text-red-500 hover:bg-red-50 transition"
                    >
                      🚪 {t('profile.logout')}
                    </button>
                  </div>
                )}
              </>
            ) : (
              <>
                <button
                  onClick={() => { setDropdownOpen(!dropdownOpen); resetAuthForm(); setAuthMode('login'); }}
                  className="btn-glow text-sm !py-2"
                >
                  {t('nav.login')}
                </button>
                {dropdownOpen && (
                  <div className="absolute right-0 mt-2 w-80 bg-white/95 backdrop-blur-xl border border-gray-200/80 rounded-2xl shadow-glow overflow-hidden z-50 p-5 animate-rise">
                    {authMode === 'login' && (
                      <div className="space-y-3">
                        <h3 className="text-gray-800 font-bold text-center">{t('nav.login')}</h3>
                        <input type="email" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)}
                          placeholder={t('nav.email')} className="w-full bg-white text-gray-800 placeholder-gray-400 border border-gray-200 px-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-400" />
                        <input type="password" value={authPassword} onChange={(e) => setAuthPassword(e.target.value)}
                          placeholder={t('nav.password')} className="w-full bg-white text-gray-800 placeholder-gray-400 border border-gray-200 px-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-400"
                          onKeyDown={(e) => e.key === 'Enter' && handleLogin()} />
                        {authError && <p className="text-red-500 text-xs">{authError}</p>}
                        <button onClick={handleLogin} disabled={authLoading || !authEmail || !authPassword}
                          className="w-full bg-sky-500 hover:bg-sky-600 text-white px-4 py-2 rounded-lg transition text-sm font-medium disabled:opacity-50">
                          {authLoading ? '...' : `🔑 ${t('nav.login')}`}
                        </button>
                        <button onClick={() => { setAuthMode('forgot'); resetAuthForm(); }}
                          className="w-full text-gray-500 hover:text-sky-600 text-xs transition">
                          {t('nav.forgotPassword')}
                        </button>
                        <div className="flex items-center gap-2 my-2">
                          <div className="flex-1 h-px bg-gray-200"></div>
                          <span className="text-gray-400 text-xs">{t('nav.or')}</span>
                          <div className="flex-1 h-px bg-gray-200"></div>
                        </div>
                        <GoogleLogin onSuccess={() => setDropdownOpen(false)} />
                        <p className="text-center text-gray-500 text-xs">
                          {t('nav.noAccount')}{' '}
                          <button onClick={() => { setAuthMode('signup'); resetAuthForm(); }} className="text-sky-600 hover:text-sky-700 transition font-medium">
                            {t('nav.signup')}
                          </button>
                        </p>
                      </div>
                    )}

                    {authMode === 'signup' && (
                      <div className="space-y-3">
                        <h3 className="text-gray-800 font-bold text-center">{t('nav.signup')}</h3>
                        <input type="email" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)}
                          placeholder={t('nav.email')} className="w-full bg-white text-gray-800 placeholder-gray-400 border border-gray-200 px-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-400" />
                        <input type="password" value={authPassword} onChange={(e) => setAuthPassword(e.target.value)}
                          placeholder={t('nav.password')} className="w-full bg-white text-gray-800 placeholder-gray-400 border border-gray-200 px-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-400"
                          onKeyDown={(e) => e.key === 'Enter' && handleSignup()} />
                        <p className="text-gray-500 text-xs">{t('nav.passwordHint')}</p>
                        {authError && <p className="text-red-500 text-xs">{authError}</p>}
                        <button onClick={handleSignup} disabled={authLoading || !authEmail || !authPassword}
                          className="w-full bg-emerald-500 hover:bg-emerald-600 text-white px-4 py-2 rounded-lg transition text-sm font-medium disabled:opacity-50">
                          {authLoading ? '...' : `📧 ${t('nav.signup')}`}
                        </button>
                        <div className="flex items-center gap-2 my-2">
                          <div className="flex-1 h-px bg-gray-200"></div>
                          <span className="text-gray-400 text-xs">{t('nav.or')}</span>
                          <div className="flex-1 h-px bg-gray-200"></div>
                        </div>
                        <GoogleLogin onSuccess={() => setDropdownOpen(false)} />
                        <p className="text-center text-gray-500 text-xs">
                          {t('nav.hasAccount')}{' '}
                          <button onClick={() => { setAuthMode('login'); resetAuthForm(); }} className="text-sky-600 hover:text-sky-700 transition font-medium">
                            {t('nav.login')}
                          </button>
                        </p>
                      </div>
                    )}

                    {authMode === 'forgot' && (
                      <div className="space-y-3">
                        <h3 className="text-gray-800 font-bold text-center">{t('nav.forgotPassword')}</h3>
                        <input type="email" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)}
                          placeholder={t('nav.email')} className="w-full bg-white text-gray-800 placeholder-gray-400 border border-gray-200 px-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-400"
                          onKeyDown={(e) => e.key === 'Enter' && handleForgotPassword()} />
                        {authError && <p className="text-red-500 text-xs">{authError}</p>}
                        {!authError && forgotSent && (
                          <p className="text-emerald-600 text-xs">{t('nav.resetEmailSent')}</p>
                        )}
                        <button onClick={handleForgotPassword} disabled={authLoading || !authEmail}
                          className="w-full bg-sky-500 hover:bg-sky-600 text-white px-4 py-2 rounded-lg transition text-sm font-medium disabled:opacity-50">
                          {authLoading ? '...' : `📧 ${t('nav.sendResetLink')}`}
                        </button>
                        <button onClick={() => { setAuthMode('login'); resetAuthForm(); }}
                          className="w-full text-gray-500 hover:text-sky-600 text-xs transition">
                          ← {t('nav.backToLogin')}
                        </button>
                      </div>
                    )}

                    {authMode === 'reset' && (
                      <div className="space-y-3">
                        <h3 className="text-gray-800 font-bold text-center">{t('nav.resetPassword')}</h3>
                        <input type="password" value={authPassword} onChange={(e) => setAuthPassword(e.target.value)}
                          placeholder={t('nav.newPassword')} className="w-full bg-white text-gray-800 placeholder-gray-400 border border-gray-200 px-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-400"
                          onKeyDown={(e) => e.key === 'Enter' && handleResetPassword()} />
                        <p className="text-gray-500 text-xs">{t('nav.passwordHint')}</p>
                        {authError && <p className="text-red-500 text-xs">{authError}</p>}
                        <button onClick={handleResetPassword} disabled={authLoading || !authPassword}
                          className="w-full bg-emerald-500 hover:bg-emerald-600 text-white px-4 py-2 rounded-lg transition text-sm font-medium disabled:opacity-50">
                          {authLoading ? '...' : `🔑 ${t('nav.resetPassword')}`}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <button
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label="Menu"
          aria-expanded={menuOpen}
          className="md:hidden flex items-center justify-center w-11 h-11 -mr-2 text-gray-700 text-2xl rounded-lg active:bg-gray-100"
        >
          {menuOpen ? '✕' : '☰'}
        </button>
      </div>

      {/* Mobile menu — full-screen overlay, portaled to <body> so the chat
          home's transformed frame can never trap or clip it (v3.42.1).
          Scrollable on its own, 44px close target, safe-area padded. */}
      {menuOpen && (
        <Portal>
        <div className="md:hidden fixed inset-0 z-[60] bg-white flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 flex-shrink-0">
            <Link href="/" onClick={closeMenu} aria-label="Plankton home"><Logo size={32} /></Link>
            <button
              onClick={closeMenu}
              aria-label="Close menu"
              className="flex items-center justify-center w-11 h-11 text-gray-700 text-2xl rounded-lg active:bg-gray-100"
            >✕</button>
          </div>
          <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(2rem,env(safe-area-inset-bottom))]">
            <div className="flex flex-col gap-3 pt-4">
              <LanguageSwitcher />
              <Link href="/worker" onClick={closeMenu} className="text-gray-600 hover:text-sky-700 transition py-2.5 text-base">{t('nav.worker')}</Link>
              <Link href="/#plans" onClick={() => { closeMenu(); window.dispatchEvent(new CustomEvent('plankton:show-plans')); }} className="text-gray-600 hover:text-sky-700 transition py-2.5 text-base">⭐ {t('nav.plans')}</Link>
              <Link href="/leaderboard" onClick={closeMenu} className="text-gray-600 hover:text-sky-700 transition py-2.5 text-base">🏆 {t('nav.leaderboard')}</Link>

            {user ? (
              <>
                <Link href="/profile" onClick={closeMenu} className="text-gray-600 hover:text-sky-700 transition py-2.5 text-base">📊 {t('nav.dashboard')}</Link>
                <Link href="/workers" onClick={closeMenu} className="text-gray-600 hover:text-sky-700 transition py-2.5 text-base">🖥️ {t('nav.workers')}</Link>
                <Link href="/org" onClick={closeMenu} className="text-gray-600 hover:text-sky-700 transition py-2.5 text-base">🏢 {t('nav.org')}</Link>
                <Link href="/support" onClick={closeMenu} className="text-gray-600 hover:text-sky-700 transition py-2.5 text-base">🎫 {t('nav.support')}</Link>
                <Link href="/settings" onClick={closeMenu} className="text-gray-600 hover:text-sky-700 transition py-2.5 text-base">⚙️ {t('nav.settings')}</Link>
                {user?.role === 'admin' && (
                  <Link href="/admin" onClick={closeMenu} className="text-gray-600 hover:text-sky-700 transition py-2.5 text-base">🛡️ {t('nav.admin')}</Link>
                )}
                <button onClick={handleLogout} className="text-red-500 hover:text-red-600 transition py-2.5 text-left text-base">
                  🚪 {t('profile.logout')}
                </button>
              </>
            ) : (
              <div className="py-2 space-y-3">
                {authMode === 'login' && (
                  <>
                    <input type="email" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)}
                      placeholder={t('nav.email')} className="w-full bg-white text-gray-800 placeholder-gray-400 border border-gray-200 px-3 py-2 rounded-lg text-sm" />
                    <input type="password" value={authPassword} onChange={(e) => setAuthPassword(e.target.value)}
                      placeholder={t('nav.password')} className="w-full bg-white text-gray-800 placeholder-gray-400 border border-gray-200 px-3 py-2 rounded-lg text-sm" />
                    {authError && <p className="text-red-500 text-xs">{authError}</p>}
                    <button onClick={handleLogin} disabled={authLoading || !authEmail || !authPassword}
                      className="w-full bg-sky-500 hover:bg-sky-600 text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50">
                      {authLoading ? '...' : `🔑 ${t('nav.login')}`}
                    </button>
                    <button onClick={() => { setAuthMode('forgot'); resetAuthForm(); }}
                      className="text-gray-500 hover:text-sky-600 text-xs">{t('nav.forgotPassword')}</button>
                    <div className="flex items-center gap-2 my-2">
                      <div className="flex-1 h-px bg-gray-200"></div>
                      <span className="text-gray-400 text-xs">{t('nav.or')}</span>
                      <div className="flex-1 h-px bg-gray-200"></div>
                    </div>
                    <GoogleLogin />
                    <p className="text-gray-500 text-xs">
                      {t('nav.noAccount')}{' '}
                      <button onClick={() => { setAuthMode('signup'); resetAuthForm(); }} className="text-sky-600">{t('nav.signup')}</button>
                    </p>
                  </>
                )}

                {authMode === 'signup' && (
                  <>
                    <input type="email" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)}
                      placeholder={t('nav.email')} className="w-full bg-white text-gray-800 placeholder-gray-400 border border-gray-200 px-3 py-2 rounded-lg text-sm" />
                    <input type="password" value={authPassword} onChange={(e) => setAuthPassword(e.target.value)}
                      placeholder={t('nav.password')} className="w-full bg-white text-gray-800 placeholder-gray-400 border border-gray-200 px-3 py-2 rounded-lg text-sm" />
                    <p className="text-gray-500 text-xs">{t('nav.passwordHint')}</p>
                    {authError && <p className="text-red-500 text-xs">{authError}</p>}
                    <button onClick={handleSignup} disabled={authLoading || !authEmail || !authPassword}
                      className="w-full bg-emerald-500 hover:bg-emerald-600 text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50">
                      {authLoading ? '...' : `📧 ${t('nav.signup')}`}
                    </button>
                    <div className="flex items-center gap-2 my-2">
                      <div className="flex-1 h-px bg-gray-200"></div>
                      <span className="text-gray-400 text-xs">{t('nav.or')}</span>
                      <div className="flex-1 h-px bg-gray-200"></div>
                    </div>
                    <GoogleLogin />
                    <p className="text-gray-500 text-xs">
                      {t('nav.hasAccount')}{' '}
                      <button onClick={() => { setAuthMode('login'); resetAuthForm(); }} className="text-sky-600">{t('nav.login')}</button>
                    </p>
                  </>
                )}

                {authMode === 'forgot' && (
                  <>
                    <input type="email" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)}
                      placeholder={t('nav.email')} className="w-full bg-white text-gray-800 placeholder-gray-400 border border-gray-200 px-3 py-2 rounded-lg text-sm" />
                    {authError && <p className="text-red-500 text-xs">{authError}</p>}
                    {!authError && forgotSent && (
                      <p className="text-emerald-600 text-xs">{t('nav.resetEmailSent')}</p>
                    )}
                    <button onClick={handleForgotPassword} disabled={authLoading || !authEmail}
                      className="w-full bg-sky-500 hover:bg-sky-600 text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50">
                      {authLoading ? '...' : `📧 ${t('nav.sendResetLink')}`}
                    </button>
                    <button onClick={() => { setAuthMode('login'); resetAuthForm(); }}
                      className="text-gray-500 hover:text-sky-600 text-xs">← {t('nav.backToLogin')}</button>
                  </>
                )}

                {authMode === 'reset' && (
                  <>
                    <input type="password" value={authPassword} onChange={(e) => setAuthPassword(e.target.value)}
                      placeholder={t('nav.newPassword')} className="w-full bg-white text-gray-800 placeholder-gray-400 border border-gray-200 px-3 py-2 rounded-lg text-sm" />
                    <p className="text-gray-500 text-xs">{t('nav.passwordHint')}</p>
                    {authError && <p className="text-red-500 text-xs">{authError}</p>}
                    <button onClick={handleResetPassword} disabled={authLoading || !authPassword}
                      className="w-full bg-emerald-500 hover:bg-emerald-600 text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50">
                      {authLoading ? '...' : `🔑 ${t('nav.resetPassword')}`}
                    </button>
                  </>
                )}
              </div>
            )}
            </div>
          </div>
        </div>
        </Portal>
      )}
    </nav>
  );
}

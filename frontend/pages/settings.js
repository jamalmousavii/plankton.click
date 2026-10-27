import Head from 'next/head';
import Link from 'next/link';
import { useState, useEffect } from 'react';
import { useLanguage } from '../i18n/LanguageContext';
import { LANGUAGES } from '../i18n/translations';
import Navbar from '../components/Navbar';
import { useAuth, clearSession, apiFetch, ApiError, setSession, getUser } from '../utils/api';

export default function Settings() {
  const { t, lang, changeLang } = useLanguage();
  const [langOpen, setLangOpen] = useState(false);

  const [usdBalance, setUsdBalance] = useState({ available: 0, total_earned: 0, total_spent: 0 });
  const [walletTab, setWalletTab] = useState('topup');
  const [depositAmount, setDepositAmount] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawAddress, setWithdrawAddress] = useState('');
  const [deposits, setDeposits] = useState([]);
  const [withdrawals, setWithdrawals] = useState([]);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletMessage, setWalletMessage] = useState('');

  const [hasPassword, setHasPassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordLoading, setPasswordLoading] = useState('');
  const [passwordMessage, setPasswordMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  // v3.43.0 — coder API keys for AI agents (opencode et al).
  const [apiKeys, setApiKeys] = useState([]);
  const [keyName, setKeyName] = useState('');
  const [newKey, setNewKey] = useState('');
  const [keyMsg, setKeyMsg] = useState('');
  const [keyLoading, setKeyLoading] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const [copiedCfg, setCopiedCfg] = useState(false);

  const { ready, user } = useAuth();

  useEffect(() => {
    if (user) {
      fetchBalance();
      fetchHistory();
    }
    setLoading(false);
  }, [user]);

  const fetchBalance = async () => {
    try {
      const data = await apiFetch('/api/payments/balance');
      // F2: seed the password form branch from the server, not a guess.
      if (typeof data.has_password === 'boolean') setHasPassword(data.has_password);
      if (data.success && data.balances?.USD) setUsdBalance(data.balances.USD);
    } catch (err) {
      // F15: a failed dashboard fetch used to fail silently.
      setLoadError(true);
    }
  };

  const fetchHistory = async () => {
    try {
      const data = await apiFetch('/api/payments/history');
      if (data.success) {
        setDeposits(data.deposits || []);
        setWithdrawals(data.withdrawals || []);
      }
    } catch (err) {
      // F15: a failed dashboard fetch used to fail silently.
      setLoadError(true);
    }
  };

  // v3.43.0 — coder API keys (max 10 active; raw secret shown once).
  const fetchKeys = async () => {
    try {
      const data = await apiFetch('/api/keys');
      if (data.success) setApiKeys(data.keys || []);
    } catch (err) {}
  };

  useEffect(() => { if (user) fetchKeys(); }, [user]);

  const createKey = async () => {
    if (!keyName.trim()) return;
    setKeyLoading(true);
    setKeyMsg('');
    try {
      const data = await apiFetch('/api/keys', {
        method: 'POST',
        body: JSON.stringify({ name: keyName.trim() }),
      });
      if (data.success) {
        setNewKey(data.key);
        setKeyName('');
        fetchKeys();
      } else {
        setKeyMsg(`❌ ${data.error || 'Error'}`);
      }
    } catch (err) {
      setKeyMsg(`❌ ${err instanceof ApiError ? err.message : t('chat.errorConnection')}`);
    }
    setKeyLoading(false);
  };

  const revokeKey = async (id) => {
    try {
      const data = await apiFetch(`/api/keys/${id}`, { method: 'DELETE' });
      if (data.success) fetchKeys();
      else setKeyMsg(`❌ ${data.error || 'Error'}`);
    } catch (err) {
      setKeyMsg(`❌ ${err instanceof ApiError ? err.message : t('chat.errorConnection')}`);
    }
  };

  const copyText = async (text, which) => {
    try {
      await navigator.clipboard.writeText(text);
      if (which === 'key') { setCopiedKey(true); setTimeout(() => setCopiedKey(false), 2000); }
      else { setCopiedCfg(true); setTimeout(() => setCopiedCfg(false), 2000); }
    } catch (e) {}
  };

  const opencodeSnippet = `{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "plankton": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Plankton",
      "options": {
        "baseURL": "https://plankton.click/v1",
        "apiKey": "{env:PLANKTON_API_KEY}"
      },
      "models": {
        "qwen3-coder:30b": {
          "name": "Qwen3 Coder 30B",
          "limit": { "context": 262144, "output": 32768 }
        },
        "qwen2.5-coder:32b": {
          "name": "Qwen2.5 Coder 32B",
          "limit": { "context": 32768, "output": 8192 }
        }
      }
    }
  }
}`;

  const handleDeposit = async () => {
    if (!depositAmount || parseFloat(depositAmount) <= 0) return;
    setWalletLoading(true); setWalletMessage('');
    try {
      const data = await apiFetch('/api/payments/deposit/create', {
        method: 'POST',
        body: JSON.stringify({ amount_usd: parseFloat(depositAmount) })
      });
      if (data.success) {
        // F11: noopener — the invoice tab must not get window.opener.
        window.open(data.invoice.url, '_blank', 'noopener,noreferrer');
        setWalletMessage(t('settings.depositOk'));
        setDepositAmount('');
      } else {
        setWalletMessage(`❌ ${data.error}`);
      }
    } catch (err) { setWalletMessage(`❌ ${err instanceof ApiError ? err.message : t('settings.depositFailed')}`); }
    setWalletLoading(false);
  };

  const handleWithdraw = async () => {
    if (!withdrawAmount || !withdrawAddress) return;
    setWalletLoading(true); setWalletMessage('');
    try {
      const data = await apiFetch('/api/payments/withdraw', {
        method: 'POST',
        body: JSON.stringify({ amount: parseFloat(withdrawAmount), toAddress: withdrawAddress })
      });
      if (data.success) {
        setWalletMessage(t('settings.withdrawOk')
        .replace('{amount}', data.withdrawal.amount)
        .replace('{fee}', data.withdrawal.fee));
        setWithdrawAmount('');
        setWithdrawAddress('');
        fetchBalance();
      } else {
        setWalletMessage(`❌ ${data.error}`);
      }
    } catch (err) { setWalletMessage(`❌ ${err instanceof ApiError ? err.message : t('settings.withdrawFailed')}`); }
    setWalletLoading(false);
  };

  const handleSetPassword = async () => {
    if (!newPassword || !confirmPassword) return;
    if (newPassword !== confirmPassword) {
      setPasswordMessage('❌ Passwords do not match');
      return;
    }
    setPasswordLoading('set');
    setPasswordMessage('');
    try {
      const data = await apiFetch('/api/auth/set-password', {
        method: 'POST',
        body: JSON.stringify({ password: newPassword })
      });
      if (data.success) {
        setPasswordMessage('✅ Password set successfully');
        setHasPassword(true);
        setNewPassword('');
        setConfirmPassword('');
        // H3: password mutation bumped token_version — adopt the fresh token
        // so THIS session survives (all other sessions die).
        if (data.token) setSession(data.token, getUser());
      } else {
        setPasswordMessage(`❌ ${data.error}`);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 400 && /already set/i.test(err.message)) {
        // F2: someone else set it first (or our seed was stale) — flip to the
        // change-form instead of leaving the user at a dead end.
        setHasPassword(true);
        setPasswordMessage('❌ Password already set — use the change form below.');
      } else {
        setPasswordMessage(`❌ ${err instanceof ApiError ? err.message : t('settings.pwdSetFailed')}`);
      }
    }
    setPasswordLoading('');
  };

  const handleChangePassword = async () => {
    if (!currentPassword || !newPassword || !confirmPassword) return;
    if (newPassword !== confirmPassword) {
      setPasswordMessage('❌ Passwords do not match');
      return;
    }
    setPasswordLoading('change');
    setPasswordMessage('');
    try {
      const data = await apiFetch('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword })
      });
      if (data.success) {
        setPasswordMessage('✅ Password changed successfully');
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
        // H3: adopt the fresh token so this session survives the version bump.
        if (data.token) setSession(data.token, getUser());
      } else {
        setPasswordMessage(`❌ ${data.error}`);
      }
    } catch (err) { setPasswordMessage(`❌ ${err instanceof ApiError ? err.message : t('settings.pwdChangeFailed')}`); }
    setPasswordLoading('');
  };

  const currentLang = LANGUAGES.find(l => l.code === lang) || LANGUAGES[0];

  if (loading || !user) {
    return (
      <div className="flex-1 page-surface flex items-center justify-center">
        <div className="text-gray-600 text-lg">Loading...</div>
      </div>
    );
  }

  const retryLoad = () => {
    setLoadError(false);
    fetchBalance(); fetchHistory();
  };

  const errorBanner = loadError && (
    <div className="mb-4 bg-red-50 border border-red-200 text-red-600 text-sm rounded-xl px-4 py-3 flex items-center justify-between gap-3">
      <span>{t('common.loadFailed')}</span>
      <button onClick={retryLoad} className="font-bold underline min-h-[36px]">{t('common.retry')}</button>
    </div>
  );

  return (
    <div className={`flex-1 page-surface`}>
      <Head><title>{t('profile.settings')} - Plankton Network</title></Head>

      <Navbar />
        {errorBanner}

      <main className="container mx-auto px-4 md:px-6 py-6 md:py-12 max-w-2xl">
        {/* Quick nav */}
        <div className="flex gap-2 mb-6 flex-wrap">
          <Link href="/profile" className="px-4 py-2 min-h-[40px] inline-flex items-center rounded-lg text-sm font-bold bg-white text-gray-600 border border-sky-200 hover:bg-sky-50">📊 {t('nav.dashboard')}</Link>
          <Link href="/workers" className="px-4 py-2 min-h-[40px] inline-flex items-center rounded-lg text-sm font-bold bg-white text-gray-600 border border-sky-200 hover:bg-sky-50">🖥️ {t('nav.workers')}</Link>
          <Link href="/support" className="px-4 py-2 min-h-[40px] inline-flex items-center rounded-lg text-sm font-bold bg-white text-gray-600 border border-sky-200 hover:bg-sky-50">🎫 {t('nav.support')}</Link>
          <Link href="/settings" className="px-4 py-2 min-h-[40px] inline-flex items-center rounded-lg text-sm font-bold bg-sky-500 text-white">⚙️ {t('nav.settings')}</Link>
        </div>

        <div className="bg-white rounded-xl border border-sky-100 shadow-sm p-5 md:p-6 mb-6">
          <h2 className="text-lg font-bold text-gray-800 mb-4">⚙️ {t('profile.settings')}</h2>

          {/* Language */}
          <div className="mb-5">
            <h3 className="text-sm font-medium text-gray-600 mb-2">🌐 {t('profile.language')}</h3>
            <div className="relative" style={{ position: 'relative' }}>
              <button
                onClick={() => setLangOpen(!langOpen)}
                className="w-full flex items-center gap-3 bg-sky-50 hover:bg-sky-100 border border-sky-200 px-4 py-2.5 rounded-lg text-sm font-medium text-gray-700 transition min-h-[44px]"
              >
                <span className="text-base leading-none">{currentLang.flag}</span>
                <span className="flex-1 text-left">{currentLang.name}</span>
                <span className="text-gray-400 text-xs">▼</span>
              </button>
              {langOpen && (
                <div className="absolute left-0 right-0 mt-1 max-h-[300px] overflow-y-auto bg-white border border-sky-200 rounded-xl shadow-xl z-50 py-1">
                  {LANGUAGES.map(l => (
                    <button
                      key={l.code}
                      onClick={() => { changeLang(l.code); setLangOpen(false); }}
                      className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition text-left min-h-[44px] ${
                        lang === l.code ? 'bg-sky-50 text-sky-700 font-bold' : 'text-gray-700 hover:bg-sky-50'
                      }`}
                    >
                      <span className="text-base leading-none w-5">{l.flag}</span>
                      <span className="flex-1 truncate">{l.name}</span>
                      {lang === l.code && <span className="text-sky-500 text-xs">✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* USD Wallet */}
          <div className="mb-5">
            <h3 className="text-sm font-medium text-gray-600 mb-2">💰 {t('settings.walletUsd')}</h3>
            <div className="bg-sky-50 rounded-lg p-4 border border-sky-100">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
                <div className="text-center">
                  <div className="text-lg font-bold text-emerald-600">${parseFloat(usdBalance.available || 0).toFixed(2)}</div>
                  <div className="text-gray-500 text-xs">{t('profile.available')}</div>
                </div>
                <div className="text-center">
                  <div className="text-lg font-bold text-sky-600">${parseFloat(usdBalance.total_earned || 0).toFixed(2)}</div>
                  <div className="text-gray-500 text-xs">{t('profile.earned')}</div>
                </div>
                <div className="text-center">
                  <div className="text-lg font-bold text-gray-500">${parseFloat(usdBalance.total_spent || 0).toFixed(2)}</div>
                  <div className="text-gray-500 text-xs">{t('profile.spent')}</div>
                </div>
              </div>

              <div className="flex gap-1 mb-3">
                {['topup', 'withdraw', 'history'].map(tab => (
                  <button key={tab} onClick={() => setWalletTab(tab)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold min-h-[36px] ${walletTab === tab ? 'bg-sky-500 text-white' : 'bg-white text-gray-500 hover:bg-sky-100 border border-sky-200'}`}>
                    {tab === 'topup' ? `📥 ${t('settings.topUp')}` : tab === 'withdraw' ? `📤 ${t('settings.withdraw')}` : `📋 ${t('settings.history')}`}
                  </button>
                ))}
              </div>

              {walletTab === 'topup' && (
                <div>
                  <p className="text-gray-500 text-xs mb-2">{t('settings.depositHint')}</p>
                  <div className="flex gap-2">
                    <input type="number" value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)}
                      placeholder={t('settings.amountUsd')} className="flex-1 bg-white text-gray-800 placeholder-gray-400 border border-sky-200 px-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-sky-400" min="1" step="0.01" />
                    <button onClick={handleDeposit} disabled={walletLoading || !depositAmount}
                      className="bg-emerald-500 hover:bg-emerald-600 text-white px-4 py-2 rounded-lg transition text-sm disabled:opacity-50 min-h-[40px]">
                      {t('settings.topUpBtn')}
                    </button>
                  </div>
                </div>
              )}

              {walletTab === 'withdraw' && (
                <div className="space-y-2">
                  <p className="text-gray-500 text-xs">{t('settings.withdrawHint')}</p>
                  <input type="text" value={withdrawAddress} onChange={(e) => setWithdrawAddress(e.target.value)}
                    placeholder={t('settings.withdrawAddress')} className="w-full bg-white text-gray-800 placeholder-gray-400 border border-sky-200 px-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-sky-400 min-h-[40px]" />
                  <div className="flex gap-2">
                    <input type="number" value={withdrawAmount} onChange={(e) => setWithdrawAmount(e.target.value)}
                      placeholder={t('settings.amountUsd')} className="flex-1 bg-white text-gray-800 placeholder-gray-400 border border-sky-200 px-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-sky-400" min="5" step="0.01" />
                    <button onClick={handleWithdraw} disabled={walletLoading || !withdrawAmount || !withdrawAddress}
                      className="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded-lg transition text-sm disabled:opacity-50 min-h-[40px]">
                      {t('settings.withdrawBtn')}
                    </button>
                  </div>
                </div>
              )}

              {walletTab === 'history' && (
                <div className="space-y-2 max-h-40 overflow-y-auto">
                  {deposits.length === 0 && withdrawals.length === 0 ? (
                    <p className="text-gray-500 text-xs text-center py-2">{t('settings.noTransactions')}</p>
                  ) : (
                    <>
                      {deposits.slice(0, 5).map((d, i) => (
                        <div key={`d${i}`} className="flex justify-between items-center py-1 text-xs border-b border-sky-100">
                          <span className="text-emerald-600">+${parseFloat(d.amount).toFixed(2)} USD</span>
                          <span className={`${d.status === 'completed' ? 'text-emerald-600' : 'text-amber-500'}`}>{d.status}</span>
                        </div>
                      ))}
                      {withdrawals.slice(0, 5).map((w, i) => (
                        <div key={`w${i}`} className="flex justify-between items-center py-1 text-xs border-b border-sky-100">
                          <span className="text-red-500">-${parseFloat(w.amount).toFixed(2)} USD</span>
                          <span className={`${w.status === 'completed' ? 'text-emerald-600' : 'text-amber-500'}`}>{w.status}</span>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}

              {walletMessage && <p className="text-xs text-gray-600 mt-2">{walletMessage}</p>}
            </div>
          </div>

          {/* Coder API keys for AI agents (v3.43.0) */}
          <div className="mb-5">
            <h3 className="text-sm font-medium text-gray-600 mb-2">🤖 {t('settings.apiKeysTitle')}</h3>
            <div className="bg-sky-50 rounded-lg p-4 border border-sky-100 space-y-3">
              <p className="text-gray-500 text-xs">{t('settings.apiKeysDesc')}</p>

              {newKey && (
                <div className="bg-white border border-emerald-200 rounded-lg p-3">
                  <p className="text-emerald-700 text-xs font-bold mb-1">{t('settings.apiKeyOnce')}</p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-emerald-700 text-xs break-all">{newKey}</code>
                    <button onClick={() => copyText(newKey, 'key')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition min-h-[36px] ${copiedKey ? 'bg-emerald-500 text-white' : 'bg-sky-500 hover:bg-sky-600 text-white'}`}>
                      {copiedKey ? '✓' : '📋'}
                    </button>
                  </div>
                </div>
              )}

              <div className="flex gap-2">
                <input type="text" value={keyName} onChange={(e) => setKeyName(e.target.value)}
                  placeholder={t('settings.apiKeyName')} maxLength={100}
                  className="flex-1 bg-white text-gray-800 placeholder-gray-400 border border-sky-200 px-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-sky-400 min-h-[40px]" />
                <button onClick={createKey} disabled={keyLoading || !keyName.trim() || apiKeys.filter((k) => k.active).length >= 10}
                  className="bg-emerald-500 hover:bg-emerald-600 text-white px-4 py-2 rounded-lg transition text-sm disabled:opacity-50 min-h-[40px]">
                  {keyLoading ? '...' : `＋ ${t('settings.apiKeyCreate')}`}
                </button>
              </div>

              {apiKeys.length > 0 ? (
                <div className="space-y-1.5">
                  {apiKeys.map((k) => (
                    <div key={k.id} className="flex items-center gap-2 bg-white border border-sky-100 rounded-lg px-3 py-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-gray-800 text-xs font-bold truncate">{k.name}</div>
                        <div className="text-gray-400 text-xs font-mono">{k.key_prefix}…{k.active ? '' : ` • ${t('settings.apiKeyRevoked')}`}</div>
                      </div>
                      {k.active && (
                        <button onClick={() => revokeKey(k.id)}
                          className="text-red-400 hover:text-red-600 text-xs font-bold transition flex-shrink-0">
                          {t('settings.apiKeyRevoke')}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-gray-400 text-xs">{t('settings.apiKeyNone')}</p>
              )}
              {keyMsg && <p className="text-xs text-gray-600">{keyMsg}</p>}

              <div>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-gray-600 text-xs font-bold">{t('settings.apiOpencodeTitle')}</p>
                  <button onClick={() => copyText(opencodeSnippet, 'cfg')}
                    className={`px-3 py-1 rounded-lg text-xs font-bold transition ${copiedCfg ? 'bg-emerald-500 text-white' : 'bg-sky-500 hover:bg-sky-600 text-white'}`}>
                    {copiedCfg ? '✓' : '📋'}
                  </button>
                </div>
                <pre className="bg-gray-900 text-emerald-200 rounded-lg p-3 text-[11px] overflow-x-auto whitespace-pre">{opencodeSnippet}</pre>
                <p className="text-gray-400 text-xs mt-1">{t('settings.apiOpencodeHint')}</p>
              </div>
            </div>
          </div>

          {/* Password */}
          <div>
            <h3 className="text-sm font-medium text-gray-600 mb-2">🔐 {t('profile.password')}</h3>
            {!hasPassword ? (
              <div className="space-y-3">
                <p className="text-gray-500 text-sm">{t('profile.setPasswordDesc')}</p>
                <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                  placeholder={t('profile.newPassword')} className="w-full bg-white text-gray-800 placeholder-gray-400 border border-sky-200 px-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-sky-400" />
                <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder={t('profile.confirmPassword')} className="w-full bg-white text-gray-800 placeholder-gray-400 border border-sky-200 px-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-sky-400" />
                <button onClick={handleSetPassword} disabled={passwordLoading === 'set' || !newPassword || !confirmPassword}
                  className="w-full bg-emerald-500 hover:bg-emerald-600 text-white px-4 py-2 rounded-lg transition text-sm disabled:opacity-50 min-h-[44px]">
                  {passwordLoading === 'set' ? '...' : `🔑 ${t('profile.setPassword')}`}
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-gray-500 text-sm">{t('profile.changePasswordDesc')}</p>
                <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder={t('profile.currentPassword')} className="w-full bg-white text-gray-800 placeholder-gray-400 border border-sky-200 px-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-sky-400" />
                <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                  placeholder={t('profile.newPassword')} className="w-full bg-white text-gray-800 placeholder-gray-400 border border-sky-200 px-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-sky-400" />
                <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder={t('profile.confirmPassword')} className="w-full bg-white text-gray-800 placeholder-gray-400 border border-sky-200 px-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-sky-400" />
                <button onClick={handleChangePassword} disabled={passwordLoading === 'change' || !currentPassword || !newPassword || !confirmPassword}
                  className="w-full bg-sky-500 hover:bg-sky-600 text-white px-4 py-2 rounded-lg transition text-sm disabled:opacity-50 min-h-[44px]">
                  {passwordLoading === 'change' ? '...' : `🔑 ${t('profile.changePassword')}`}
                </button>
              </div>
            )}
            {passwordMessage && <p className="text-xs text-gray-600 mt-2">{passwordMessage}</p>}
          </div>
        </div>
      </main>
    </div>
  );
}

import Head from 'next/head';
import { useState, useEffect } from 'react';
import { useLanguage } from '../i18n/LanguageContext';
import Navbar from '../components/Navbar';
import { useAuth, apiFetch, ApiError } from '../utils/api';

// v3.44.0 — organization plans: an org shares its leader's plan cap as one
// bucket. Leaders add registered users by email; members see usage.
export default function Org() {
  const { t } = useLanguage();
  const [org, setOrg] = useState(null);
  const [members, setMembers] = useState([]);
  const [bucket, setBucket] = useState(null);
  const [usage, setUsage] = useState([]);
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState(null); // { ok, text }
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [transferId, setTransferId] = useState('');

  const { ready, user } = useAuth();
  const isLeader = !!org && org.role === 'leader';

  useEffect(() => { if (user) fetchMine(); }, [user]);

  const fetchMine = async () => {
    setLoading(true);
    try {
      const data = await apiFetch('/api/orgs/mine');
      if (data.success) {
        setOrg(data.org || null);
        setMembers(data.members || []);
        setBucket(data.bucket || null);
        if (data.org) {
          try {
            const u = await apiFetch('/api/orgs/usage');
            if (u.success) setUsage(u.usage || []);
          } catch (e) {}
        }
      }
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) setMsg({ ok: false, text: t('common.loadFailed') });
      setOrg(null);
    }
    setLoading(false);
  };

  const act = async (path, opts, okText) => {
    setBusy(true);
    setMsg(null);
    try {
      const data = await apiFetch(path, opts);
      if (data.success) {
        if (okText) setMsg({ ok: true, text: okText });
        await fetchMine();
      } else setMsg({ ok: false, text: data.error || t('common.loadFailed') });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : t('common.loadFailed') });
    }
    setBusy(false);
  };

  const addMember = () => {
    if (!email.trim()) return;
    act('/api/orgs/members', { method: 'POST', body: JSON.stringify({ email: email.trim() }) }, t('org.memberAdded'))
      .then(() => setEmail(''));
  };

  const fmtTokens = (n) => Number(n || 0).toLocaleString('en-US');

  return (
    <div className="flex-1 page-surface">
      <Head><title>{t('org.pageTitle')}</title></Head>
      <Navbar />
      <main className="container mx-auto px-4 md:px-6 py-6 md:py-12 pb-8 max-w-3xl">
        <h1 className="text-2xl md:text-4xl font-bold text-gray-800 text-center mb-3">🏢 {t('org.heading')}</h1>
        <p className="text-center text-gray-500 mb-6 text-sm md:text-base">{t('org.desc')}</p>

        {msg && (
          <div className={`mb-4 rounded-xl px-4 py-3 text-sm border ${msg.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-600'}`}>
            {msg.text}
          </div>
        )}

        {loading ? (
          <p className="text-gray-500 text-center py-10">{t('common.loading')}</p>
        ) : !org ? (
          <div className="bg-white border border-sky-100 shadow-sm rounded-xl p-6 text-center">
            <p className="text-gray-600 text-sm md:text-base">{t('org.noOrg')}</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="bg-white border border-sky-100 shadow-sm rounded-xl p-5">
              <div className="flex items-center justify-between gap-2 mb-1">
                <h2 className="text-lg font-bold text-gray-800">🏢 {org.name}</h2>
                <span className="text-xs font-bold px-2 py-1 rounded-full bg-sky-50 text-sky-700">
                  {isLeader ? `👑 ${t('org.roleLeader')}` : t('org.roleMember')}
                </span>
              </div>
              {bucket && (
                <p className="text-gray-500 text-xs mb-3">
                  {t('org.bucketLine')
                    .replace('{used}', fmtTokens(bucket.limit - bucket.remaining))
                    .replace('{limit}', fmtTokens(bucket.limit))}
                </p>
              )}
              <div className="space-y-1">
                {members.map((m) => (
                  <div key={m.id} className="flex items-center justify-between gap-2 text-sm bg-sky-50/50 rounded-lg px-3 py-1.5">
                    <span className="text-gray-700 truncate">{m.email} {m.role === 'leader' && <span className="text-amber-600 font-bold">👑</span>}</span>
                    {isLeader && m.role !== 'leader' && (
                      <button onClick={() => act(`/api/orgs/members/${m.id}`, { method: 'DELETE' }, t('org.memberRemoved'))}
                        disabled={busy}
                        className="text-red-400 hover:text-red-600 text-xs font-bold transition disabled:opacity-50">
                        {t('org.remove')}
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {isLeader && (
                <div className="flex gap-2 mt-3">
                  <input value={email} onChange={(e) => setEmail(e.target.value)} type="email"
                    placeholder={t('org.addPh')}
                    className="flex-1 bg-white text-gray-800 placeholder-gray-400 border border-sky-200 px-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-sky-400 min-h-[40px]" />
                  <button onClick={addMember} disabled={busy || !email.trim()}
                    className="bg-sky-500 hover:bg-sky-600 text-white px-4 py-2 rounded-lg transition text-sm font-bold disabled:opacity-50 min-h-[40px]">
                    ＋ {t('org.addBtn')}
                  </button>
                </div>
              )}
              <div className="flex gap-2 mt-3">
                <button onClick={() => act('/api/orgs/leave', { method: 'POST' }, t('org.left'))}
                  disabled={busy}
                  className="text-red-400 hover:text-red-600 text-xs font-bold transition disabled:opacity-50 min-h-[36px]">
                  {t('org.leave')}
                </button>
                {isLeader && (
                  <div className="flex gap-2 flex-1">
                    <input value={transferId} onChange={(e) => setTransferId(e.target.value)} type="number" min="1"
                      placeholder={t('org.transferPh')}
                      className="flex-1 bg-white text-gray-800 placeholder-gray-400 border border-sky-200 px-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-sky-400 min-h-[36px]" />
                    <button onClick={() => {
                      if (!transferId) return;
                      act('/api/orgs/transfer', { method: 'POST', body: JSON.stringify({ user_id: parseInt(transferId, 10) }) }, t('org.transferred'))
                        .then(() => setTransferId(''));
                    }} disabled={busy || !transferId}
                      className="bg-amber-500 hover:bg-amber-600 text-white px-3 py-2 rounded-lg transition text-xs font-bold disabled:opacity-50 min-h-[36px]">
                      {t('org.transferBtn')}
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="bg-white border border-sky-100 shadow-sm rounded-xl p-5">
              <h3 className="text-gray-800 font-bold text-sm md:text-base mb-3">📊 {t('org.usageTitle')}</h3>
              {usage.length === 0 ? (
                <p className="text-gray-400 text-xs text-center py-4">{t('org.noUsage')}</p>
              ) : (
                <div className="space-y-1">
                  {usage.map((u) => (
                    <div key={u.id} className="flex items-center justify-between gap-2 text-sm bg-sky-50/50 rounded-lg px-3 py-1.5">
                      <span className="text-gray-700 truncate">{u.email}</span>
                      <span className="text-gray-500 text-xs flex-shrink-0">
                        {fmtTokens(u.tokens)} tk · {u.messages} msg · ${Number(u.cost || 0).toFixed(4)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

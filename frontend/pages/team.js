import Head from 'next/head';
import { useState, useEffect } from 'react';
import { useLanguage } from '../i18n/LanguageContext';
import Navbar from '../components/Navbar';
import { useAuth, apiFetch, ApiError } from '../utils/api';

// Teams: a shared account with its own plan and token pot. Members spend the
// team's daily plan allowance first, then its pot, then their own coverage.
// The owner adds members by email and can cap each member per day.
export default function Team() {
  const { t } = useLanguage();
  const [data, setData] = useState(null); // { team, status, me, members }
  const [email, setEmail] = useState('');
  const [teamName, setTeamName] = useState('');
  const [limits, setLimits] = useState({}); // userId -> draft
  const [msg, setMsg] = useState(null); // { ok, text }
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [transferId, setTransferId] = useState('');

  const { ready, user } = useAuth();
  const team = data?.team || null;
  const isOwner = !!team && team.role === 'owner';

  useEffect(() => { if (user) fetchMine(); }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchMine = async () => {
    setLoading(true);
    try {
      const d = await apiFetch('/api/teams/mine');
      setData(d.success ? d : null);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) setMsg({ ok: false, text: t('common.loadFailed') });
      setData(null);
    }
    setLoading(false);
  };

  const act = async (path, opts, okText) => {
    setBusy(true);
    setMsg(null);
    try {
      const d = await apiFetch(path, opts);
      if (d.success) {
        if (okText) setMsg({ ok: true, text: okText });
        await fetchMine();
        setBusy(false);
        return true;
      }
      setMsg({ ok: false, text: d.error || t('common.loadFailed') });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : t('common.loadFailed') });
    }
    setBusy(false);
    return false;
  };

  const num = (n) => Number(n || 0).toLocaleString('en-US');
  const createTeam = () => {
    if (!teamName.trim()) return;
    act('/api/teams', { method: 'POST', body: JSON.stringify({ name: teamName.trim() }) }, t('team.created'))
      .then((ok) => ok && setTeamName(''));
  };
  const addMember = () => {
    if (!email.trim()) return;
    act('/api/teams/members', { method: 'POST', body: JSON.stringify({ email: email.trim() }) }, t('team.memberAdded'))
      .then((ok) => ok && setEmail(''));
  };
  const saveLimit = (m) => {
    const raw = String(limits[m.id] ?? '').trim();
    const value = raw === '' ? null : parseInt(raw.replace(/[^0-9]/g, ''), 10);
    act(`/api/teams/members/${m.id}/limit`, { method: 'PUT', body: JSON.stringify({ daily_limit: value }) }, t('team.limitSaved'));
  };

  const st = data?.status;
  const plan = st?.plan;
  const pct = plan && plan.daily_tokens ? Math.min(100, (100 * (st.used_today || 0)) / plan.daily_tokens) : 0;

  return (
    <div className="flex-1 page-surface">
      <Head><title>{t('team.pageTitle')}</title></Head>
      <Navbar />
      <main className="container mx-auto px-4 md:px-6 py-6 md:py-12 max-w-3xl">
        <h1 className="text-2xl md:text-4xl font-bold text-gray-800 text-center mb-3">👥 {t('team.heading')}</h1>
        <p className="text-center text-gray-500 mb-6 text-sm md:text-base">{t('team.desc')}</p>

        {msg && (
          <div className={`mb-4 rounded-xl px-4 py-3 text-sm border ${msg.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-600'}`}>
            {msg.text}
          </div>
        )}

        {ready && !user && (
          <div className="bg-white border border-sky-100 shadow-sm rounded-xl p-6 text-center text-gray-600">{t('team.loginFirst')}</div>
        )}

        {user && loading && <p className="text-gray-500 text-center py-10">{t('common.loading')}</p>}

        {user && !loading && !team && (
          <div className="bg-white border border-sky-100 shadow-sm rounded-xl p-6 space-y-4">
            <p className="text-gray-600 text-sm md:text-base">{t('team.noTeam')}</p>
            <div className="flex gap-2">
              <input value={teamName} onChange={(e) => setTeamName(e.target.value)} maxLength={100}
                onKeyDown={(e) => e.key === 'Enter' && createTeam()}
                placeholder={t('team.namePh')}
                className="flex-1 border border-sky-200 rounded-lg px-3 py-2 text-sm bg-white" />
              <button onClick={createTeam} disabled={busy || !teamName.trim()}
                className="btn-glow text-sm !py-2 disabled:opacity-50">＋ {t('team.createBtn')}</button>
            </div>
          </div>
        )}

        {user && !loading && team && (
          <div className="space-y-4">
            <div className="bg-white border border-sky-100 shadow-sm rounded-xl p-5">
              <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
                <div className="text-lg font-bold text-gray-800">{team.name}</div>
                <span className={`px-2 py-0.5 rounded text-xs ${isOwner ? 'bg-amber-100 text-amber-700' : 'bg-sky-100 text-sky-700'}`}>
                  {isOwner ? `👑 ${t('team.roleOwner')}` : t('team.roleMember')}
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                <div className="rounded-lg bg-sky-50 border border-sky-100 p-3">
                  <div className="text-gray-500 text-xs">{t('team.planLabel')}</div>
                  <div className="font-bold text-gray-800">{plan ? plan.plan_type.toUpperCase() : t('team.noPlan')}</div>
                  {plan && <div className="text-[11px] text-gray-400">{t('team.until')} {new Date(plan.expires_at).toLocaleDateString()}</div>}
                </div>
                <div className="rounded-lg bg-sky-50 border border-sky-100 p-3">
                  <div className="text-gray-500 text-xs">{t('team.todayLabel')}</div>
                  <div className="font-bold text-gray-800">{plan ? `${num(st.used_today)} / ${num(plan.daily_tokens)}` : '—'}</div>
                  {plan && (
                    <div className="h-1.5 bg-white rounded-full mt-1 overflow-hidden"><div className="h-full bg-sky-500" style={{ width: `${pct}%` }} /></div>
                  )}
                </div>
                <div className="rounded-lg bg-sky-50 border border-sky-100 p-3">
                  <div className="text-gray-500 text-xs">{t('team.tokensLabel')}</div>
                  <div className="font-bold text-gray-800">{num(st?.tokens)}</div>
                </div>
              </div>
              <p className="text-xs text-gray-500 mt-3">
                {t('team.myUsage').replace('{used}', num(data.me?.used_today))}
                {data.me?.daily_limit !== null && data.me?.daily_limit !== undefined
                  ? ` · ${t('team.myLimit').replace('{limit}', num(data.me.daily_limit))}` : ''}
              </p>
              <p className="text-[11px] text-gray-400 mt-1">{t('team.howItWorks')}</p>
            </div>

            <div className="bg-white border border-sky-100 shadow-sm rounded-xl p-5">
              <h2 className="font-bold text-gray-800 mb-3">{t('team.membersTitle')}</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-gray-400 text-xs">
                    <th className="py-2">{t('team.colMember')}</th>
                    {isOwner && <th>{t('team.colToday')}</th>}
                    {isOwner && <th>{t('team.col30d')}</th>}
                    {isOwner && <th>{t('team.colLimit')}</th>}
                    {isOwner && <th></th>}
                  </tr></thead>
                  <tbody>
                    {data.members.map((m) => (
                      <tr key={m.id} className="border-t border-sky-50">
                        <td className="py-2">
                          {m.email}{m.role === 'owner' ? ' 👑' : ''}
                        </td>
                        {isOwner && <td className="text-xs">{num(m.used_today)}</td>}
                        {isOwner && <td className="text-xs">{num(m.tokens_30d)} <span className="text-gray-400">({m.messages_30d || 0})</span></td>}
                        {isOwner && (
                          <td>
                            <div className="flex gap-1">
                              <input
                                value={limits[m.id] ?? (m.daily_limit === null || m.daily_limit === undefined ? '' : String(m.daily_limit))}
                                onChange={(e) => setLimits((p) => ({ ...p, [m.id]: e.target.value.replace(/[^0-9]/g, '') }))}
                                placeholder={t('team.noLimit')} inputMode="numeric"
                                className="w-28 border border-sky-200 rounded px-2 py-1 text-xs bg-white" />
                              <button onClick={() => saveLimit(m)} disabled={busy}
                                className="px-2 py-1 rounded text-xs font-bold bg-sky-50 text-sky-700 border border-sky-200 hover:bg-sky-100 disabled:opacity-50">
                                {t('team.save')}
                              </button>
                            </div>
                          </td>
                        )}
                        {isOwner && (
                          <td className="text-right">
                            {m.role !== 'owner' && (
                              <button onClick={() => act(`/api/teams/members/${m.id}`, { method: 'DELETE' }, t('team.memberRemoved'))} disabled={busy}
                                className="px-2 py-1 rounded text-xs font-bold bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 disabled:opacity-50">
                                {t('team.remove')}
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {isOwner && (
                <div className="flex gap-2 mt-4">
                  <input value={email} onChange={(e) => setEmail(e.target.value)} type="email"
                    onKeyDown={(e) => e.key === 'Enter' && addMember()}
                    placeholder={t('team.addPh')}
                    className="flex-1 border border-sky-200 rounded-lg px-3 py-2 text-sm bg-white" />
                  <button onClick={addMember} disabled={busy || !email.trim()}
                    className="bg-sky-600 hover:bg-sky-700 text-white px-4 py-2 rounded-lg text-sm font-bold disabled:opacity-50">
                    ＋ {t('team.addBtn')}
                  </button>
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-2 justify-between">
              {isOwner && data.members.length > 1 && (
                <div className="flex gap-2">
                  <select value={transferId} onChange={(e) => setTransferId(e.target.value)}
                    className="border border-sky-200 rounded-lg px-2 py-2 text-sm bg-white">
                    <option value="">{t('team.transferPh')}</option>
                    {data.members.filter((m) => m.role !== 'owner').map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}
                  </select>
                  <button disabled={busy || !transferId}
                    onClick={() => act('/api/teams/transfer', { method: 'POST', body: JSON.stringify({ user_id: parseInt(transferId, 10) }) }, t('team.transferred'))}
                    className="px-3 py-2 rounded-lg text-sm font-bold bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 disabled:opacity-50">
                    {t('team.transferBtn')}
                  </button>
                </div>
              )}
              <button onClick={() => window.confirm(t('team.confirmLeave')) && act('/api/teams/leave', { method: 'POST' }, t('team.left'))} disabled={busy}
                className="px-3 py-2 rounded-lg text-sm font-bold bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 disabled:opacity-50">
                {t('team.leave')}
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

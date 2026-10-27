import Head from 'next/head';
import { useState, useEffect, useCallback } from 'react';
import { useLanguage } from '../i18n/LanguageContext';
import Navbar from '../components/Navbar';
import { useAuth, apiFetch, ApiError } from '../utils/api';

// v3.39.0 — full admin panel: read views + management actions (tickets,
// role/ban, USD/token adjustments, plan grants, worker remove/restore).
// Every mutation lands in admin_audit_log server-side; the UI just refetches.

const TABS = [
  { id: 'dashboard', icon: '📈', key: 'admin.tabDashboard' },
  { id: 'users', icon: '👥', key: 'admin.tabUsers' },
  { id: 'workers', icon: '🖥️', key: 'admin.tabWorkers' },
  { id: 'tasks', icon: '🧩', key: 'admin.tabTasks' },
  { id: 'tickets', icon: '🎫', key: 'admin.tabTickets' },
  { id: 'payments', icon: '💰', key: 'admin.tabPayments' },
  { id: 'purchases', icon: '🛒', key: 'admin.tabPurchases' },
  { id: 'orgs', icon: '🏢', key: 'admin.tabOrgs' },
];

const TICKET_FILTERS = ['all', 'open', 'answered', 'closed'];

export default function Admin() {
  const { t } = useLanguage();
  const [dashboard, setDashboard] = useState(null);
  const [users, setUsers] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [tickets, setTickets] = useState([]);
  const [payments, setPayments] = useState(null);
  const [purchases, setPurchases] = useState([]);
  const [tab, setTab] = useState('dashboard');
  // v3.44.0 — orgs: create + member management (audited server-side).
  const [orgs, setOrgs] = useState([]);
  const [orgName, setOrgName] = useState('');
  const [orgLeader, setOrgLeader] = useState('');
  const [orgAddEmail, setOrgAddEmail] = useState({}); // orgId -> email draft

  // Tickets thread
  const [ticketQuery, setTicketQuery] = useState('');
  const [ticketFilter, setTicketFilter] = useState('all');
  const [thread, setThread] = useState(null); // { ticket, messages }
  const [replyBody, setReplyBody] = useState('');

  // User action drawer
  const [actionUser, setActionUser] = useState(null);
  const [roleSel, setRoleSel] = useState('user');
  const [deltaUsd, setDeltaUsd] = useState('');
  const [deltaTokens, setDeltaTokens] = useState('');
  const [reason, setReason] = useState('');
  const [planSel, setPlanSel] = useState('plus');
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState(''); // { ok, text }

  const { ready, user } = useAuth();
  const isAdmin = !!user && user.role === 'admin';
  const [denied, setDenied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const handle = (err) => {
    if (err && err.status === 403) setDenied(true);
    else setLoadError(true);
  };

  const wrap = async (fn) => {
    setLoading(true);
    setLoadError(false);
    try { await fn(); } catch (err) { handle(err); }
    setLoading(false);
  };

  const fetchDashboard = () => wrap(async () => {
    const data = await apiFetch('/api/admin/dashboard');
    if (data.success) setDashboard(data.dashboard);
  });
  const fetchUsers = () => wrap(async () => {
    const data = await apiFetch('/api/admin/users');
    if (data.success) setUsers(data.users);
  });
  const fetchWorkers = () => wrap(async () => {
    const data = await apiFetch('/api/admin/workers');
    if (data.success) setWorkers(data.workers);
  });
  const fetchTasks = () => wrap(async () => {
    const data = await apiFetch('/api/admin/tasks');
    if (data.success) setTasks(data.tasks);
  });
  const fetchTickets = useCallback(async (status, q) => {
    const params = new URLSearchParams();
    if (status && status !== 'all') params.set('status', status);
    if (q) params.set('q', q);
    const qs = params.toString();
    const data = await apiFetch(`/api/admin/tickets${qs ? `?${qs}` : ''}`);
    if (data.success) setTickets(data.tickets);
  }, []);
  const fetchPayments = () => wrap(async () => {
    const data = await apiFetch('/api/admin/payments');
    if (data.success) setPayments({ deposits: data.deposits, withdrawals: data.withdrawals });
  });
  const fetchPurchases = () => wrap(async () => {
    const data = await apiFetch('/api/admin/purchases');
    if (data.success) setPurchases(data.purchases);
  });
  const fetchOrgs = () => wrap(async () => {
    const data = await apiFetch('/api/admin/orgs');
    if (data.success) setOrgs(data.orgs);
  });
  const orgAct = async (path, opts, okKey) => {
    setActionBusy(true);
    setActionMsg('');
    try {
      const data = await apiFetch(path, opts);
      if (data.success) {
        setActionMsg({ ok: true, text: t(okKey) });
        await fetchOrgs();
      } else setActionMsg({ ok: false, text: data.error || t('common.loadFailed') });
    } catch (err) {
      setActionMsg({ ok: false, text: err instanceof ApiError ? err.message : t('common.loadFailed') });
    }
    setActionBusy(false);
  };
  const createOrg = () => {
    if (!orgName.trim() || !orgLeader.trim()) return;
    orgAct('/api/admin/orgs', {
      method: 'POST',
      body: JSON.stringify({ name: orgName.trim(), leader_email: orgLeader.trim() }),
    }, 'admin.orgCreated').then(() => { setOrgName(''); setOrgLeader(''); });
  };

  useEffect(() => { if (isAdmin) fetchDashboard(); }, [isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchTab = (tb) => {
    if (!isAdmin) return;
    setTab(tb);
    setThread(null);
    setActionUser(null);
    setActionMsg('');
    if (tb === 'users') fetchUsers();
    else if (tb === 'workers') fetchWorkers();
    else if (tb === 'tasks') fetchTasks();
    else if (tb === 'tickets') wrap(() => fetchTickets(ticketFilter, ticketQuery));
    else if (tb === 'payments') fetchPayments();
    else if (tb === 'purchases') fetchPurchases();
    else if (tb === 'orgs') fetchOrgs();
    else fetchDashboard();
  };

  // ---- Tickets ----
  const searchTickets = () => wrap(() => fetchTickets(ticketFilter, ticketQuery));
  const openThread = async (tk) => {
    setLoadError(false);
    try {
      const data = await apiFetch(`/api/admin/tickets/${tk.id}`);
      if (data.success) { setThread(data); setReplyBody(''); }
    } catch (err) { handle(err); }
  };
  const sendReply = async () => {
    if (!thread || !replyBody.trim()) return;
    setActionBusy(true);
    setActionMsg('');
    try {
      const data = await apiFetch(`/api/admin/tickets/${thread.ticket.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body: replyBody.trim() }),
      });
      if (data.success) {
        setThread({ ticket: data.ticket, messages: [...thread.messages, data.message] });
        setReplyBody('');
        wrap(() => fetchTickets(ticketFilter, ticketQuery));
      } else setActionMsg({ ok: false, text: data.error });
    } catch (err) {
      setActionMsg({ ok: false, text: err instanceof ApiError ? err.message : t('common.loadFailed') });
    }
    setActionBusy(false);
  };
  const setTicketStatus = async (status) => {
    if (!thread) return;
    setActionBusy(true);
    setActionMsg('');
    try {
      const data = await apiFetch(`/api/admin/tickets/${thread.ticket.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      });
      if (data.success) {
        setThread({ ...thread, ticket: data.ticket });
        wrap(() => fetchTickets(ticketFilter, ticketQuery));
      } else setActionMsg({ ok: false, text: data.error });
    } catch (err) {
      setActionMsg({ ok: false, text: err instanceof ApiError ? err.message : t('common.loadFailed') });
    }
    setActionBusy(false);
  };

  // ---- User actions ----
  const openActions = (u) => {
    setActionUser(u);
    setRoleSel(u.role);
    setPlanSel('plus');
    setDeltaUsd('');
    setDeltaTokens('');
    setReason('');
    setActionMsg('');
  };

  const callAction = async (path, opts, successKey) => {
    setActionBusy(true);
    setActionMsg('');
    try {
      const data = await apiFetch(path, opts);
      if (data.success) {
        setActionMsg({ ok: true, text: t(successKey) });
        await fetchUsers();
        setActionUser((prev) => {
          if (!prev) return prev;
          return null; // close drawer — list refreshed with new values
        });
      } else {
        setActionMsg({ ok: false, text: data.error || t('common.loadFailed') });
      }
    } catch (err) {
      setActionMsg({ ok: false, text: err instanceof ApiError ? err.message : t('common.loadFailed') });
    }
    setActionBusy(false);
  };

  const applyRole = () => callAction(
    `/api/admin/users/${actionUser.id}/role`,
    { method: 'PUT', body: JSON.stringify({ role: roleSel }) },
    'admin.saved'
  );
  const applyBan = (banned) => {
    const confirmMsg = banned ? t('admin.confirmBan') : t('admin.confirmUnban');
    if (!window.confirm(confirmMsg)) return;
    callAction(
      `/api/admin/users/${actionUser.id}/ban`,
      { method: 'PUT', body: JSON.stringify({ banned }) },
      'admin.saved'
    );
  };
  const applyBalance = () => {
    const delta = parseFloat(deltaUsd);
    if (!Number.isFinite(delta) || delta === 0 || reason.trim().length < 3) {
      setActionMsg({ ok: false, text: t('admin.checkFields') });
      return;
    }
    callAction(
      `/api/admin/users/${actionUser.id}/balance`,
      { method: 'POST', body: JSON.stringify({ delta_usd: delta, reason: reason.trim() }) },
      'admin.saved'
    );
  };
  const applyTokens = () => {
    const delta = parseInt(deltaTokens, 10);
    if (!Number.isInteger(delta) || delta === 0 || reason.trim().length < 3) {
      setActionMsg({ ok: false, text: t('admin.checkFields') });
      return;
    }
    callAction(
      `/api/admin/users/${actionUser.id}/tokens`,
      { method: 'POST', body: JSON.stringify({ delta_tokens: delta, reason: reason.trim() }) },
      'admin.saved'
    );
  };
  const applyPlan = () => callAction(
    `/api/admin/users/${actionUser.id}/plan`,
    { method: 'PUT', body: JSON.stringify({ plan: planSel }) },
    'admin.saved'
  );

  // ---- Worker actions ----
  const setWorkerStatus = async (m, status) => {
    const confirmMsg = status === 'removed' ? t('admin.confirmRemoveWorker') : t('admin.confirmRestoreWorker');
    if (!window.confirm(confirmMsg)) return;
    try {
      const data = await apiFetch(`/api/admin/workers/${m.id}/status`, {
        method: 'PUT',
        body: JSON.stringify({ status }),
      });
      if (data.success) await fetchWorkers();
    } catch (err) { handle(err); }
  };

  const roleLabel = (r) => (r === 'admin' ? t('admin.roleAdmin') : r === 'worker' ? t('admin.roleWorker') : t('admin.roleUser'));
  const statusBadge = (status) => {
    const cls = status === 'open'
      ? 'bg-amber-100 text-amber-700'
      : status === 'answered'
        ? 'bg-emerald-100 text-emerald-700'
        : 'bg-gray-100 text-gray-500';
    const label = status === 'open'
      ? t('support.statusOpen')
      : status === 'answered'
        ? t('support.statusAnswered')
        : t('support.statusClosed');
    return <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${cls}`}>{label}</span>;
  };

  return (
    <div className="flex-1 page-surface min-h-screen">
      <Head><title>{t('admin.pageTitle')} - Plankton Network</title></Head>
      <Navbar />

      <main className="container mx-auto px-4 md:px-6 py-6 max-w-5xl">
        <h1 className="text-2xl font-bold text-gray-800 mb-4">🛡️ {t('admin.pageTitle')}</h1>

        <div className="flex gap-2 mb-6 overflow-x-auto pb-2">
          {TABS.map((tb) => (
            <button key={tb.id} onClick={() => switchTab(tb.id)}
              className={`px-4 py-2 min-h-[40px] rounded-lg text-sm font-bold whitespace-nowrap ${tab === tb.id ? 'bg-sky-500 text-white' : 'bg-white text-gray-600 border border-sky-200 hover:bg-sky-50'}`}>
              {t(tb.key)}
            </button>
          ))}
        </div>

        {!isAdmin && ready && (
          <div className="bg-white border border-red-100 shadow-sm rounded-xl p-8 text-center">
            <p className="text-gray-800 font-bold">{t('admin.accessDenied')}</p>
            <p className="text-gray-500 text-sm mt-2">{t('admin.accessDeniedDesc')}</p>
          </div>
        )}

        {denied && isAdmin && (
          <div className="bg-red-50 border border-red-100 rounded-xl p-4 text-sm text-red-600 mb-4">
            {t('admin.noPermission')}
          </div>
        )}

        {actionMsg && (
          <div className={`mb-4 rounded-xl px-4 py-3 text-sm border ${actionMsg.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-600'}`}>
            {actionMsg.text}
          </div>
        )}

        {isAdmin && loading && (
          <p className="text-gray-500 text-center py-10">{t('common.loading')}</p>
        )}

        {isAdmin && !loading && loadError && (
          <div className="bg-red-50 border border-red-200 text-red-600 text-sm rounded-xl px-4 py-3 flex items-center justify-between gap-3">
            <span>{t('common.loadFailed')}</span>
            <button onClick={() => switchTab(tab)} className="font-bold underline min-h-[36px]">{t('common.retry')}</button>
          </div>
        )}

        {isAdmin && !loading && !loadError && tab === 'dashboard' && dashboard && (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <div className="bg-white border border-sky-100 shadow-sm rounded-xl p-4 text-center">
              <div className="text-2xl font-bold text-emerald-600">{dashboard.workers.online}</div>
              <div className="text-gray-500 text-sm">{t('admin.onlineWorkers')}</div>
            </div>
            <div className="bg-white border border-sky-100 shadow-sm rounded-xl p-4 text-center">
              <div className="text-2xl font-bold text-gray-800">{dashboard.workers.total}</div>
              <div className="text-gray-500 text-sm">{t('admin.totalWorkers')}</div>
            </div>
            <div className="bg-white border border-sky-100 shadow-sm rounded-xl p-4 text-center">
              <div className="text-2xl font-bold text-sky-600">{dashboard.users}</div>
              <div className="text-gray-500 text-sm">{t('admin.usersLabel')}</div>
            </div>
            <div className="bg-white border border-sky-100 shadow-sm rounded-xl p-4 text-center">
              <div className="text-2xl font-bold text-violet-600">{dashboard.tickets?.total ?? 0}</div>
              <div className="text-gray-500 text-sm">{t('admin.totalTickets')}</div>
            </div>
            <div className="bg-white border border-sky-100 shadow-sm rounded-xl p-4 text-center">
              <div className="text-2xl font-bold text-amber-600">{dashboard.tickets?.open ?? 0}</div>
              <div className="text-gray-500 text-sm">{t('admin.openTickets')}</div>
            </div>
            <div className="bg-white border border-sky-100 shadow-sm rounded-xl p-4 text-center">
              <div className="text-2xl font-bold text-amber-500">{Number(dashboard.revenue || 0).toFixed(2)}</div>
              <div className="text-gray-500 text-sm">{t('admin.platformFees')}</div>
            </div>
          </div>
        )}

        {isAdmin && !loading && !loadError && tab === 'users' && (
          <>
            {actionUser && (
              <div className="bg-white border border-violet-200 shadow-sm rounded-xl p-4 md:p-5 mb-4">
                <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
                  <div className="min-w-0">
                    <div className="font-bold text-gray-800 truncate">#{actionUser.id} · {actionUser.email}</div>
                    <div className="text-xs text-gray-400">
                      {t('admin.balanceLabel')}: ${parseFloat(actionUser.usd_balance || 0).toFixed(2)}
                      {' · '}{t('admin.tokensLabel')}: {Number(actionUser.token_balance || 0).toLocaleString('en-US')}
                      {actionUser.active_plan ? ` · ${actionUser.active_plan}` : ''}
                    </div>
                  </div>
                  <button onClick={() => setActionUser(null)} className="text-gray-400 hover:text-gray-600 text-xl px-2 min-h-[36px]">✕</button>
                </div>

                <div className="grid md:grid-cols-2 gap-4">
                  <div className="bg-sky-50 border border-sky-100 rounded-xl p-3">
                    <div className="text-sm font-bold text-gray-700 mb-2">{t('admin.setRole')}</div>
                    <div className="flex gap-2">
                      <select value={roleSel} onChange={(e) => setRoleSel(e.target.value)}
                        className="flex-1 border border-sky-200 rounded-lg px-2 py-2 text-sm bg-white">
                        <option value="user">{t('admin.roleUser')}</option>
                        <option value="worker">{t('admin.roleWorker')}</option>
                        <option value="admin">{t('admin.roleAdmin')}</option>
                      </select>
                      <button onClick={applyRole} disabled={actionBusy}
                        className="bg-sky-600 hover:bg-sky-700 text-white px-3 py-2 rounded-lg text-sm font-bold disabled:opacity-50">
                        {t('admin.apply')}
                      </button>
                    </div>
                    <button onClick={() => applyBan(!actionUser.banned)} disabled={actionBusy}
                      className={`mt-2 w-full px-3 py-2 rounded-lg text-sm font-bold disabled:opacity-50 ${actionUser.banned ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-red-50 text-red-600 border border-red-200'}`}>
                      {actionUser.banned ? `🔓 ${t('admin.unbanUser')}` : `🚫 ${t('admin.banUser')}`}
                    </button>
                  </div>

                  <div className="bg-sky-50 border border-sky-100 rounded-xl p-3">
                    <div className="text-sm font-bold text-gray-700 mb-2">{t('admin.grantPlan')}</div>
                    <div className="flex gap-2">
                      <select value={planSel} onChange={(e) => setPlanSel(e.target.value)}
                        className="flex-1 border border-sky-200 rounded-lg px-2 py-2 text-sm bg-white">
                        <option value="plus">Plus</option>
                        <option value="pro">Pro</option>
                        <option value="max">Max</option>
                      </select>
                      <button onClick={applyPlan} disabled={actionBusy}
                        className="bg-violet-600 hover:bg-violet-700 text-white px-3 py-2 rounded-lg text-sm font-bold disabled:opacity-50">
                        {t('admin.grant')}
                      </button>
                    </div>
                    <p className="text-[10px] text-gray-400 mt-1">{t('admin.grantHint')}</p>
                  </div>

                  <div className="bg-sky-50 border border-sky-100 rounded-xl p-3">
                    <div className="text-sm font-bold text-gray-700 mb-2">{t('admin.adjustBalance')}</div>
                    <div className="flex gap-2 mb-2">
                      <input value={deltaUsd} onChange={(e) => setDeltaUsd(e.target.value)}
                        placeholder={t('admin.deltaUsd')} inputMode="decimal"
                        className="w-24 border border-sky-200 rounded-lg px-2 py-2 text-sm text-center bg-white" />
                      <input value={reason} onChange={(e) => setReason(e.target.value)}
                        placeholder={t('admin.reason')} maxLength={500}
                        className="flex-1 border border-sky-200 rounded-lg px-2 py-2 text-sm bg-white" />
                    </div>
                    <button onClick={applyBalance} disabled={actionBusy}
                      className="w-full bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-2 rounded-lg text-sm font-bold disabled:opacity-50">
                      {t('admin.apply')}
                    </button>
                  </div>

                  <div className="bg-sky-50 border border-sky-100 rounded-xl p-3">
                    <div className="text-sm font-bold text-gray-700 mb-2">{t('admin.adjustTokens')}</div>
                    <div className="flex gap-2 mb-2">
                      <input value={deltaTokens} onChange={(e) => setDeltaTokens(e.target.value.replace(/[^0-9-]/g, ''))}
                        placeholder={t('admin.deltaTokens')} inputMode="numeric"
                        className="w-28 border border-sky-200 rounded-lg px-2 py-2 text-sm text-center bg-white" />
                      <input value={reason} onChange={(e) => setReason(e.target.value)}
                        placeholder={t('admin.reason')} maxLength={500}
                        className="flex-1 border border-sky-200 rounded-lg px-2 py-2 text-sm bg-white" />
                    </div>
                    <button onClick={applyTokens} disabled={actionBusy}
                      className="w-full bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-2 rounded-lg text-sm font-bold disabled:opacity-50">
                      {t('admin.apply')}
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="bg-white border border-sky-100 shadow-sm rounded-xl overflow-x-auto">
              <table className="w-full text-gray-700 text-sm">
                <thead><tr className="border-b border-sky-100 bg-sky-50">
                  <th className="px-4 py-3 text-left">{t('admin.colId')}</th>
                  <th className="px-4 py-3 text-left">{t('admin.colEmail')}</th>
                  <th className="px-4 py-3 text-left">{t('admin.colRole')}</th>
                  <th className="px-4 py-3 text-left">{t('admin.balanceLabel')}</th>
                  <th className="px-4 py-3 text-left">{t('admin.tokensLabel')}</th>
                  <th className="px-4 py-3 text-left">{t('admin.colPlan')}</th>
                  <th className="px-4 py-3 text-left">{t('admin.colJoined')}</th>
                  <th className="px-4 py-3 text-left"></th>
                </tr></thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} className={`border-b border-sky-50 hover:bg-sky-50/50 ${actionUser?.id === u.id ? 'bg-violet-50/60' : ''}`}>
                      <td className="px-4 py-2">#{u.id}</td>
                      <td className="px-4 py-2">
                        {u.email}
                        {u.banned && <span className="ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-600">{t('admin.bannedBadge')}</span>}
                      </td>
                      <td className="px-4 py-2"><span className={`px-2 py-0.5 rounded text-xs ${u.role === 'admin' ? 'bg-red-100 text-red-600' : 'bg-sky-100 text-sky-700'}`}>{roleLabel(u.role)}</span></td>
                      <td className="px-4 py-2">${parseFloat(u.usd_balance || 0).toFixed(2)}</td>
                      <td className="px-4 py-2">{Number(u.token_balance || 0).toLocaleString('en-US')}</td>
                      <td className="px-4 py-2 text-xs">{u.active_plan || t('admin.planFree')}</td>
                      <td className="px-4 py-2 text-xs text-gray-400">{new Date(u.created_at).toLocaleDateString()}</td>
                      <td className="px-4 py-2">
                        <button onClick={() => openActions(u)}
                          className="px-3 py-1.5 rounded-lg text-xs font-bold bg-violet-50 text-violet-700 border border-violet-200 hover:bg-violet-100">
                          {t('admin.manage')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {isAdmin && !loading && !loadError && tab === 'workers' && (
          <div className="grid md:grid-cols-2 gap-4">
            {workers.length === 0 && <p className="text-gray-400 text-center col-span-2 py-10">{t('admin.noWorkers')}</p>}
            {workers.map((m) => (
              <div key={m.id} className="bg-white border border-sky-100 shadow-sm rounded-xl p-4">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-gray-800 font-bold">Worker #{m.id} <span className="text-xs font-normal text-gray-400">{m.email || ''}</span></span>
                  <span className={`px-2 py-0.5 rounded text-xs ${m.status === 'online' ? 'bg-emerald-100 text-emerald-700' : m.status === 'removed' ? 'bg-gray-200 text-gray-500' : 'bg-red-100 text-red-600'}`}>{m.status}</span>
                </div>
                <div className="text-gray-600 text-xs space-y-1 mb-3">
                  <p>{t('admin.gpuLabel')}: {m.gpu_model || 'Unknown'}</p>
                  <p>{t('admin.tasksLabel')}: {m.total_tasks} | {t('admin.earnedLabel')}: {Number(m.earnings || 0).toFixed(2)}</p>
                  <p className="font-mono text-gray-400">{m.wallet_address?.slice(0, 16)}...</p>
                </div>
                <div className="flex gap-2">
                  {m.status === 'removed' ? (
                    <button onClick={() => setWorkerStatus(m, 'offline')}
                      className="px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100">
                      {t('admin.restoreWorker')}
                    </button>
                  ) : (
                    <button onClick={() => setWorkerStatus(m, 'removed')}
                      className="px-3 py-1.5 rounded-lg text-xs font-bold bg-red-50 text-red-600 border border-red-200 hover:bg-red-100">
                      {t('admin.removeWorker')}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {isAdmin && !loading && !loadError && tab === 'tasks' && (
          <div className="bg-white border border-sky-100 shadow-sm rounded-xl overflow-x-auto">
            <table className="w-full text-gray-700 text-sm">
              <thead><tr className="border-b border-sky-100 bg-sky-50">
                <th className="px-4 py-3 text-left">{t('admin.colId')}</th>
                <th className="px-4 py-3 text-left">{t('admin.colUser')}</th>
                <th className="px-4 py-3 text-left">{t('admin.colModel')}</th>
                <th className="px-4 py-3 text-left">{t('admin.colStatus')}</th>
                <th className="px-4 py-3 text-left">{t('admin.colCost')}</th>
                <th className="px-4 py-3 text-left">{t('admin.colTime')}</th>
              </tr></thead>
              <tbody>
                {tasks.map((tk) => (
                  <tr key={tk.id} className="border-b border-sky-50 hover:bg-sky-50/50">
                    <td className="px-4 py-2">#{tk.id}</td>
                    <td className="px-4 py-2">{tk.user_email || '--'}</td>
                    <td className="px-4 py-2 text-xs">{tk.model}</td>
                    <td className="px-4 py-2"><span className={`px-2 py-0.5 rounded text-xs ${tk.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : tk.status === 'failed' ? 'bg-red-100 text-red-600' : 'bg-amber-100 text-amber-700'}`}>{tk.status}</span></td>
                    <td className="px-4 py-2">{Number(tk.cost || 0).toFixed(4)}</td>
                    <td className="px-4 py-2 text-xs text-gray-400">{tk.created_at ? new Date(tk.created_at).toLocaleDateString() : '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {isAdmin && !loading && !loadError && tab === 'tickets' && (
          thread ? (
            <div className="bg-white border border-sky-100 shadow-sm rounded-xl p-4 md:p-5">
              <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
                <button onClick={() => setThread(null)}
                  className="text-sm font-semibold text-sky-600 hover:text-sky-700 transition">← {t('support.backToList')}</button>
                {statusBadge(thread.ticket.status)}
              </div>
              <h2 className="text-lg font-bold text-gray-800">#{thread.ticket.id} · {thread.ticket.subject}</h2>
              <p className="text-xs text-gray-400 mb-4">
                {thread.ticket.email} · {t(`support.cat_${thread.ticket.category}`)} · {new Date(thread.ticket.created_at).toLocaleString()}
              </p>

              <div className="flex flex-col gap-3 mb-4 max-h-[380px] overflow-y-auto pr-1">
                {(thread.messages || []).map((m) => (
                  <div key={m.id}
                    className={`max-w-[85%] rounded-xl px-3.5 py-2.5 text-sm ${m.is_admin ? 'bg-violet-50 border border-violet-100 self-start' : 'bg-sky-50 border border-sky-100 self-end'}`}>
                    <div className={`text-[10px] font-bold mb-1 ${m.is_admin ? 'text-violet-600' : 'text-sky-600'}`}>
                      {m.is_admin ? t('support.adminReply') : (thread.ticket.email || t('support.you'))}
                      {' · '}<span className="font-normal text-gray-400">{new Date(m.created_at).toLocaleString()}</span>
                    </div>
                    <div className="text-gray-700 whitespace-pre-wrap break-words">{m.body}</div>
                  </div>
                ))}
              </div>

              <div className="border-t border-gray-100 pt-4 flex flex-col gap-3">
                <textarea value={replyBody} onChange={(e) => setReplyBody(e.target.value)}
                  maxLength={4000} rows={3} placeholder={t('support.replyPlaceholder')}
                  className="border border-sky-200 rounded-xl px-3 py-2.5 text-sm resize-y" />
                <div className="flex gap-2 flex-wrap">
                  <button onClick={sendReply} disabled={actionBusy || !replyBody.trim()}
                    className="bg-violet-600 hover:bg-violet-700 text-white px-5 py-2.5 rounded-xl transition text-sm font-bold disabled:opacity-50">
                    {actionBusy ? '...' : `💬 ${t('support.send')}`}
                  </button>
                  {thread.ticket.status === 'closed' ? (
                    <button onClick={() => setTicketStatus('open')} disabled={actionBusy}
                      className="bg-white border border-emerald-200 text-emerald-600 hover:bg-emerald-50 px-5 py-2.5 rounded-xl transition text-sm font-bold disabled:opacity-50">
                      ↻ {t('admin.reopenTicket')}
                    </button>
                  ) : (
                    <button onClick={() => setTicketStatus('closed')} disabled={actionBusy}
                      className="bg-white border border-red-200 text-red-500 hover:bg-red-50 px-5 py-2.5 rounded-xl transition text-sm font-bold disabled:opacity-50">
                      ✓ {t('support.close')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div>
              <div className="flex gap-2 mb-4 flex-wrap">
                <input value={ticketQuery} onChange={(e) => setTicketQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && searchTickets()}
                  placeholder={t('admin.ticketSearch')}
                  className="flex-1 min-w-[180px] border border-sky-200 rounded-xl px-3 py-2.5 text-sm bg-white" />
                <select value={ticketFilter} onChange={(e) => { setTicketFilter(e.target.value); }}
                  className="border border-sky-200 rounded-xl px-3 py-2.5 text-sm bg-white">
                  {TICKET_FILTERS.map((f) => (
                    <option key={f} value={f}>
                      {f === 'all' ? t('admin.ticketFilterAll') : f === 'open' ? t('support.statusOpen') : f === 'answered' ? t('support.statusAnswered') : t('support.statusClosed')}
                    </option>
                  ))}
                </select>
                <button onClick={searchTickets}
                  className="bg-sky-500 hover:bg-sky-600 text-white px-4 py-2.5 rounded-xl text-sm font-bold transition">
                  🔍 {t('admin.search')}
                </button>
              </div>

              {tickets.length === 0 ? (
                <p className="text-gray-400 text-center py-10">{t('admin.noTickets')}</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {tickets.map((tk) => (
                    <button key={tk.id} onClick={() => openThread(tk)}
                      className="bg-white rounded-xl border border-sky-100 shadow-sm p-4 text-left hover:border-sky-300 transition">
                      <div className="flex items-center justify-between gap-3 mb-1">
                        <span className="text-sm font-bold text-gray-800 truncate">#{tk.id} · {tk.subject}</span>
                        <span className="flex items-center gap-2 flex-shrink-0">
                          {statusBadge(tk.status)}
                          <span className="text-xs text-gray-400">{tk.email}</span>
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3 text-xs text-gray-400">
                        <span className="truncate">{tk.last_message || ''}</span>
                        <span className="flex-shrink-0">{new Date(tk.updated_at).toLocaleString()}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        )}

        {isAdmin && !loading && !loadError && tab === 'payments' && (
          payments && (
            <div className="flex flex-col gap-6">
              <div className="bg-white border border-sky-100 shadow-sm rounded-xl overflow-x-auto">
                <div className="px-4 py-3 font-bold text-gray-800 border-b border-sky-100 bg-sky-50">⬇️ {t('admin.deposits')}</div>
                {payments.deposits.length === 0 ? (
                  <p className="text-gray-400 text-center py-8">{t('admin.noPayments')}</p>
                ) : (
                  <table className="w-full text-gray-700 text-sm">
                    <thead><tr className="border-b border-sky-100">
                      <th className="px-4 py-2 text-left">{t('admin.colId')}</th>
                      <th className="px-4 py-2 text-left">{t('admin.colUser')}</th>
                      <th className="px-4 py-2 text-left">{t('admin.colAmount')}</th>
                      <th className="px-4 py-2 text-left">{t('admin.colCoin')}</th>
                      <th className="px-4 py-2 text-left">{t('admin.colStatus')}</th>
                      <th className="px-4 py-2 text-left">{t('admin.colTime')}</th>
                    </tr></thead>
                    <tbody>
                      {payments.deposits.map((d) => (
                        <tr key={`d${d.id}`} className="border-b border-sky-50">
                          <td className="px-4 py-2">#{d.id}</td>
                          <td className="px-4 py-2 text-xs">{d.email || '--'}</td>
                          <td className="px-4 py-2">{Number(d.amount || 0)}</td>
                          <td className="px-4 py-2 text-xs uppercase">{d.coin}</td>
                          <td className="px-4 py-2"><span className={`px-2 py-0.5 rounded text-xs ${d.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : d.status === 'failed' ? 'bg-red-100 text-red-600' : 'bg-amber-100 text-amber-700'}`}>{d.status}</span></td>
                          <td className="px-4 py-2 text-xs text-gray-400">{d.created_at ? new Date(d.created_at).toLocaleString() : '--'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="bg-white border border-sky-100 shadow-sm rounded-xl overflow-x-auto">
                <div className="px-4 py-3 font-bold text-gray-800 border-b border-sky-100 bg-sky-50">⬆️ {t('admin.withdrawals')}</div>
                {payments.withdrawals.length === 0 ? (
                  <p className="text-gray-400 text-center py-8">{t('admin.noPayments')}</p>
                ) : (
                  <table className="w-full text-gray-700 text-sm">
                    <thead><tr className="border-b border-sky-100">
                      <th className="px-4 py-2 text-left">{t('admin.colId')}</th>
                      <th className="px-4 py-2 text-left">{t('admin.colUser')}</th>
                      <th className="px-4 py-2 text-left">{t('admin.colAmount')}</th>
                      <th className="px-4 py-2 text-left">{t('admin.colCoin')}</th>
                      <th className="px-4 py-2 text-left">{t('admin.colStatus')}</th>
                      <th className="px-4 py-2 text-left">{t('admin.colTime')}</th>
                    </tr></thead>
                    <tbody>
                      {payments.withdrawals.map((w) => (
                        <tr key={`w${w.id}`} className="border-b border-sky-50">
                          <td className="px-4 py-2">#{w.id}</td>
                          <td className="px-4 py-2 text-xs">{w.email || '--'}</td>
                          <td className="px-4 py-2">{Number(w.amount || 0)}</td>
                          <td className="px-4 py-2 text-xs uppercase">{w.coin}</td>
                          <td className="px-4 py-2"><span className={`px-2 py-0.5 rounded text-xs ${w.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : w.status === 'failed' ? 'bg-red-100 text-red-600' : 'bg-amber-100 text-amber-700'}`}>{w.status}</span></td>
                          <td className="px-4 py-2 text-xs text-gray-400">{w.created_at ? new Date(w.created_at).toLocaleString() : '--'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )
        )}

        {isAdmin && !loading && !loadError && tab === 'orgs' && (
          <div className="space-y-4">
            <div className="bg-white border border-sky-100 shadow-sm rounded-xl p-4 md:p-5">
              <h3 className="text-gray-800 font-bold text-sm md:text-base mb-3">＋ {t('admin.orgCreateTitle')}</h3>
              <div className="flex flex-col sm:flex-row gap-2">
                <input value={orgName} onChange={(e) => setOrgName(e.target.value)} maxLength={100}
                  placeholder={t('admin.orgNamePh')}
                  className="flex-1 bg-white text-gray-800 placeholder-gray-400 border border-sky-200 px-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-sky-400 min-h-[40px]" />
                <input value={orgLeader} onChange={(e) => setOrgLeader(e.target.value)}
                  placeholder={t('admin.orgLeaderPh')} type="email"
                  className="flex-1 bg-white text-gray-800 placeholder-gray-400 border border-sky-200 px-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-sky-400 min-h-[40px]" />
                <button onClick={createOrg} disabled={actionBusy || !orgName.trim() || !orgLeader.trim()}
                  className="bg-emerald-500 hover:bg-emerald-600 text-white px-4 py-2 rounded-lg transition text-sm font-bold disabled:opacity-50 min-h-[40px]">
                  {t('admin.orgCreateBtn')}
                </button>
              </div>
            </div>
            {orgs.length === 0 ? (
              <p className="text-gray-400 text-center py-10">{t('admin.noOrgs')}</p>
            ) : orgs.map((o) => (
              <div key={o.id} className="bg-white border border-sky-100 shadow-sm rounded-xl p-4 md:p-5">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="min-w-0">
                    <span className="text-gray-800 font-bold text-sm md:text-base">🏢 {o.name}</span>
                    <span className="text-gray-400 text-xs ml-2">#{o.id} · {t('admin.orgLeader')}: {o.leader_email || `#${o.leader_user_id}`}</span>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className={`text-xs font-bold px-2 py-1 rounded-full ${o.status === 'active' ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-gray-400'}`}>{o.status}</span>
                    {o.status === 'active' && (
                      <button onClick={() => orgAct(`/api/admin/orgs/${o.id}/disband`, { method: 'POST' }, 'admin.orgDisbanded')}
                        disabled={actionBusy}
                        className="text-red-400 hover:text-red-600 text-xs font-bold transition disabled:opacity-50">
                        {t('admin.orgDisband')}
                      </button>
                    )}
                  </div>
                </div>
                <div className="space-y-1 mb-3">
                  {(o.members || []).map((m) => (
                    <div key={m.user_id} className="flex items-center justify-between gap-2 text-sm bg-sky-50/50 rounded-lg px-3 py-1.5">
                      <span className="text-gray-700 truncate">{m.email} {m.role === 'leader' && <span className="text-amber-600 font-bold">👑</span>}</span>
                      {o.status === 'active' && m.role !== 'leader' && (
                        <button onClick={() => orgAct(`/api/admin/orgs/${o.id}/members/${m.user_id}`, { method: 'DELETE' }, 'admin.orgMemberRemoved')}
                          disabled={actionBusy}
                          className="text-red-400 hover:text-red-600 text-xs font-bold transition disabled:opacity-50">
                          {t('admin.orgRemove')}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {o.status === 'active' && (
                  <div className="flex gap-2">
                    <input value={orgAddEmail[o.id] || ''} onChange={(e) => setOrgAddEmail((prev) => ({ ...prev, [o.id]: e.target.value }))}
                      placeholder={t('admin.orgAddPh')} type="email"
                      className="flex-1 bg-white text-gray-800 placeholder-gray-400 border border-sky-200 px-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-sky-400 min-h-[40px]" />
                    <button onClick={() => {
                      const email = (orgAddEmail[o.id] || '').trim();
                      if (!email) return;
                      orgAct(`/api/admin/orgs/${o.id}/members`, { method: 'POST', body: JSON.stringify({ email }) }, 'admin.orgMemberAdded')
                        .then(() => setOrgAddEmail((prev) => ({ ...prev, [o.id]: '' })));
                    }} disabled={actionBusy}
                      className="bg-sky-500 hover:bg-sky-600 text-white px-4 py-2 rounded-lg transition text-sm font-bold disabled:opacity-50 min-h-[40px]">
                      ＋ {t('admin.orgAddBtn')}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {isAdmin && !loading && !loadError && tab === 'purchases' && (
          <div className="bg-white border border-sky-100 shadow-sm rounded-xl overflow-x-auto">
            {purchases.length === 0 ? (
              <p className="text-gray-400 text-center py-10">{t('admin.noPurchases')}</p>
            ) : (
              <table className="w-full text-gray-700 text-sm">
                <thead><tr className="border-b border-sky-100 bg-sky-50">
                  <th className="px-4 py-3 text-left">{t('admin.colOrder')}</th>
                  <th className="px-4 py-3 text-left">{t('admin.colUser')}</th>
                  <th className="px-4 py-3 text-left">{t('admin.colAmount')}</th>
                  <th className="px-4 py-3 text-left">{t('admin.colPlan')}</th>
                  <th className="px-4 py-3 text-left">{t('admin.colStatus')}</th>
                  <th className="px-4 py-3 text-left">{t('admin.colTime')}</th>
                </tr></thead>
                <tbody>
                  {purchases.map((p) => (
                    <tr key={p.order_id} className="border-b border-sky-50 hover:bg-sky-50/50">
                      <td className="px-4 py-2 font-mono text-xs">{p.order_id}</td>
                      <td className="px-4 py-2 text-xs">{p.email || '--'}</td>
                      <td className="px-4 py-2">${Number(p.amount || 0)}</td>
                      <td className="px-4 py-2 text-xs">{p.plan_type}{p.tokens ? ` · ${Number(p.tokens).toLocaleString('en-US')} tk` : ''}</td>
                      <td className="px-4 py-2"><span className={`px-2 py-0.5 rounded text-xs ${p.status === 'finished' ? 'bg-emerald-100 text-emerald-700' : p.status === 'expired' ? 'bg-red-100 text-red-600' : 'bg-amber-100 text-amber-700'}`}>{p.status}</span></td>
                      <td className="px-4 py-2 text-xs text-gray-400">{p.created_at ? new Date(p.created_at).toLocaleString() : '--'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

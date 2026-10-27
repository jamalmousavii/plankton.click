import Head from 'next/head';
import Link from 'next/link';
import { useState, useEffect, useCallback } from 'react';
import { useLanguage } from '../i18n/LanguageContext';
import Navbar from '../components/Navbar';
import { useAuth, apiFetch, ApiError } from '../utils/api';

// v3.39.0 — user support: list my tickets, open a thread, reply, close.
// Admin replies live in /admin; this page is strictly the user's own view.
const CATEGORIES = ['support', 'billing', 'worker'];

export default function Support() {
  const { t } = useLanguage();
  const [tickets, setTickets] = useState([]);
  const [view, setView] = useState('list'); // list | new | thread
  const [active, setActive] = useState(null); // { ticket, messages }
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState('support');
  const [body, setBody] = useState('');
  const [reply, setReply] = useState('');

  const { user } = useAuth();

  const loadList = useCallback(async () => {
    try {
      const data = await apiFetch('/api/tickets');
      if (data.success) setTickets(data.tickets || []);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return; // session redirect handles it
      setError(t('common.loadFailed'));
    }
  }, [t]);

  useEffect(() => {
    if (user) {
      loadList().finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, [user, loadList]);

  const openThread = async (ticket) => {
    setError('');
    setBusy(true);
    try {
      const data = await apiFetch(`/api/tickets/${ticket.id}`);
      if (data.success) {
        setActive(data);
        setView('thread');
        setReply('');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('chat.errorConnection'));
    }
    setBusy(false);
  };

  const createTicket = async () => {
    setError('');
    if (!subject.trim() || !body.trim()) {
      setError(t('support.fillRequired'));
      return;
    }
    setBusy(true);
    try {
      const data = await apiFetch('/api/tickets', {
        method: 'POST',
        body: JSON.stringify({ subject: subject.trim(), category, body: body.trim() }),
      });
      if (data.success) {
        setSubject('');
        setBody('');
        await loadList();
        setView('list');
      } else {
        setError(data.error || t('chat.errorConnection'));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('chat.errorConnection'));
    }
    setBusy(false);
  };

  const sendReply = async () => {
    if (!active || !reply.trim()) return;
    setError('');
    setBusy(true);
    try {
      const data = await apiFetch(`/api/tickets/${active.ticket.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body: reply.trim() }),
      });
      if (data.success) {
        setReply('');
        setActive((prev) => ({
          ticket: data.ticket || prev.ticket,
          messages: [...prev.messages, data.message],
        }));
        await loadList();
      } else {
        setError(data.error || t('chat.errorConnection'));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('chat.errorConnection'));
    }
    setBusy(false);
  };

  const closeTicket = async () => {
    if (!active) return;
    setBusy(true);
    try {
      const data = await apiFetch(`/api/tickets/${active.ticket.id}/close`, { method: 'POST' });
      if (data.success) {
        setActive((prev) => ({ ...prev, ticket: data.ticket }));
        await loadList();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('chat.errorConnection'));
    }
    setBusy(false);
  };

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

  if (loading || !user) {
    return (
      <div className="flex-1 page-surface flex items-center justify-center">
        <div className="text-gray-600 text-lg">Loading...</div>
      </div>
    );
  }

  return (
    <div className="flex-1 page-surface min-h-screen">
      <Head><title>{t('support.pageTitle')} - Plankton Network</title></Head>
      <Navbar />

      <main className="container mx-auto px-4 md:px-6 py-6 md:py-12 max-w-2xl">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-800">🎫 {t('support.pageTitle')}</h1>
            <p className="text-sm text-gray-500">{t('support.pageDesc')}</p>
          </div>
          <div className="flex gap-2">
            {view !== 'list' && (
              <button
                onClick={() => { setView('list'); setError(''); }}
                className="px-4 py-2 min-h-[40px] rounded-lg text-sm font-bold bg-white text-gray-600 border border-sky-200 hover:bg-sky-50"
              >
                ← {t('support.backToList')}
              </button>
            )}
            {view === 'list' && (
              <button
                onClick={() => { setView('new'); setError(''); }}
                className="px-4 py-2 min-h-[40px] rounded-lg text-sm font-bold bg-sky-500 text-white hover:bg-sky-600 transition"
              >
                ✏️ {t('support.newTicket')}
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="mb-4 bg-red-50 border border-red-200 text-red-600 text-sm rounded-xl px-4 py-3">
            {error}
          </div>
        )}

        {view === 'list' && (
          tickets.length === 0 ? (
            <div className="bg-white rounded-xl border border-sky-100 shadow-sm p-8 text-center">
              <div className="text-3xl mb-2">📭</div>
              <p className="text-gray-600 font-semibold">{t('support.emptyTitle')}</p>
              <p className="text-gray-400 text-sm mt-1">{t('support.emptyDesc')}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {tickets.map((tk) => (
                <button
                  key={tk.id}
                  onClick={() => openThread(tk)}
                  disabled={busy}
                  className="bg-white rounded-xl border border-sky-100 shadow-sm p-4 text-left hover:border-sky-300 transition disabled:opacity-60"
                >
                  <div className="flex items-center justify-between gap-3 mb-1">
                    <span className="text-sm font-bold text-gray-800 truncate">#{tk.id} · {tk.subject}</span>
                    {statusBadge(tk.status)}
                  </div>
                  <div className="flex items-center justify-between gap-3 text-xs text-gray-400">
                    <span className="truncate">{tk.last_message || ''}</span>
                    <span className="flex-shrink-0">{new Date(tk.updated_at).toLocaleDateString()}</span>
                  </div>
                </button>
              ))}
            </div>
          )
        )}

        {view === 'new' && (
          <div className="bg-white rounded-xl border border-sky-100 shadow-sm p-5 md:p-6">
            <h2 className="text-lg font-bold text-gray-800 mb-4">{t('support.newTicket')}</h2>
            <div className="flex flex-col gap-3">
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                maxLength={200}
                placeholder={t('support.subjectPlaceholder')}
                className="border border-sky-200 rounded-xl px-3 py-2.5 text-sm"
              />
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="border border-sky-200 rounded-xl px-3 py-2.5 text-sm bg-white"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{t(`support.cat_${c}`)}</option>
                ))}
              </select>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={4000}
                rows={5}
                placeholder={t('support.messagePlaceholder')}
                className="border border-sky-200 rounded-xl px-3 py-2.5 text-sm resize-y"
              />
              <button
                onClick={createTicket}
                disabled={busy || !subject.trim() || !body.trim()}
                className="bg-sky-600 hover:bg-sky-700 text-white px-5 py-2.5 rounded-xl transition text-sm font-bold disabled:opacity-50 self-start"
              >
                {busy ? '...' : `📨 ${t('support.submit')}`}
              </button>
            </div>
          </div>
        )}

        {view === 'thread' && active && (
          <div className="bg-white rounded-xl border border-sky-100 shadow-sm p-5 md:p-6">
            <div className="flex items-center justify-between gap-3 mb-1 flex-wrap">
              <h2 className="text-lg font-bold text-gray-800">#{active.ticket.id} · {active.ticket.subject}</h2>
              {statusBadge(active.ticket.status)}
            </div>
            <p className="text-xs text-gray-400 mb-4">
              {t(`support.cat_${active.ticket.category}`)} · {new Date(active.ticket.created_at).toLocaleString()}
            </p>

            <div className="flex flex-col gap-3 mb-4 max-h-[420px] overflow-y-auto pr-1">
              {(active.messages || []).map((m) => (
                <div
                  key={m.id}
                  className={`max-w-[85%] rounded-xl px-3.5 py-2.5 text-sm ${
                    m.is_admin
                      ? 'bg-violet-50 border border-violet-100 self-start'
                      : 'bg-sky-50 border border-sky-100 self-end'
                  }`}
                >
                  <div className={`text-[10px] font-bold mb-1 ${m.is_admin ? 'text-violet-600' : 'text-sky-600'}`}>
                    {m.is_admin ? t('support.adminReply') : t('support.you')}
                    {' · '}
                    <span className="font-normal text-gray-400">{new Date(m.created_at).toLocaleString()}</span>
                  </div>
                  <div className="text-gray-700 whitespace-pre-wrap break-words">{m.body}</div>
                </div>
              ))}
            </div>

            {active.ticket.status !== 'closed' ? (
              <div className="flex flex-col gap-3 border-t border-gray-100 pt-4">
                <textarea
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  maxLength={4000}
                  rows={3}
                  placeholder={t('support.replyPlaceholder')}
                  className="border border-sky-200 rounded-xl px-3 py-2.5 text-sm resize-y"
                />
                <div className="flex gap-2 flex-wrap">
                  <button
                    onClick={sendReply}
                    disabled={busy || !reply.trim()}
                    className="bg-sky-600 hover:bg-sky-700 text-white px-5 py-2.5 rounded-xl transition text-sm font-bold disabled:opacity-50"
                  >
                    {busy ? '...' : `💬 ${t('support.send')}`}
                  </button>
                  <button
                    onClick={closeTicket}
                    disabled={busy}
                    className="bg-white border border-red-200 text-red-500 hover:bg-red-50 px-5 py-2.5 rounded-xl transition text-sm font-bold disabled:opacity-50"
                  >
                    ✓ {t('support.close')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="bg-gray-50 border border-gray-100 rounded-xl p-3 text-center text-sm text-gray-400">
                {t('support.closedNote')}
              </div>
            )}
          </div>
        )}

        <div className="mt-6 text-center">
          <Link href="/profile" className="text-sm text-sky-600 hover:text-sky-700 transition font-semibold">
            ← {t('nav.dashboard')}
          </Link>
        </div>
      </main>
    </div>
  );
}

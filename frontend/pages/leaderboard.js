import Head from 'next/head';
import { useState } from 'react';
import { useLanguage } from '../i18n/LanguageContext';
import Navbar from '../components/Navbar';
import useApi from '../hooks/useApi';

export default function Leaderboard() {
  const { t, lang } = useLanguage();
  const [tab, setTab] = useState('workers');
  // Phase 6: shared abort-aware hook — switching tabs cancels the in-flight
  // request, so a slow workers response can no longer land on the users tab.
  const { data, loading, error, reload } = useApi(`/api/leaderboard/${tab}`, {
    deps: [tab],
  });
  const workers = data?.workers || [];
  const users = data?.users || [];

  const medals = ['🥇', '🥈', '🥉'];

  return (
    <div className={`flex-1 page-surface`}>
      <Head><title>{t('leaderboard.title')} - Plankton Network</title></Head>
      <Navbar />

      <main className="container mx-auto px-4 md:px-6 py-6 md:py-12 max-w-3xl">
        <h1 className="text-2xl md:text-4xl font-bold text-gray-800 text-center mb-6 md:mb-8">🏆 {t('leaderboard.title')}</h1>

        <div className="flex gap-2 mb-6 justify-center">
          {['workers', 'users'].map(tb => (
            <button key={tb} onClick={() => setTab(tb)}
              className={`px-6 py-2 rounded-lg text-sm font-bold ${tab === tb ? 'bg-sky-500 text-white' : 'bg-white text-gray-600 border border-sky-200 hover:bg-sky-50'}`}>
              {tb === 'workers' ? `🖥️ ${t('leaderboard.topWorkers')}` : `👤 ${t('leaderboard.topUsers')}`}
            </button>
          ))}
        </div>

        {loading && (
          <p className="text-gray-500 text-center py-10">{t('common.loading')}</p>
        )}

        {!loading && error && (
          <div className="bg-red-50 border border-red-200 text-red-600 text-sm rounded-xl px-4 py-3 flex items-center justify-between gap-3">
            <span>{t('common.loadFailed')}</span>
            <button onClick={reload} className="font-bold underline min-h-[36px]">{t('common.retry')}</button>
          </div>
        )}

        {!loading && !error && tab === 'workers' && (
          <div className="space-y-3">
            {!loading && !error && workers.length === 0 && <p className="text-gray-400 text-center py-10">{t('leaderboard.noWorkers')}</p>}
            {workers.map((m, i) => (
              <div key={m.id} className={`bg-white border border-sky-100 shadow-sm rounded-xl p-4 flex items-center gap-4 ${i < 3 ? 'ring-1 ring-amber-200' : ''}`}>
                <div className="text-2xl w-10 text-center">{medals[i] || `#${i + 1}`}</div>
                <div className="flex-1 min-w-0">
                  <div className="text-gray-800 font-bold text-sm truncate">{m.gpu_model || t('leaderboard.unknownGpu')}</div>
                  <div className="text-gray-400 text-xs font-mono">{m.wallet_address?.slice(0, 12)}...</div>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-emerald-600 font-bold">{Number(m.earnings || 0).toFixed(2)}</div>
                  <div className="text-gray-400 text-xs">{m.total_tasks} {t('leaderboard.tasks')}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && !error && tab === 'users' && (
          <div className="space-y-3">
            {!loading && !error && users.length === 0 && <p className="text-gray-400 text-center py-10">{t('leaderboard.noUsers')}</p>}
            {users.map((u, i) => (
              <div key={u.id} className={`bg-white border border-sky-100 shadow-sm rounded-xl p-4 flex items-center gap-4 ${i < 3 ? 'ring-1 ring-amber-200' : ''}`}>
                <div className="text-2xl w-10 text-center">{medals[i] || `#${i + 1}`}</div>
                <div className="flex-1 min-w-0">
                  {u.avatar ? (
                    <img src={u.avatar} width={32} height={32} loading="lazy" className="w-8 h-8 rounded-full inline-block mr-2" alt="" />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-sky-500 inline-flex items-center justify-center mr-2 text-sm text-white">{(u.name || '?')[0]}</div>
                  )}
                  <span className="text-gray-800 font-bold text-sm">{u.name || t('leaderboard.anonymous')}</span>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-emerald-600 font-bold">{Number(u.earned || 0).toFixed(2)} PLANKTON</div>
                  <div className="text-gray-400 text-xs">{t('leaderboard.earnedLabel')}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

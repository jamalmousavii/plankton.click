import Head from 'next/head';
import Link from 'next/link';
import { useState, useEffect } from 'react';
import { useLanguage } from '../i18n/LanguageContext';
import Navbar from '../components/Navbar';
import EarningsBreakdown from '../components/EarningsBreakdown';
import { useAuth, apiFetch, ApiError } from '../utils/api';

const MODELS_LIST = [
  { id: 'llama3.1:8b', name: 'Llama 3.1', size: '5 GB', category: 'chat' },
  { id: 'llama3.3:70b', name: 'Llama 3.3', size: '43 GB', category: 'chat' },
  { id: 'deepseek-r1:70b', name: 'DeepSeek R1', size: '43 GB', category: 'chat' },
  { id: 'qwen3:32b', name: 'Qwen 3', size: '20 GB', category: 'chat' },
  { id: 'gpt-oss:20b', name: 'GPT-OSS 20B', size: '14 GB', category: 'chat' },
  { id: 'phi4:14b', name: 'Phi-4', size: '9 GB', category: 'chat' },
  { id: 'llama3.2:3b', name: 'Llama 3.2', size: '2 GB', category: 'chat' },
  { id: 'qwen3-coder:30b', name: 'Qwen 3 Coder', size: '18 GB', category: 'code' },
  { id: 'qwen2.5-coder:32b', name: 'Qwen 2.5 Coder', size: '20 GB', category: 'code' },
  { id: 'gemma3:27b', name: 'Gemma 3', size: '18 GB', category: 'vision' },
  { id: 'mistral-small3.2:24b', name: 'Mistral Small 3.2', size: '15 GB', category: 'vision' },
  { id: 'qwen3-vl:8b', name: 'Qwen 3 VL', size: '8 GB', category: 'vision' },
  { id: 'gemma4:12b', name: 'Gemma 4', size: '7 GB', category: 'vision' },
];

const CATEGORY_ICONS = { chat: '💻', code: '💻', vision: '👁️', embedding: '🔗' };

function ResourceBar({ label, value, color }) {
  const safeValue = Math.min(Math.max(parseFloat(value) || 0, 0), 100);
  return (
    <div className="flex items-center gap-2">
      <span className="text-gray-500 text-xs w-10">{label}</span>
      <div className="flex-1 h-2 bg-sky-100 rounded-full overflow-hidden">
        <div className={`h-full bg-gradient-to-r ${color} transition-all duration-500`}
          style={{ width: `${safeValue}%` }} />
      </div>
      <span className="text-gray-600 text-xs w-10 text-right">{safeValue.toFixed(1)}%</span>
    </div>
  );
}

export default function Workers() {
  const { t, lang } = useLanguage();
  const [workers, setWorkers] = useState([]);
  const [editingWorkerId, setEditingWorkerId] = useState(null);
  const [workerNameInput, setWorkerNameInput] = useState('');
  const [workerMsg, setWorkerMsg] = useState('');
  const [newWorkerName, setNewWorkerName] = useState('');
  const [newWorkerToken, setNewWorkerToken] = useState('');
  const [newWorkerLoading, setNewWorkerLoading] = useState(false);
  const [copiedWorkerId, setCopiedWorkerId] = useState(null);
  const [showGuideModal, setShowGuideModal] = useState(false);
  const [guideForAdd, setGuideForAdd] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [regenTokenId, setRegenTokenId] = useState(null);
  const [regenTokenVal, setRegenTokenVal] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [copiedInstall, setCopiedInstall] = useState(null);
  const [history, setHistory] = useState(null);
  const [myRank, setMyRank] = useState(null); // v3.29.0 — account earnings breakdown
  // v3.41.3 — per-worker lifetime drill-down (active + history rows share it).
  const [expandedId, setExpandedId] = useState(null); // worker id | null
  const [earnCache, setEarnCache] = useState({}); // id -> { worker, breakdown } | 'loading' | 'error'

  const toggleEarnings = async (id) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (earnCache[id] && earnCache[id] !== 'error') return;
    setEarnCache((prev) => ({ ...prev, [id]: 'loading' }));
    try {
      const data = await apiFetch(`/api/workers/mine/${id}/earnings`);
      if (data.success) {
        setEarnCache((prev) => ({ ...prev, [id]: { worker: data.worker, breakdown: data.breakdown } }));
      } else {
        setEarnCache((prev) => ({ ...prev, [id]: 'error' }));
      }
    } catch (err) {
      setEarnCache((prev) => ({ ...prev, [id]: 'error' }));
    }
  };

  const renderEarnPanel = (id) => {
    const entry = earnCache[id];
    if (entry === 'loading') {
      return <div className="text-gray-400 text-xs mt-2">…</div>;
    }
    if (entry === 'error' || !entry) {
      return <div className="text-red-400 text-xs mt-2">{t('worker.loadFail')}</div>;
    }
    return (
      <div className="mt-2">
        <div className="text-gray-500 text-xs mb-1.5">
          {t('worker.lifetimeLine')
            .replace('{tasks}', entry.worker.total_tasks || 0)
            .replace('{earnings}', Number(entry.worker.earnings || 0).toFixed(4))}
          {' • '}
          {fmtDate(entry.worker.created_at)} → {fmtDate(entry.worker.uninstalled_at || entry.worker.last_seen)}
        </div>
        <EarningsBreakdown breakdown={entry.breakdown} />
        <div className="text-gray-400 text-[11px] mt-1.5">{t('worker.legacyNote')}</div>
      </div>
    );
  };

  const { ready, user } = useAuth();

  useEffect(() => {
    if (user) {
      fetchWorkers();
      fetchHistory();
      fetchRank();
      if (!localStorage.getItem('plankton-guide-seen')) {
        setGuideForAdd(false);
        setShowGuideModal(true);
      }
    }
    setLoading(false);
  }, [user]);

  const fetchWorkers = async () => {
    try {
      const data = await apiFetch('/api/workers/mine');
      if (data.success) setWorkers(data.workers || (data.worker ? [data.worker] : []));
    } catch (err) {
      // F15: a failed dashboard fetch used to fail silently.
      setLoadError(true);
    }
  };

  // v3.29.0 — account-level earnings breakdown (all workers, 5 sources)
  const fetchRank = async () => {
    try {
      const data = await apiFetch('/api/leaderboard/mine');
      if (data.success && data.breakdown) setMyRank(data);
    } catch (err) {
      // F15: a failed dashboard fetch used to fail silently.
      setLoadError(true);
    }
  };

  const fetchHistory = async () => {
    try {
      const data = await apiFetch('/api/workers/history');
      if (data.success) setHistory(data);
    } catch (err) {
      // F15: a failed dashboard fetch used to fail silently.
      setLoadError(true);
    }
  };

  const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '—');

  const switchModel = async (modelId, workerId) => {
    try {
      const data = await apiFetch('/api/workers/mine/model', {
        method: 'PUT',
        body: JSON.stringify({ model: modelId, worker_id: workerId || undefined })
      });
      if (data.success) {
        const updatedId = workerId || data.worker?.id;
        setWorkers(prev => prev.map(m => m.id === updatedId ? { ...m, current_model: modelId } : m));
      }
    } catch (err) {}
  };

  const renameWorker = async (workerId) => {
    if (!workerNameInput.trim()) return;
    try {
      const data = await apiFetch(`/api/workers/mine/${workerId}`, {
        method: 'PUT',
        body: JSON.stringify({ name: workerNameInput.trim() })
      });
      if (data.success) {
        setWorkers(prev => prev.map(m => m.id === workerId ? { ...m, name: workerNameInput.trim() } : m));
        setEditingWorkerId(null);
        setWorkerNameInput('');
      } else {
        setWorkerMsg(`❌ ${data.error}`);
      }
    } catch (err) { setWorkerMsg(`❌ ${err instanceof ApiError ? err.message : 'Rename failed'}`); }
  };

  const deleteWorker = async (workerId, workerName) => {
    if (!window.confirm(t('profile.confirmRemoveWorker'))) return;
    try {
      const data = await apiFetch(`/api/workers/mine/${workerId}`, { method: 'DELETE' });
      if (data.success) {
        setWorkers(prev => prev.filter(m => m.id !== workerId));
        setWorkerMsg(`✅ ${workerName || ''} ${t('profile.workerRemoved')}`);
        fetchWorkers();
        fetchHistory();
      } else {
        setWorkerMsg(`❌ ${data.error}`);
      }
    } catch (err) { setWorkerMsg(`❌ ${err instanceof ApiError ? err.message : 'Remove failed'}`); }
  };

  const copyText = (text, workerId) => {
    navigator.clipboard.writeText(text);
    setCopiedWorkerId(workerId);
    setTimeout(() => setCopiedWorkerId(null), 2000);
  };

  const ubuntuInstallCmd = 'wget https://raw.githubusercontent.com/jamalmousavii/plankton.click/main/worker-app/install-ubuntu.sh && bash install-ubuntu.sh --token YOUR_TOKEN';
  const redhatInstallCmd = 'wget https://raw.githubusercontent.com/jamalmousavii/plankton.click/main/worker-app/install-redhat.sh && bash install-redhat.sh --token YOUR_TOKEN';

  const copyInstall = (cmd, id) => {
    navigator.clipboard.writeText(cmd);
    setCopiedInstall(id);
    setTimeout(() => setCopiedInstall(null), 2000);
  };

  const openAddWorker = () => {
    setGuideForAdd(true);
    setShowGuideModal(true);
  };

  const closeGuide = () => {
    setShowGuideModal(false);
    localStorage.setItem('plankton-guide-seen', '1');
    if (guideForAdd) {
      setShowAddForm(true);
      setGuideForAdd(false);
    }
  };

  const createWorker = async () => {
    setNewWorkerLoading(true);
    try {
      const data = await apiFetch('/api/workers', {
        method: 'POST',
        body: JSON.stringify({ name: newWorkerName.trim() || undefined })
      });
      if (data.success) {
        setNewWorkerToken(data.worker.worker_token);
        setNewWorkerName('');
        setShowAddForm(false);
        fetchWorkers();
      } else {
        setWorkerMsg(`❌ ${data.error}`);
      }
    } catch (err) { setWorkerMsg(`❌ ${err instanceof ApiError ? err.message : 'Create failed'}`); }
    setNewWorkerLoading(false);
  };

  const regenerateToken = async (workerId) => {
    try {
      const data = await apiFetch(`/api/workers/mine/${workerId}/token`, { method: 'PUT' });
      if (data.success) {
        setRegenTokenId(workerId);
        setRegenTokenVal(data.worker.worker_token);
        setWorkerMsg(`✅ ${t('profile.tokenRegenerated')}`);
        fetchWorkers();
      } else {
        setWorkerMsg(`❌ ${data.error}`);
      }
    } catch (err) { setWorkerMsg(`❌ ${err instanceof ApiError ? err.message : 'Token regenerate failed'}`); }
  };

  if (loading || !user) {
    return (
      <div className="flex-1 page-surface flex items-center justify-center">
        <div className="text-gray-600 text-lg">Loading...</div>
      </div>
    );
  }

  const retryLoad = () => {
    setLoadError(false);
    fetchWorkers(); fetchHistory(); fetchRank();
  };

  const errorBanner = loadError && (
    <div className="mb-4 bg-red-50 border border-red-200 text-red-600 text-sm rounded-xl px-4 py-3 flex items-center justify-between gap-3">
      <span>{t('common.loadFailed')}</span>
      <button onClick={retryLoad} className="font-bold underline min-h-[36px]">{t('common.retry')}</button>
    </div>
  );

  return (
    <div className={`flex-1 page-surface`}>
      <Head><title>{t('profile.myWorkers')} - Plankton Network</title></Head>

      {/* Guide modal */}
      {showGuideModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4" role="dialog" aria-modal="true">
          <div className="bg-white border border-sky-200 rounded-t-2xl sm:rounded-xl p-6 max-w-md w-full space-y-4 shadow-2xl max-h-[85dvh] overflow-y-auto overscroll-contain pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:pb-6">
            <h3 className="text-lg font-bold text-gray-800">{t('profile.workerGuideTitle')}</h3>
            <div className="space-y-2 text-sm text-gray-600">
              <p>{t('profile.workerGuideStep1')}</p>
              <p>{t('profile.workerGuideStep2')}</p>
              <code className="block text-xs text-emerald-700 bg-sky-50 border border-sky-100 px-2 py-1 rounded break-all">
                wget https://raw.githubusercontent.com/jamalmousavii/plankton.click/main/worker-app/install-ubuntu.sh && bash install-ubuntu.sh --token YOUR_TOKEN
              </code>
              <p>{t('profile.workerGuideStep3')}</p>
              <p className="text-gray-400">{t('profile.workerGuideStep4')}</p>
              <p>{t('profile.workerGuideStep5')}</p>
            </div>
            <div className="flex gap-2 justify-end pt-2">
              <button onClick={closeGuide} className="px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-600 text-white text-sm font-bold">
                {guideForAdd ? t('profile.workerGuideContinue') : t('profile.workerGuideClose')}
              </button>
            </div>
          </div>
        </div>
      )}

      <Navbar />
        {errorBanner}

      <main className="container mx-auto px-4 md:px-6 py-6 md:py-12 max-w-3xl">
        {/* Quick nav */}
        <div className="flex gap-2 mb-6 flex-wrap">
          <Link href="/profile" className="px-4 py-2 min-h-[40px] inline-flex items-center rounded-lg text-sm font-bold bg-white text-gray-600 border border-sky-200 hover:bg-sky-50">📊 {t('nav.dashboard')}</Link>
          <Link href="/workers" className="px-4 py-2 min-h-[40px] inline-flex items-center rounded-lg text-sm font-bold bg-sky-500 text-white">🖥️ {t('nav.workers')}</Link>
          <Link href="/support" className="px-4 py-2 min-h-[40px] inline-flex items-center rounded-lg text-sm font-bold bg-white text-gray-600 border border-sky-200 hover:bg-sky-50">🎫 {t('nav.support')}</Link>
          <Link href="/settings" className="px-4 py-2 min-h-[40px] inline-flex items-center rounded-lg text-sm font-bold bg-white text-gray-600 border border-sky-200 hover:bg-sky-50">⚙️ {t('nav.settings')}</Link>
        </div>

        {/* Quick Install with copy buttons */}
        <div className="bg-white rounded-xl border border-sky-100 shadow-sm p-5 md:p-6 mb-6">
          <h2 className="text-lg font-bold text-gray-800 mb-1">⚡ {t('worker.quickInstall')}</h2>
          <p className="text-gray-500 text-xs mb-4">{t('worker.connectStep2')}</p>
          <div className="space-y-3">
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <span>🐧</span>
                <span className="text-gray-800 font-bold text-sm">{t('worker.ubuntu')}</span>
              </div>
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <div className="flex-1 bg-sky-50 border border-sky-100 rounded-lg px-3 py-2 font-mono text-xs text-emerald-700 overflow-x-auto">
                  <code>{ubuntuInstallCmd}</code>
                </div>
                <button
                  onClick={() => copyInstall(ubuntuInstallCmd, 'ubuntu')}
                  className={`px-4 py-2 rounded-lg font-bold text-sm transition min-h-[40px] ${
                    copiedInstall === 'ubuntu' ? 'bg-emerald-500 text-white' : 'bg-sky-500 hover:bg-sky-600 text-white'
                  }`}
                >
                  {copiedInstall === 'ubuntu' ? t('worker.copied') : t('worker.copyCmd')}
                </button>
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <span>🎩</span>
                <span className="text-gray-800 font-bold text-sm">{t('worker.redhat')}</span>
              </div>
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <div className="flex-1 bg-sky-50 border border-sky-100 rounded-lg px-3 py-2 font-mono text-xs text-emerald-700 overflow-x-auto">
                  <code>{redhatInstallCmd}</code>
                </div>
                <button
                  onClick={() => copyInstall(redhatInstallCmd, 'redhat')}
                  className={`px-4 py-2 rounded-lg font-bold text-sm transition min-h-[40px] ${
                    copiedInstall === 'redhat' ? 'bg-emerald-500 text-white' : 'bg-sky-500 hover:bg-sky-600 text-white'
                  }`}
                >
                  {copiedInstall === 'redhat' ? t('worker.copied') : t('worker.copyCmd')}
                </button>
              </div>
            </div>
          </div>
          <p className="text-gray-400 text-xs mt-3">
            <Link href="/worker" className="text-sky-600 hover:text-sky-700">📖 {t('worker.installDocsDesc')}</Link>
            {' · '}
            <a href="https://github.com/jamalmousavii/plankton.click" target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:text-sky-700">⭐ {t('worker.github')}</a>
          </p>
        </div>

        {/* v3.29.0 — account earnings breakdown (token pot / wallet / Plus / Pro / Max) */}
        {myRank?.breakdown && (
          <div className="bg-white rounded-xl border border-sky-100 shadow-sm p-5 md:p-6 mb-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-bold text-gray-800">💰 {t('worker.earningsTitle')}</h2>
              <Link href="/profile" className="text-sm font-semibold text-sky-600 hover:text-sky-700 transition">
                {t('profile.dashboard')} →
              </Link>
            </div>
            <p className="text-xs text-gray-500 mb-3">{t('worker.earningsDesc')}</p>
            <EarningsBreakdown breakdown={myRank.breakdown} />
          </div>
        )}

        <div className="bg-white rounded-xl border border-sky-100 shadow-sm p-5 md:p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-gray-800">🖥️ {t('profile.workerSettings')} {workers.length > 0 && <span className="text-gray-400">({workers.length})</span>}</h2>
            <button onClick={openAddWorker}
              className="bg-emerald-500 hover:bg-emerald-600 text-white px-3 py-1.5 rounded-lg text-xs font-bold transition">
              + {t('profile.addWorker')}
            </button>
          </div>
          {workerMsg && <p className="text-xs text-gray-600 mb-2">{workerMsg}</p>}

          {workers.length > 0 ? (
            <div className="space-y-4">
              {workers.map((m) => (
                <div key={m.id} className="bg-sky-50 rounded-lg p-4 space-y-3 border border-sky-100">
                  <div className="flex items-center justify-between">
                    {editingWorkerId === m.id ? (
                      <div className="flex items-center gap-2 flex-1">
                        <input type="text" value={workerNameInput} onChange={(e) => setWorkerNameInput(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') renameWorker(m.id); if (e.key === 'Escape') setEditingWorkerId(null); }}
                          placeholder={t('profile.workerNamePlaceholder')}
                          className="flex-1 bg-white text-gray-800 border border-sky-200 px-2 py-1 rounded text-sm focus:outline-none focus:ring-1 focus:ring-sky-400" />
                        <button onClick={() => renameWorker(m.id)} className="text-emerald-600 hover:text-emerald-700 text-sm">✓</button>
                        <button onClick={() => setEditingWorkerId(null)} className="text-gray-400 hover:text-gray-600 text-sm">✕</button>
                      </div>
                    ) : (
                      <>
                        <span className="text-gray-800 text-sm font-medium truncate">{m.name || `${t('profile.worker')} #${m.id}`}</span>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <button onClick={() => { setEditingWorkerId(m.id); setWorkerNameInput(m.name || ''); }}
                            className="text-gray-400 hover:text-sky-600 text-xs" title={t('profile.rename')}>✏️</button>
                          <button onClick={() => deleteWorker(m.id, m.name)}
                            className="text-red-400 hover:text-red-500 text-xs" title={t('profile.remove')}>🗑️</button>
                        </div>
                      </>
                    )}
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-500 text-sm">{t('profile.workerStatus')}</span>
                    <span className={`text-sm font-medium ${m.status === 'online' ? 'text-emerald-600' : 'text-red-500'}`}>
                      {m.status === 'online' ? `🟢 ${t('profile.online')}` : `🔴 ${t('profile.offline')}`}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm"><span className="text-gray-500">{t('profile.gpuModel')}</span><span className="text-gray-800">{m.gpu_model || 'N/A'}</span></div>
                  <div className="flex justify-between text-sm"><span className="text-gray-500">{t('profile.ram')}</span><span className="text-gray-800">{m.ram || 'N/A'}</span></div>
                  <div className="flex justify-between text-sm"><span className="text-gray-500">{t('profile.cpu')}</span><span className="text-gray-800">{m.cpu || 'N/A'}</span></div>

                  {(m.cpu_usage > 0 || m.ram_usage > 0 || m.gpu_usage > 0 || m.disk_usage > 0) && (
                    <div className="bg-white rounded-lg p-3 space-y-2 border border-sky-100">
                      <p className="text-gray-500 text-xs font-medium mb-2">📊 {t('profile.resourceUsage')}</p>
                      <ResourceBar label="CPU" value={m.cpu_usage} color="from-sky-400 to-cyan-400" />
                      <ResourceBar label="RAM" value={m.ram_usage} color="from-emerald-400 to-teal-400" />
                      {m.gpu_usage > 0 && (
                        <ResourceBar label="GPU" value={m.gpu_usage} color="from-violet-400 to-purple-400" />
                      )}
                      <ResourceBar label="Disk" value={m.disk_usage} color="from-amber-400 to-orange-400" />
                    </div>
                  )}
                  <div className="flex justify-between text-sm items-center">
                    <span className="text-gray-500">{t('profile.currentModel')}</span>
                    <select value={m.current_model || 'llama3.1:8b'} onChange={(e) => switchModel(e.target.value, m.id)}
                      className="bg-white text-gray-800 text-sm px-2 py-1 rounded border border-sky-200 focus:outline-none focus:ring-1 focus:ring-sky-400">
                      {MODELS_LIST.map(md => (<option key={md.id} value={md.id}>{CATEGORY_ICONS[md.category]} {md.name} ({md.size})</option>))}
                    </select>
                  </div>
                  {(m.installed_models && m.installed_models.length > 0) && (
                    <div className="text-sm">
                      <span className="text-gray-500">{t('profile.workerModels')}</span>
                      <div className="flex flex-wrap gap-1.5 mt-1.5">
                        {m.installed_models.map((mid) => {
                          const down = (m.models_down || []).includes(mid);
                          return (
                            <span key={mid} title={down ? t('profile.modelDownRepair') : mid}
                              className={`px-2 py-0.5 rounded-full text-xs font-medium border ${
                                down ? 'bg-red-50 text-red-600 border-red-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              }`}>
                              {down ? '🔴' : '🟢'} {mid}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  <div className="flex justify-between text-sm"><span className="text-gray-500">{t('profile.uptime')}</span><span className="text-gray-800">{parseFloat(m.uptime || 0).toFixed(1)}%</span></div>
                  <div className="flex justify-between text-sm"><span className="text-gray-500">{t('profile.totalTasks')}</span><span className="text-gray-800">{m.total_tasks || 0}</span></div>
                  <div className="flex justify-between text-sm items-center">
                    <span className="text-gray-500">{t('profile.earnings')}</span>
                    <span className="flex items-center gap-2">
                      <span className="text-emerald-600 font-medium">{parseFloat(m.earnings || 0).toFixed(4)}</span>
                      <button onClick={() => toggleEarnings(m.id)}
                        className="text-sky-600 hover:text-sky-700 text-xs font-bold transition" aria-expanded={expandedId === m.id}>
                        {expandedId === m.id ? `▲ ${t('worker.hideDetails')}` : `▼ ${t('worker.showDetails')}`}
                      </button>
                    </span>
                  </div>
                  {expandedId === m.id && renderEarnPanel(m.id)}

                  {m.worker_token ? (
                    <div className="flex items-center gap-2 pt-1">
                      <code className="flex-1 text-emerald-700 text-xs break-all bg-white border border-sky-100 px-2 py-1 rounded">{m.worker_token}</code>
                      <button onClick={() => copyText(m.worker_token, m.id)}
                        className={`px-3 py-1 rounded text-xs font-bold transition ${copiedWorkerId === m.id ? 'bg-emerald-500 text-white' : 'bg-sky-500 hover:bg-sky-600 text-white'}`}>
                        {copiedWorkerId === m.id ? '✓' : '📋'}
                      </button>
                    </div>
                  ) : regenTokenId === m.id && regenTokenVal ? (
                    <div className="space-y-2 pt-1">
                      <div className="flex items-center gap-2">
                        <code className="flex-1 text-emerald-700 text-xs break-all bg-white border border-sky-100 px-2 py-1 rounded">{regenTokenVal}</code>
                        <button onClick={() => copyText(regenTokenVal, m.id)}
                          className={`px-3 py-1 rounded text-xs font-bold transition ${copiedWorkerId === m.id ? 'bg-emerald-500 text-white' : 'bg-sky-500 hover:bg-sky-600 text-white'}`}>
                          {copiedWorkerId === m.id ? '✓' : '📋'}
                        </button>
                      </div>
                      <code className="block text-gray-600 text-xs break-all bg-white border border-sky-100 px-2 py-1 rounded">wget https://raw.githubusercontent.com/jamalmousavii/plankton.click/main/worker-app/install-ubuntu.sh && bash install-ubuntu.sh --token {regenTokenVal}</code>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-2 pt-1">
                      <span className="text-gray-400 text-xs">🔒 {t('profile.tokenHidden')}</span>
                      <button onClick={() => regenerateToken(m.id)}
                        className="bg-amber-500 hover:bg-amber-600 text-white px-3 py-1 rounded text-xs font-bold transition">
                        🔄 {t('profile.generateNewToken')}
                      </button>
                    </div>
                  )}
                </div>
              ))}

              {showAddForm && (
                <div className="bg-white rounded-lg p-4 space-y-2 border border-emerald-200">
                  <p className="text-gray-800 text-sm font-medium">➕ {t('profile.addWorker')}</p>
                  <p className="text-gray-500 text-xs">{t('profile.addWorkerDesc')}</p>
                  <div className="flex gap-2">
                    <input type="text" value={newWorkerName} onChange={(e) => setNewWorkerName(e.target.value)}
                      placeholder={t('profile.enterWorkerName')}
                      className="flex-1 bg-sky-50 text-gray-800 placeholder-gray-400 border border-sky-200 px-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-sky-400" />
                    <button onClick={createWorker} disabled={newWorkerLoading}
                      className="bg-emerald-500 hover:bg-emerald-600 text-white px-4 py-2 rounded-lg transition text-sm font-bold disabled:opacity-50">
                      {newWorkerLoading ? '...' : `+ ${t('profile.create')}`}
                    </button>
                  </div>
                  {newWorkerToken && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <code className="flex-1 text-emerald-700 text-xs break-all bg-sky-50 border border-sky-100 px-2 py-1 rounded">{newWorkerToken}</code>
                        <button onClick={() => copyText(newWorkerToken, 'new')}
                          className={`px-3 py-1 rounded text-xs font-bold transition ${copiedWorkerId === 'new' ? 'bg-emerald-500 text-white' : 'bg-sky-500 hover:bg-sky-600 text-white'}`}>
                          {copiedWorkerId === 'new' ? '✓' : '📋'}
                        </button>
                      </div>
                      <code className="block text-gray-600 text-xs break-all bg-sky-50 border border-sky-100 px-2 py-1 rounded">wget https://raw.githubusercontent.com/jamalmousavii/plankton.click/main/worker-app/install-ubuntu.sh && bash install-ubuntu.sh --token {newWorkerToken}</code>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-gray-500 text-sm">{t('profile.noWorker')}</p>
              <p className="text-gray-400 text-xs">{t('profile.addWorkerDesc')}</p>
              {showAddForm && (
                <div className="bg-white rounded-lg p-4 space-y-2 border border-emerald-200">
                  <p className="text-gray-800 text-sm font-medium">➕ {t('profile.addWorker')}</p>
                  <div className="flex gap-2">
                    <input type="text" value={newWorkerName} onChange={(e) => setNewWorkerName(e.target.value)}
                      placeholder={t('profile.enterWorkerName')}
                      className="flex-1 bg-sky-50 text-gray-800 placeholder-gray-400 border border-sky-200 px-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-sky-400" />
                    <button onClick={createWorker} disabled={newWorkerLoading}
                      className="bg-emerald-500 hover:bg-emerald-600 text-white px-4 py-2 rounded-lg transition text-sm font-bold disabled:opacity-50">
                      {newWorkerLoading ? '...' : `+ ${t('profile.create')}`}
                    </button>
                  </div>
                  {newWorkerToken && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <code className="flex-1 text-emerald-700 text-xs break-all bg-sky-50 border border-sky-100 px-2 py-1 rounded">{newWorkerToken}</code>
                        <button onClick={() => copyText(newWorkerToken, 'new')}
                          className={`px-3 py-1 rounded text-xs font-bold transition ${copiedWorkerId === 'new' ? 'bg-emerald-500 text-white' : 'bg-sky-500 hover:bg-sky-600 text-white'}`}>
                          {copiedWorkerId === 'new' ? '✓' : '📋'}
                        </button>
                      </div>
                      <code className="block text-gray-600 text-xs break-all bg-sky-50 border border-sky-100 px-2 py-1 rounded">wget https://raw.githubusercontent.com/jamalmousavii/plankton.click/main/worker-app/install-ubuntu.sh && bash install-ubuntu.sh --token {newWorkerToken}</code>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* History: uninstalled + offline >10 days (v3.22.0) */}
        {history && history.workers?.length > 0 && (
          <div className="bg-white rounded-xl border border-sky-100 shadow-sm p-5 md:p-6 mt-6">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-lg font-bold text-gray-800">📜 {t('profile.historyTitle')}</h2>
              <span className="text-xs text-gray-400">
                {t('profile.historySummary')
                  .replace('{added}', history.summary?.total_added ?? history.workers.length)
                  .replace('{tasks}', history.summary?.total_tasks ?? 0)
                  .replace('{earnings}', Number(history.summary?.total_earnings || 0).toFixed(4))}
              </span>
            </div>
            <div className="space-y-2 mt-3">
              {history.workers.map(h => (
                <div key={h.id} className="bg-sky-50 rounded-lg p-3 border border-sky-100">
                  <button onClick={() => toggleEarnings(h.id)}
                    aria-expanded={expandedId === h.id}
                    className="w-full flex items-center gap-3 text-left">
                    <div className="text-xl">{h.reason === 'uninstalled' ? '🗑️' : '🕐'}</div>
                    <div className="flex-1 min-w-0">
                      <div className="text-gray-800 font-bold text-sm truncate">{h.name || h.gpu_model || `#${h.id}`}</div>
                      <div className="text-gray-400 text-xs">
                        {h.gpu_model ? `${h.gpu_model} • ` : ''}
                        {t('profile.historyRowMeta')
                          .replace('{tasks}', h.total_tasks || 0)
                          .replace('{earnings}', Number(h.earnings || 0).toFixed(4))}
                      </div>
                      <div className="text-gray-400 text-xs">
                        {t('profile.historyAddedLabel')} {fmtDate(h.created_at)}
                        {' • '}
                        {h.uninstalled_at || h.reason === 'uninstalled'
                          ? `${t('profile.historyRemovedLabel')} ${fmtDate(h.uninstalled_at || h.last_seen || h.created_at)}`
                          : `${t('profile.historyLastSeenLabel')} ${fmtDate(h.last_seen || h.created_at)}`}
                      </div>
                    </div>
                    <span className={`text-xs font-bold px-2 py-1 rounded-full flex-shrink-0 ${h.reason === 'uninstalled' ? 'bg-red-50 text-red-500' : 'bg-amber-50 text-amber-600'}`}>
                      {h.reason === 'uninstalled' ? t('profile.reasonUninstalled') : t('profile.reasonStale')}
                    </span>
                    <span className="text-sky-500 text-xs flex-shrink-0">{expandedId === h.id ? '▲' : '▼'}</span>
                  </button>
                  {expandedId === h.id && renderEarnPanel(h.id)}
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

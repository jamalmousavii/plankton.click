// Remote model management (1.2.0): install / remove Ollama models on one of
// the owner's workers from the panel, with live download progress. The
// server only forwards catalog models to the owner's worker, and the worker
// itself re-validates (worker-app/src/services/manager.js).
import { useState, useEffect, useRef, useCallback } from 'react';
import { useLanguage } from '../i18n/LanguageContext';
import { apiFetch, ApiError } from '../utils/api';

const POLL_MS = 2000;
const parseGb = (s) => parseFloat(String(s || '').replace(',', '.')) || 0;
const gb = (bytes) => (bytes / 1024 ** 3).toFixed(1);
const fill = (str, vars) => Object.entries(vars)
  .reduce((out, [k, v]) => out.split(`{${k}}`).join(String(v)), str);

export default function WorkerModels({ workerId, onChanged }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [sending, setSending] = useState(false);
  const pollRef = useRef(null);
  const lastJobRef = useRef(null);
  // The parent passes a fresh callback every render; keep the latest in a
  // ref so `load` stays stable and does not refetch on unrelated renders.
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const load = useCallback(async () => {
    try {
      const d = await apiFetch(`/api/workers/mine/${workerId}/models`);
      const prev = lastJobRef.current;
      const job = d.job || null;
      // A job just finished → refresh the worker card (installed chips).
      if (prev && job && prev.id === job.id && prev.status === 'running' && job.status !== 'running' && onChangedRef.current) onChangedRef.current();
      lastJobRef.current = job;
      setData(d);
      setError('');
    } catch (err) {
      setError(t('workerModels.loadError'));
    }
  }, [workerId, t]);

  useEffect(() => { if (open) load(); }, [open, load]);

  useEffect(() => {
    clearTimeout(pollRef.current);
    if (open && data && data.job && data.job.status === 'running') {
      pollRef.current = setTimeout(load, POLL_MS);
    }
    return () => clearTimeout(pollRef.current);
  }, [open, data, load]);

  const act = async (method, url, body) => {
    setSending(true);
    setActionError('');
    try {
      await apiFetch(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      await load();
    } catch (err) {
      setActionError((err instanceof ApiError && err.data && err.data.error) || t('workerModels.loadError'));
    } finally {
      setSending(false);
    }
  };

  const install = (model) => act('POST', `/api/workers/mine/${workerId}/models`, { model });
  const remove = (model) => {
    if (!window.confirm(fill(t('workerModels.confirmRemove'), { model }))) return;
    act('DELETE', `/api/workers/mine/${workerId}/models/${encodeURIComponent(model)}`);
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="w-full text-sky-700 hover:text-sky-800 bg-white hover:bg-sky-50 border border-sky-200 rounded-lg px-3 py-2 text-sm font-medium transition">
        ⚙️ {t('workerModels.manage')}
      </button>
    );
  }

  const job = data && data.job;
  const running = !!(job && job.status === 'running');
  const canManage = !!(data && data.online && data.manage === 'on');
  const installed = (data && data.installed) || [];
  const required = new Set((data && data.required) || []);
  const workerRam = parseGb(data && data.worker_ram);
  const available = ((data && data.catalog) || []).filter((m) => !installed.includes(m.id));
  const catalogName = (id) => {
    const m = ((data && data.catalog) || []).find((c) => c.id === id);
    return m ? `${m.name} (${m.size})` : id;
  };
  const pct = job && job.total > 0 ? Math.min(100, Math.round((job.completed / job.total) * 100)) : 0;

  let notice = null;
  if (data && !data.online) notice = t('workerModels.offline');
  else if (data && data.manage === 'off') notice = t('workerModels.disabled');
  else if (data && data.manage !== 'on') notice = t('workerModels.unsupported');

  return (
    <div className="bg-white rounded-lg p-3 border border-sky-200 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-gray-700 text-sm font-semibold">⚙️ {t('workerModels.title')}</p>
        <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600 text-xs">{t('workerModels.hide')} ✕</button>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}
      {!data && !error && <p className="text-xs text-gray-400">…</p>}
      {notice && <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">{notice}</p>}

      {job && (
        <div className={`rounded px-2 py-2 text-xs border ${
          job.status === 'failed' ? 'bg-red-50 border-red-200 text-red-700'
            : job.status === 'done' ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
              : 'bg-sky-50 border-sky-200 text-sky-800'}`}>
          <p className="font-medium break-words">
            {job.status === 'running' && fill(t(job.action === 'pull' ? 'workerModels.installing' : 'workerModels.removing'), { model: job.model })}
            {job.status === 'done' && fill(t('workerModels.done'), { model: job.model })}
            {job.status === 'failed' && fill(t('workerModels.failed'), { model: job.model, error: job.error || '' })}
          </p>
          {running && job.action === 'pull' && (
            <div className="mt-1.5">
              <div className="h-2 bg-sky-100 rounded-full overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full bg-gradient-to-r from-sky-400 to-cyan-400 transition-all duration-500" style={{ width: `${pct}%` }} />
              </div>
              <p className="mt-1 text-sky-700 tabular-nums">
                {job.total > 0 ? `${pct}% · ${gb(job.completed)} / ${gb(job.total)} GB` : (job.phase || '…')}
              </p>
            </div>
          )}
        </div>
      )}

      {actionError && <p className="text-xs text-red-600 break-words">{actionError}</p>}

      {data && (
        <>
          <div>
            <p className="text-gray-500 text-xs font-medium mb-1.5">{t('workerModels.installed')}</p>
            <ul className="space-y-1">
              {installed.map((id) => (
                <li key={id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-gray-800 truncate">🟢 {catalogName(id)}</span>
                  {required.has(id) ? (
                    <span className="text-gray-400 text-xs flex-shrink-0">{t('workerModels.required')}</span>
                  ) : (
                    <button onClick={() => remove(id)} disabled={!canManage || running || sending}
                      className="text-red-500 hover:text-red-600 disabled:text-gray-300 text-xs font-medium flex-shrink-0 min-h-[32px] px-2">
                      {t('workerModels.remove')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>

          {available.length > 0 && (
            <div>
              <p className="text-gray-500 text-xs font-medium mb-1.5">{t('workerModels.available')}</p>
              <ul className="space-y-1">
                {available.map((m) => {
                  const tooBig = workerRam > 0 && parseGb(m.ram) > workerRam;
                  return (
                    <li key={m.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="min-w-0">
                        <span className="text-gray-800 block truncate">{m.name} ({m.size}) · {m.ram}</span>
                        {tooBig && (
                          <span className="text-amber-600 text-xs block">
                            ⚠ {fill(t('workerModels.ramWarn'), { size: m.ram, ram: data.worker_ram })}
                          </span>
                        )}
                      </span>
                      <button onClick={() => install(m.id)} disabled={!canManage || running || sending}
                        className="bg-sky-600 hover:bg-sky-700 disabled:bg-gray-200 disabled:text-gray-400 text-white text-xs font-medium rounded px-3 min-h-[32px] flex-shrink-0">
                        {t('workerModels.install')}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {running && <p className="text-xs text-gray-500">{t('workerModels.busy')}</p>}
          <p className="text-xs text-gray-400">{t('workerModels.note')}</p>
        </>
      )}
    </div>
  );
}

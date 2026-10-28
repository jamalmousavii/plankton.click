import Head from 'next/head';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useLanguage } from '../i18n/LanguageContext';
import Link from 'next/link';
import Navbar from '../components/Navbar';
import PlanktonField from '../components/PlanktonField';
import { LogoMark } from '../components/Logo';
import PlansContent from '../components/PlansContent';
import PlansModal from '../components/PlansModal';
import Sidebar from '../components/chat/Sidebar';
import MessageList from '../components/chat/MessageList';
import Composer from '../components/chat/Composer';
import { apiFetch, ApiError } from '../utils/api';
import { audioBlobToWav16k } from '../lib/audio';
import { chatModels, sortModels, topOnlineModel, workerCount } from '../utils/models';

const AUTO_RETRY_MAX = 3;
const AUTO_RETRY_MS = 10000;
const MODELS_REFRESH_MS = 30000;

const MAX_RAW_BYTES = 1.5 * 1024 * 1024;   // pdf/text/audio budget (audio is WAVed after this check)
const IMAGE_MAX_EDGE = 1280;               // client-side image compression target
const TEXT_FILE_RE = /\.(txt|md|csv|json|js|jsx|ts|tsx|py|java|c|h|cpp|hpp|cs|go|rs|rb|php|sh|sql|yml|yaml|xml|html|css|log|ini|cfg|conf|toml)$/i;

// Downscale + JPEG-compress an image so a phone photo fits the ~1.5MB
// attachment budget before it ever leaves the browser.
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      if (base64.length > 4000000) { reject(new Error('image-too-large')); return; }
      resolve({ mime: 'image/jpeg', data: base64 });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image-load-failed')); };
    img.src = url;
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('file-read-failed'));
    reader.readAsDataURL(file);
  });
}

export default function Home() {
  const { t, lang } = useLanguage();
  const [message, setMessage] = useState('');
  const [chat, setChat] = useState([]);
  const [loading, setLoading] = useState(false);
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState('llama3.1:8b');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);
  const messagesRef = useRef(null);
  const inputRef = useRef(null);
  const instantScrollRef = useRef(false);

  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  // F8: a ref mirrors activeSessionId synchronously — async responses read it
  // when they complete instead of the stale render-time closure they were
  // created in (the old chat-clobbering race).
  const activeSessionRef = useRef(null);
  // Bumped on every session switch; in-flight loads check it and bail.
  const loadSeqRef = useRef(0);
  const sendAbortRef = useRef(null);
  const setActiveSession = useCallback((sid) => {
    activeSessionRef.current = sid;
    setActiveSessionId(sid);
    loadSeqRef.current += 1;
    // Switching threads kills the answer bound for the old one: it is already
    // stored server-side and reappears when the user comes back.
    if (sendAbortRef.current) { sendAbortRef.current.abort(); sendAbortRef.current = null; }
  }, []);
  const [subject, setSubject] = useState('');
  const [editingSubject, setEditingSubject] = useState(false);
  const [subjectInput, setSubjectInput] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [token, setToken] = useState(null);

  // v3.28.0 — Upgrade surfaces: the 402 wall (upgrade_wall message) and the
  // once-per-day upsell banner after a wallet-paid message. Both carry the
  // plan catalog ({plans, token_bundle}) from the backend.
  const [upgradeNotice, setUpgradeNotice] = useState(null); // { plans, token_bundle } | null
  const [quotaNotice, setQuotaNotice] = useState(null); // v3.42.1: 'low' | 'exhausted' | null (once/day each)
  // v3.40.0 — auto-switch notice when the selected model loses its workers.
  const [modelNotice, setModelNotice] = useState('');
  // Live mirrors for timers/intervals (F8-style: async work reads refs).
  const chatRef = useRef([]);
  chatRef.current = chat;
  const selectedModelRef = useRef(selectedModel);
  selectedModelRef.current = selectedModel;
  const dropdownOpenRef = useRef(dropdownOpen);
  dropdownOpenRef.current = dropdownOpen;
  const retryTimersRef = useRef([]);
  const [purchaseError, setPurchaseError] = useState('');
  const [bundleAmount, setBundleAmount] = useState('5'); // whole dollars for the token bundle
  // v3.45.0 — double-click guard: a synchronous ref lock (state alone can't
  // stop two clicks in the same tick) plus `purchaseBusy` for the button UI.
  const [purchaseBusy, setPurchaseBusy] = useState(null); // tier | 'tokens' | null
  const purchaseLockRef = useRef(false);

  // v3.29.0 — public pricing section on the empty-state homepage. The catalog
  // endpoint uses optionalAuth, so a logged-in visitor gets their active plan
  // back with the same response.
  const [catalog, setCatalog] = useState(null); // GET /api/plans → { plans, plan, token_bundle, ... }
  const [planHint, setPlanHint] = useState('');

  // Attachments & voice (v3.20.0): one pending attachment per message.
  const [attachment, setAttachment] = useState(null); // { type, name, mime, data }
  const [attachError, setAttachError] = useState('');
  const [recording, setRecording] = useState(false);
  const fileInputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const recChunksRef = useRef([]);
  const recTimerRef = useRef(null);

  const hasStarted = chat.length > 0;

  // v3.30.0 — pricing modal: `/#plans` opens it in any homepage state (deep
  // link on mount, hashchange, or the Navbar ⭐ Plans custom event).
  const [plansOpen, setPlansOpen] = useState(false);

  const closePlans = () => {
    setPlansOpen(false);
    if (window.location.hash === '#plans') {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  };

  // Capability gates — mirror backend models.js flags. Attach (📎) is off for
  // embedding models entirely; images additionally require a vision-capable
  // model and voice notes an audio-capable one (gemma4:12b).
  const selectedModelData = models.find(m => m.id === selectedModel);
  const attachFileAllowed = !!selectedModelData && selectedModelData.category !== 'embedding';
  const visionOk = !!(selectedModelData && selectedModelData.vision);
  const audioOk = !!(selectedModelData && selectedModelData.audio);

  useEffect(() => {
    fetchModels();
    const savedToken = localStorage.getItem('token');
    if (savedToken) {
      setToken(savedToken);
      setIsLoggedIn(true);
      fetchSessions(savedToken);
      fetchCatalog();
    } else {
      fetchCatalog();
    }
    // v3.29.1 — any 401 anywhere clears the session (apiFetch); keep this
    // page's auth state in sync so it stops pretending to be logged in.
    const onAuthChanged = () => {
      const tk = localStorage.getItem('token');
      setToken(tk);
      setIsLoggedIn(!!tk);
    };
    window.addEventListener('plankton:auth-changed', onAuthChanged);
    return () => window.removeEventListener('plankton:auth-changed', onAuthChanged);
  }, []);

  // v3.40.0 — keep worker counts fresh so the dropdown sort stays truthful.
  // Skipped while the picker is open (no reordering mid-selection) and
  // always cleaned up on unmount, like the retry timers below.
  useEffect(() => {
    const id = setInterval(() => { if (!dropdownOpenRef.current) fetchModels(); }, MODELS_REFRESH_MS);
    return () => {
      clearInterval(id);
      retryTimersRef.current.forEach((tm) => clearTimeout(tm));
      retryTimersRef.current = [];
    };
  }, []);

  // v3.30.0 — three triggers for the pricing modal: deep link with #plans on
  // mount, a hashchange, or Navbar dispatching plankton:show-plans (avoids
  // Next.js same-path hash quirks). setPlansOpen(true) is idempotent.
  useEffect(() => {
    if (window.location.hash === '#plans') setPlansOpen(true);
    const onHash = () => { if (window.location.hash === '#plans') setPlansOpen(true); };
    const onShow = () => setPlansOpen(true);
    window.addEventListener('hashchange', onHash);
    window.addEventListener('plankton:show-plans', onShow);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('plankton:show-plans', onShow);
    };
  }, []);

  useEffect(() => {
    const handler = (e) => { if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setDropdownOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const scrollToBottom = (instant = false) => {
    const el = messagesRef.current;
    if (!el) return;
    if (instant) {
      // After a paint (and a second frame for layout) so refreshed/loaded
      // sessions land on the latest message even before fonts settle.
      requestAnimationFrame(() => requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; }));
    } else {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  };

  // Always show the latest message: instantly on session load / refresh,
  // smoothly on every new message or typing indicator — even if the user
  // scrolled up while waiting for the reply.
  useEffect(() => {
    if (chat.length === 0) return;
    const instant = instantScrollRef.current;
    instantScrollRef.current = false;
    scrollToBottom(instant);
    // activeSessionId: switching to a session with the SAME message count
    // must still snap the view to that session's latest message (F14).
  }, [chat.length, loading, activeSessionId]);

  // Window resize / orientation change re-fits the viewport frame — snap the
  // chat back to the newest message so the latest reply stays visible.
  useEffect(() => {
    const onViewportChange = () => scrollToBottom(true);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('orientationchange', onViewportChange);
    return () => {
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('orientationchange', onViewportChange);
    };
  }, []);

  // Mobile keyboard (v3.23.0): iOS overlays the keyboard on top of the layout
  // viewport — the 100dvh frame does NOT shrink, so the composer ends up under
  // the keyboard with no scrollable ancestor to reveal it. While a field is
  // focused, fit the frame to the *visual* viewport via CSS vars consumed by
  // _app.js; released as soon as focus leaves.
  useEffect(() => {
    const vv = window.visualViewport;
    const FIELDS = ['INPUT', 'TEXTAREA'];
    const apply = () => {
      const focused = document.activeElement && FIELDS.includes(document.activeElement.tagName);
      if (vv && focused) {
        document.documentElement.style.setProperty('--app-vv-height', `${vv.height}px`);
        document.documentElement.style.setProperty('--app-vv-shift', `${vv.offsetTop}px`);
        scrollToBottom(true);
      } else {
        document.documentElement.style.removeProperty('--app-vv-height');
        document.documentElement.style.removeProperty('--app-vv-shift');
      }
    };
    vv?.addEventListener('resize', apply);
    vv?.addEventListener('scroll', apply);
    document.addEventListener('focusin', apply);
    document.addEventListener('focusout', apply);
    return () => {
      vv?.removeEventListener('resize', apply);
      vv?.removeEventListener('scroll', apply);
      document.removeEventListener('focusin', apply);
      document.removeEventListener('focusout', apply);
      document.documentElement.style.removeProperty('--app-vv-height');
      document.documentElement.style.removeProperty('--app-vv-shift');
    };
  }, []);

  // Keep the input ready for the next message: refocus when a reply lands
  // or a session is loaded, but never steal focus from another field
  // (subject rename input, dropdown) — activeElement is only body when the
  // user is not typing anywhere. Never on touch: refocusing would pop the
  // keyboard open again after every reply.
  useEffect(() => {
    if (loading || dropdownOpen) return;
    if (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches) return;
    const active = document.activeElement;
    if (!active || active === document.body) inputRef.current?.focus();
  }, [loading, hasStarted, dropdownOpen]);

  // Unmount cleanup for the recording auto-stop timer.
  useEffect(() => () => clearTimeout(recTimerRef.current), []);

  // Desktop-only initial focus: autoFocus on phones would open the on-screen
  // keyboard during first paint and squeeze the hero out of the fixed frame.
  useEffect(() => {
    if (typeof window !== 'undefined' && window.innerWidth >= 768) inputRef.current?.focus();
  }, []);

  // Plan/token purchase: one NowPayments invoice per purchase; activation or
  // pot credit happens in the IPN webhook. Hosted checkout opens in a new tab.
  // v3.45.0: synchronous lock + busy state so a double-click can never fire
  // two invoices (the server also 409s within a 90s window).
  const purchasePlan = useCallback(async (tier) => {
    if (!token || purchaseLockRef.current) return;
    purchaseLockRef.current = true;
    setPurchaseBusy(tier);
    setPurchaseError('');
    try {
      const data = await apiFetch(`/api/plans/${tier}/purchase`, { method: 'POST' });
      if (data.success && data.invoice?.url) {
        window.open(data.invoice.url, '_blank', 'noopener');
      } else {
        setPurchaseError(data.error || t('chat.errorResponse'));
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setPurchaseError(t('home.loginToBuy'));
      else setPurchaseError(err instanceof ApiError ? err.message : t('chat.errorConnection'));
    } finally {
      purchaseLockRef.current = false;
      setPurchaseBusy(null);
    }
  }, [token, t]);

  // Token bundle (whole dollars, never expires; rate comes from the API).
  const purchaseTokens = useCallback(async () => {
    if (!token || purchaseLockRef.current) return;
    const amount = parseInt(bundleAmount, 10);
    if (!(amount >= 1 && amount <= 500)) {
      setPurchaseError(t('chat.bundleRange'));
      return;
    }
    purchaseLockRef.current = true;
    setPurchaseBusy('tokens');
    setPurchaseError('');
    try {
      const data = await apiFetch('/api/plans/tokens/purchase', {
        method: 'POST',
        body: JSON.stringify({ amount_usd: amount }),
      });
      if (data.success && data.invoice?.url) {
        window.open(data.invoice.url, '_blank', 'noopener');
      } else {
        setPurchaseError(data.error || t('chat.errorResponse'));
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setPurchaseError(t('home.loginToBuy'));
      else setPurchaseError(err instanceof ApiError ? err.message : t('chat.errorConnection'));
    } finally {
      purchaseLockRef.current = false;
      setPurchaseBusy(null);
    }
  }, [token, t, bundleAmount]);

  const dismissUpgradeNotice = () => {
    try { localStorage.setItem('plankton_upg_notice', new Date().toISOString().slice(0, 10)); } catch (e) {}
    setUpgradeNotice(null);
  };

  // v3.29.0 — homepage pricing: public catalog (+ personal plan when logged in).
  // v3.29.1 — goes through apiFetch; on a 401 (expired token) the session is
  // cleared and the catalog is retried as a guest so pricing always renders.
  const fetchCatalog = async () => {
    try {
      const data = await apiFetch('/api/plans');
      if (data.success) setCatalog(data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        try {
          const guest = await fetch('/api/plans').then((r) => r.json());
          if (guest.success) setCatalog(guest);
        } catch (e) {}
      }
    }
  };

  const handlePlanBuy = (tier) => {
    if (!token) { setPlanHint(t('home.loginToBuy')); return; }
    setPlanHint('');
    purchasePlan(tier);
  };

  const handleBundleBuy = () => {
    if (!token) { setPlanHint(t('home.loginToBuy')); return; }
    setPlanHint('');
    purchaseTokens();
  };

  const clearRetryTimers = () => {
    retryTimersRef.current.forEach((tm) => clearTimeout(tm));
    retryTimersRef.current = [];
  };

  const fetchModels = async () => {
    try {
      const res = await fetch('/api/models');
      const data = await res.json();
      if (!data.success) return;
      // Busiest model first (shared util, stable for ties).
      const sorted = sortModels(chatModels(data.models));
      setModels(sorted);
      // v3.40.0 auto-switch: the selected model has no workers but others
      // do — move to the busiest online one instead of 409ing every send.
      // Offline rows are not selectable, so this never fights a manual pick.
      const cur = selectedModelRef.current;
      const curData = sorted.find((m) => m.id === cur);
      if ((!curData || workerCount(curData) === 0)) {
        const top = topOnlineModel(sorted);
        if (top && top.id !== cur) {
          setSelectedModel(top.id);
          try {
            setModelNotice(t('chat.switchedNotice').replace('{model}', top.name));
          } catch (e) {}
        }
      }
    } catch (err) { console.error('Failed to load models'); }
  };

  const fetchSessions = async (tkn) => {
    try {
      const data = await apiFetch('/api/chat/sessions');
      if (data.success) {
        setSessions(data.sessions);
        if (data.sessions.length > 0 && !activeSessionId) {
          loadSession(data.sessions[0].id, tkn);
        }
      }
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) console.error('Failed to load sessions');
    }
  };

  const loadSession = useCallback(async (sessionId, tkn) => {
    const useToken = tkn || token;
    if (!useToken) return;
    const seq = ++loadSeqRef.current;
    try {
      const data = await apiFetch(`/api/chat/sessions/${sessionId}`);
      if (seq !== loadSeqRef.current) return; // F8: superseded by a newer switch
      if (data.success) {
        setActiveSession(sessionId);
        setSubject(data.session.subject || t('chat.newChat'));
        // Mobile drawer: picking a session closes the overlay so the chat is visible.
        setSidebarOpen(false);
        const msgs = [];
        data.messages.forEach(m => {
          if (m.content !== null && m.content !== undefined) {
            msgs.push({ role: m.role, content: m.content, media: m.media || null });
          }
        });
        instantScrollRef.current = true;
        setChat(msgs);
      }
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) console.error('Failed to load session');
    }
  }, [token, t, setActiveSession]);

  const createNewSession = useCallback(async () => {
    if (!token) {
      setActiveSession(null);
      setSubject('');
      setChat([]);
      return;
    }
    try {
      const data = await apiFetch('/api/chat/sessions', {
        method: 'POST',
        body: JSON.stringify({ subject: t('chat.newChat'), model: selectedModel })
      });
      if (data.success) {
        setSessions(prev => [data.session, ...prev]);
        setActiveSession(data.session.id);
        setSubject(data.session.subject);
        setChat([]);
      }
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) console.error('Failed to create session');
    }
  }, [token, t, selectedModel, setActiveSession]);

  const deleteSession = useCallback(async (sessionId) => {
    if (!token) return;
    try {
      // Only drop the row if the server actually deleted it — a failed DELETE
      // used to vanish optimistically and come back after the next refresh.
      await apiFetch(`/api/chat/sessions/${sessionId}`, { method: 'DELETE' });
      setSessions(prev => prev.filter(s => s.id !== sessionId));
      if (activeSessionId === sessionId) {
        const remaining = sessions.filter(s => s.id !== sessionId);
        if (remaining.length > 0) {
          loadSession(remaining[0].id);
        } else {
          setActiveSession(null);
          setSubject('');
          setChat([]);
        }
      }
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) console.error('Failed to delete session');
    }
  }, [token, activeSessionId, sessions, loadSession, setActiveSession]);

  const updateSubject = async () => {
    if (!token || !activeSessionId || !subjectInput.trim()) return;
    try {
      await apiFetch(`/api/chat/sessions/${activeSessionId}`, {
        method: 'PUT',
        body: JSON.stringify({ subject: subjectInput.trim() })
      });
      setSubject(subjectInput.trim());
      setEditingSubject(false);
      setSessions(prev => prev.map(s =>
        s.id === activeSessionId ? { ...s, subject: subjectInput.trim() } : s
      ));
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) console.error('Failed to update subject');
    }
  };

  const removeAttachment = () => {
    setAttachment(null);
    setAttachError('');
  };

  const onPickFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    setAttachError('');
    try {
      if (file.type && file.type.startsWith('image/')) {
        const { mime, data } = await compressImage(file);
        setAttachment({ type: 'image', name: file.name || 'image.jpg', mime, data });
      } else if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf') || TEXT_FILE_RE.test(file.name)) {
        if (file.size > MAX_RAW_BYTES) {
          setAttachError(t('chat.attachTooLarge'));
          return;
        }
        const data = await fileToBase64(file);
        setAttachment({ type: 'file', name: file.name, mime: file.type || 'text/plain', data });
      } else {
        setAttachError(t('chat.attachUnsupported'));
      }
    } catch (err) {
      setAttachError(err && err.message === 'image-too-large' ? t('chat.attachTooLarge') : t('chat.attachFailed'));
    }
  };

  const startRecording = async () => {
    if (!audioOk || recording) return;
    setAttachError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      recChunksRef.current = [];
      mr.ondataavailable = (ev) => { if (ev.data && ev.data.size) recChunksRef.current.push(ev.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach(tr => tr.stop());
        clearTimeout(recTimerRef.current);
        setRecording(false);
        const blob = new Blob(recChunksRef.current, { type: mr.mimeType || 'audio/webm' });
        recChunksRef.current = [];
        try {
          const { base64, duration } = await audioBlobToWav16k(blob);
          if (duration > 60) { setAttachError(t('chat.voiceTooLong')); return; }
          setAttachment({ type: 'audio', name: 'voice.wav', mime: 'audio/wav', data: base64 });
        } catch (convErr) {
          const code = convErr && convErr.message;
          setAttachError(
            code === 'audio-too-long' ? t('chat.voiceTooLong')
            : code === 'audio-too-short' ? t('chat.voiceTooShort')
            : t('chat.voiceFailed')
          );
        }
      };
      mr.start();
      mediaRecorderRef.current = mr;
      setRecording(true);
      // Hard cap: stop at 60s (Ollama/backend budget for one voice note).
      recTimerRef.current = setTimeout(() => {
        if (mr.state === 'recording') mr.stop();
      }, 60000);
    } catch (err) {
      setAttachError(t('chat.micDenied'));
    }
  };

  const stopRecording = () => {
    clearTimeout(recTimerRef.current);
    const mr = mediaRecorderRef.current;
    if (mr && mr.state === 'recording') mr.stop();
  };

  // v3.40.0 worker-only flow: failed sends live on as bubbles the user can
  // retry or re-target, instead of vanishing into a generic error line.
  const replaceBubble = (id, patch) =>
    setChat((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));

  const applyReplyBubble = (id, data) =>
    replaceBubble(id, {
      content: data.response,
      source: data.source || null,
      worker_id: data.worker_id || null,
      payment_status: data.payment_status || null,
      waiting: undefined,
      model_switch: undefined,
    });

  const scheduleAutoRetry = (id) => {
    const timer = setTimeout(() => attemptResend(id, true), AUTO_RETRY_MS);
    retryTimersRef.current.push(timer);
  };

  const attemptResend = async (id, isAuto) => {
    const msg = chatRef.current.find((m) => m.id === id);
    if (!msg || !msg.waiting) return;
    const attempts = msg.waiting.attempts || 0;
    if (attempts >= AUTO_RETRY_MAX) {
      replaceBubble(id, { waiting: { ...msg.waiting, auto: false } });
      return;
    }
    // Auto-retries stop if the user moved threads (F8 spirit); manual
    // retries always go through against the current session.
    if (isAuto && msg.waiting.sessionId !== activeSessionRef.current) {
      replaceBubble(id, { waiting: { ...msg.waiting, auto: false } });
      return;
    }
    replaceBubble(id, { waiting: { ...msg.waiting, attempts: attempts + 1, auto: isAuto } });
    try {
      const data = await apiFetch('/api/chat', {
        method: 'POST',
        body: JSON.stringify({ ...msg.waiting.payload, session_id: activeSessionRef.current }),
      });
      if (data.success) {
        applyReplyBubble(id, data);
        if (data.session_id) fetchSessions(token);
      } else if (data && data.code === 'WORKER_OFFLINE') {
        if (attempts + 1 < AUTO_RETRY_MAX) scheduleAutoRetry(id);
        else replaceBubble(id, { waiting: { ...msg.waiting, attempts: attempts + 1, auto: false } });
      } else {
        replaceBubble(id, {
          content: (data && data.error) || t('chat.errorResponse'),
          waiting: undefined,
        });
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 503 && err.data && err.data.code === 'WORKER_OFFLINE') {
        if (attempts + 1 < AUTO_RETRY_MAX) scheduleAutoRetry(id);
        else replaceBubble(id, { waiting: { ...msg.waiting, attempts: attempts + 1, auto: false } });
      } else if (err instanceof ApiError && err.data && err.data.error) {
        replaceBubble(id, { content: err.data.error, waiting: undefined });
      } else {
        replaceBubble(id, { content: t('chat.errorConnection'), waiting: undefined });
      }
    }
  };

  const onRetryWaiting = (id) => {
    const msg = chatRef.current.find((m) => m.id === id);
    if (!msg || !msg.waiting) return;
    replaceBubble(id, { waiting: { ...msg.waiting, attempts: 0, auto: false } });
    attemptResend(id, false);
  };

  const onDismissFailed = (id) =>
    setChat((prev) => prev.filter((m) => m.id !== id));

  const onSwitchModel = (id, modelId) => {
    const msg = chatRef.current.find((m) => m.id === id);
    if (!msg || !msg.model_switch) return;
    setSelectedModel(modelId);
    const payload = { ...msg.model_switch.payload, model: modelId };
    // Re-target as a waiting send so further 503s get the retry treatment.
    replaceBubble(id, {
      content: t('chat.waitDesc'),
      model_switch: undefined,
      waiting: { payload, sessionId: activeSessionRef.current, attempts: 0, auto: false },
    });
    attemptResend(id, false);
  };

  const sendMessage = async () => {
    if (loading) return;
    if (!message.trim() && !attachment) return;
    // A fresh send cancels pending auto-retries (their thread may be stale).
    clearRetryTimers();

    // Capability gates — never send an attachment the model cannot answer.
    if (attachment) {
      if (!attachFileAllowed) { setAttachError(t('chat.attachEmbedding')); return; }
      if (attachment.type === 'image' && !visionOk) { setAttachError(t('chat.needVisionModel')); return; }
      if (attachment.type === 'audio' && !audioOk) { setAttachError(t('chat.needAudioModel')); return; }
    }

    const userMessage = message;
    const sentAttachment = attachment;
    const sentModel = selectedModel;
    setMessage('');
    setAttachment(null);
    setAttachError('');
    setChat(prev => [...prev, {
      role: 'user',
      content: userMessage,
      media: sentAttachment ? { type: sentAttachment.type, name: sentAttachment.name, mime: sentAttachment.mime, data: sentAttachment.data } : null,
    }]);
    setLoading(true);
    inputRef.current?.focus();

    // F8: capture the thread this reply belongs to, and a controller so a
    // session switch can cancel the request instead of letting it land in
    // whatever thread the user is reading by then.
    const sessionAtSend = activeSessionRef.current;
    if (sendAbortRef.current) sendAbortRef.current.abort();
    const controller = new AbortController();
    sendAbortRef.current = controller;

    try {
      const data = await apiFetch('/api/chat', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          message: userMessage,
          model: selectedModel,
          session_id: sessionAtSend,
          ...(sentAttachment ? { attachment: sentAttachment } : {}),
        }),
      });
      // The user changed threads while this was in flight: the reply is
      // already stored server-side — never append it to the wrong chat.
      if (sessionAtSend !== activeSessionRef.current) return;
      if (data.success) {
        setChat(prev => [...prev, {
          role: 'assistant',
          content: data.response,
          source: data.source || null,
          worker_id: data.worker_id || null,
          payment_status: data.payment_status || null,
        }]);
        // Wallet-funded reply → suggest plans (once per UTC day, dismissible).
        if (data.notice === 'upgrade_recommended') {
          try {
            const today = new Date().toISOString().slice(0, 10);
            if (localStorage.getItem('plankton_upg_notice') !== today) {
              setUpgradeNotice({ plans: data.plans || [], token_bundle: data.token_bundle || null });
            }
          } catch (e) {}
        }
        // v3.42.1 — free-quota notices: low warning and exhausted info, each
        // once per UTC day. Read-only flags from the backend, never inferred.
        if (data.free_exhausted || data.free_low) {
          try {
            const today = new Date().toISOString().slice(0, 10);
            const kind = data.free_exhausted ? 'exhausted' : 'low';
            const key = data.free_exhausted ? 'plankton_free_done' : 'plankton_free_low';
            if (localStorage.getItem(key) !== today) {
              localStorage.setItem(key, today);
              setQuotaNotice(kind);
            }
          } catch (e) {}
        }
        if (data.session_id && !sessionAtSend) {
          setActiveSession(data.session_id);
          fetchSessions(token);
        } else if (data.session_id && sessionAtSend) {
          fetchSessions(token);
        }
      } else {
        setChat(prev => [...prev, { role: 'assistant', content: data.error || t('chat.errorResponse') }]);
      }
    } catch (err) {
      if (sessionAtSend !== activeSessionRef.current || (err && err.name === 'AbortError')) {
        // F8: aborted by a session switch (or the stale thread already moved
        // on) — there is no chat to append the failure to.
      } else if (err instanceof ApiError && err.status === 401) {
        // apiFetch already cleared the session + fired plankton:auth-expired;
        // the backend now 401s bad bearers instead of answering as a guest,
        // so tell the user why the reply never came.
        setChat(prev => [...prev, { role: 'assistant', content: t('chat.errorSessionExpired') }]);
      } else if (err instanceof ApiError && err.status === 402 && err.data && err.data.code === 'upgrade_required') {
        // v3.28.0 wall: no free allowance, no credit, empty pot, empty wallet.
        const wall = err.data;
        setChat(prev => [...prev, {
          role: 'assistant',
          content: t('chat.upgradeDesc'),
          upgrade_wall: {
            signed_in: !!wall.signed_in,
            plans: wall.plans || [],
            token_bundle: wall.token_bundle || null,
            free: wall.free,
          },
        }]);
      } else if (err instanceof ApiError && err.status === 503 && err.data && err.data.code === 'WORKER_OFFLINE') {
        // v3.40.0: no workers online — waiting bubble with auto-retry.
        const failId = `w${Date.now()}${Math.floor(Math.random() * 1e6)}`;
        const payload = {
          message: userMessage,
          model: sentModel,
          ...(sentAttachment ? { attachment: sentAttachment } : {}),
        };
        setChat(prev => [...prev, {
          id: failId,
          role: 'assistant',
          content: (err.data && err.data.error) || t('chat.waitDesc'),
          waiting: { payload, sessionId: sessionAtSend, attempts: 0, auto: true },
        }]);
        scheduleAutoRetry(failId);
      } else if (err instanceof ApiError && err.status === 409 && err.data && err.data.code === 'MODEL_UNAVAILABLE') {
        // v3.40.0: exact-model rule — offer a switch, never substitute silently.
        const failId = `s${Date.now()}${Math.floor(Math.random() * 1e6)}`;
        setChat(prev => [...prev, {
          id: failId,
          role: 'assistant',
          content: (err.data && err.data.error) || t('chat.noModelDesc').replace('{model}', sentModel),
          model_switch: {
            requested: (err.data && err.data.requested_model) || sentModel,
            alternatives: (err.data && err.data.alternatives) || [],
            payload: {
              message: userMessage,
              model: sentModel,
              ...(sentAttachment ? { attachment: sentAttachment } : {}),
            },
          },
        }]);
      } else if (err instanceof ApiError && err.data && err.data.error) {
        setChat(prev => [...prev, { role: 'assistant', content: err.data.error }]);
      } else {
        setChat(prev => [...prev, { role: 'assistant', content: t('chat.errorConnection') }]);
      }
    } finally {
      setLoading(false);
      if (sendAbortRef.current === controller) sendAbortRef.current = null;
    }
  };

  // ===== EMPTY STATE: centered hero =====
  if (!hasStarted) {
    return (
      <div className="flex-1 page-surface flex flex-col">
        <Head>
          <title>Plankton Network - Decentralized LLM Inference</title>
          <meta name="description" content="Decentralized LLM Inference Network. Chat with AI models." />
        </Head>

        <Navbar />

        <main className="relative flex-1 flex flex-col items-center justify-center px-4 pb-16 overflow-hidden">
          <PlanktonField />
          <div className="relative text-center mb-8 md:mb-10 animate-rise">
            <span className="chip mb-5">
              <span className="w-1.5 h-1.5 rounded-full bg-glow shadow-[0_0_10px_#7cf5c6] animate-pulse-glow" />
              {t('home.title')}
            </span>
            <h1 className="flex items-center justify-center gap-3 text-5xl md:text-7xl font-bold tracking-tight mb-3">
              <LogoMark size={56} className="hidden sm:block drop-shadow-[0_8px_24px_rgba(23,152,163,0.45)]" />
              <span className="text-bioluminescent">plankton</span>
            </h1>
            <p className="text-lg md:text-xl text-gray-500 max-w-xl mx-auto">{t('home.subtitle')}</p>
          </div>

          <div className="relative w-full max-w-2xl animate-rise" style={{ animationDelay: '80ms' }}>
            <Composer
              variant="hero"
              t={t}
              message={message}
              setMessage={setMessage}
              sendMessage={sendMessage}
              loading={loading}
              models={models}
              selectedModel={selectedModel}
              selectedModelData={selectedModelData}
              setSelectedModel={setSelectedModel}
              dropdownOpen={dropdownOpen}
              setDropdownOpen={setDropdownOpen}
              dropdownRef={dropdownRef}
              inputRef={inputRef}
              fileInputRef={fileInputRef}
              onPickFile={onPickFile}
              attachFileAllowed={attachFileAllowed}
              audioOk={audioOk}
              recording={recording}
              startRecording={startRecording}
              stopRecording={stopRecording}
              attachment={attachment}
              removeAttachment={removeAttachment}
              attachError={attachError}
            />
          </div>

          <div className="relative mt-6 flex flex-wrap items-center justify-center gap-2 text-sm">
            <span className="text-gray-400">{t('chat.startTyping')}</span>
            <Link href="/worker" className="chip hover:border-sky-400 hover:text-sky-900 transition">
              🖥️ {t('home.becomeWorker')} →
            </Link>
          </div>

          {/* v3.29.0 — public pricing inline (empty state only); v3.30.0 — cards
              live in PlansContent and also open as a modal via #plans.
              v3.42.1 — the inline section is desktop-only: inside the
              non-scrolling chat frame it clips on phones, so mobile gets a
              compact card that opens the (internally scrolling) modal. */}
          {catalog?.plans?.length > 0 && (
            <>
              <section id="plans" className="hidden md:block w-full max-w-4xl mt-8 md:mt-10">
                <PlansContent
                  catalog={catalog}
                  planHint={planHint}
                  purchaseError={purchaseError}
                  purchaseBusy={purchaseBusy}
                  bundleAmount={bundleAmount}
                  setBundleAmount={setBundleAmount}
                  onBuyPlan={handlePlanBuy}
                  onBuyBundle={handleBundleBuy}
                />
              </section>
              <div className="md:hidden w-full max-w-4xl mt-6">
                <button
                  onClick={() => setPlansOpen(true)}
                  className="w-full flex items-center justify-between gap-2 bg-white border border-violet-200 rounded-2xl px-4 py-3.5 shadow-sm active:bg-violet-50 transition min-h-[56px]"
                >
                  <span className="text-sm font-bold text-gray-800">⭐ {t('home.pricingTitle')}</span>
                  <span className="text-violet-600 text-xs font-bold">{t('home.pricingOpen')} →</span>
                </button>
              </div>
            </>
          )}
        </main>

        <PlansModal
          open={plansOpen}
          onClose={closePlans}
          catalog={catalog}
          planHint={planHint}
          purchaseError={purchaseError}
          purchaseBusy={purchaseBusy}
          bundleAmount={bundleAmount}
          setBundleAmount={setBundleAmount}
          onBuyPlan={handlePlanBuy}
          onBuyBundle={handleBundleBuy}
        />
      </div>
    );
  }

  // ===== ACTIVE STATE: sidebar + messages + bottom input =====
  return (
    <div className="flex-1 min-h-0 page-surface flex flex-col">
      <Head><title>{t('chat.title')}</title></Head>

      <Navbar />

      <main className="flex-1 container mx-auto px-2 md:px-6 pb-[max(1rem,env(safe-area-inset-bottom))] md:pb-6 max-w-6xl flex gap-0 md:gap-4 min-h-0">
        <Sidebar
          t={t}
          isLoggedIn={isLoggedIn}
          sidebarOpen={sidebarOpen}
          setSidebarOpen={setSidebarOpen}
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelect={loadSession}
          onNewChat={createNewSession}
          onDelete={deleteSession}
        />

        {/* Chat area */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* Subject bar */}
          {isLoggedIn && activeSessionId && (
            <div className="bg-white border border-b-0 border-gray-200/80 rounded-t-2xl px-4 py-2.5 flex items-center gap-2 mb-0 shadow-sm">
              {isLoggedIn && !sidebarOpen && (
                <button onClick={() => setSidebarOpen(true)} className="md:hidden flex items-center justify-center text-gray-400 hover:text-sky-600 min-w-[40px] min-h-[40px] -my-2 -ml-2 mr-1 text-lg">☰</button>
              )}
              {editingSubject ? (
                <input
                  type="text"
                  value={subjectInput}
                  onChange={(e) => setSubjectInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) updateSubject(); if (e.key === 'Escape') setEditingSubject(false); }}
                  onBlur={updateSubject}
                  autoFocus
                  className="flex-1 bg-sky-50 text-gray-800 border border-sky-200 px-3 py-1 rounded text-sm focus:outline-none focus:ring-1 focus:ring-sky-400"
                  placeholder={t('chat.subjectPlaceholder')}
                />
              ) : (
                <>
                  <span className="text-gray-700 text-sm font-medium truncate">{subject || t('chat.untitled')}</span>
                  <button
                    onClick={() => { setSubjectInput(subject); setEditingSubject(true); }}
                    className="flex items-center justify-center text-gray-400 hover:text-sky-600 text-sm transition min-w-[40px] min-h-[40px] -my-2"
                    title={t('chat.renameSession')}
                  >
                    ✏️
                  </button>
                </>
              )}
            </div>
          )}

          <MessageList
            messagesRef={messagesRef}
            chat={chat}
            loading={loading}
            lang={lang}
            t={t}
            hasSubjectBar={isLoggedIn && !!activeSessionId}
            purchasePlan={purchasePlan}
            purchaseTokens={purchaseTokens}
            purchaseBusy={purchaseBusy}
            bundleAmount={bundleAmount}
            setBundleAmount={setBundleAmount}
            purchaseError={purchaseError}
            onRetryWaiting={onRetryWaiting}
            onDismissFailed={onDismissFailed}
            onSwitchModel={onSwitchModel}
          />

          {/* v3.40.0 — auto-switch notice when the model lost its workers */}
          {modelNotice && (
            <div className="flex items-center gap-2 mb-2 bg-sky-50 border border-sky-200 text-sky-800 rounded-xl px-3 py-2 text-xs md:text-sm">
              <span className="flex-1">🔀 {modelNotice}</span>
              <button onClick={() => setModelNotice('')} aria-label="dismiss" className="text-sky-500 hover:text-sky-700 px-1.5 font-bold flex-shrink-0">
                ✕
              </button>
            </div>
          )}

          {/* v3.42.1 — free-quota notices (once/day each): low warning + exhausted info */}
          {quotaNotice && (
            <div className={`flex items-center gap-2 mb-2 rounded-xl px-3 py-2 text-xs md:text-sm ${
              quotaNotice === 'exhausted'
                ? 'bg-sky-50 border border-sky-200 text-sky-800'
                : 'bg-amber-50 border border-amber-200 text-amber-800'
            }`}>
              <span className="flex-1">
                {quotaNotice === 'exhausted'
                  ? (isLoggedIn ? t('chat.freeExhausted') : t('chat.freeExhaustedGuest'))
                  : t('chat.freeLow')}
              </span>
              <button onClick={() => setQuotaNotice(null)} aria-label="dismiss"
                className={`px-1.5 font-bold flex-shrink-0 ${quotaNotice === 'exhausted' ? 'text-sky-500 hover:text-sky-700' : 'text-amber-500 hover:text-amber-700'}`}>
                ✕
              </button>
            </div>
          )}

          {/* v3.28.0 — plan upsell after a wallet-paid message (once/day) */}
          {upgradeNotice && (
            <div className="flex items-center gap-2 mb-2 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl px-3 py-2 text-xs md:text-sm">
              <span className="flex-1">
                ⭐ {t('chat.upgradeNotice')}
                {' '}
                {upgradeNotice.plans?.[0] && (
                  t('chat.planRow')
                    .replace('{price}', `$${upgradeNotice.plans[0].price}`)
                    .replace('{tokens}', Number(upgradeNotice.plans[0].daily_tokens).toLocaleString('en-US'))
                )}
                {purchaseError && <span className="block text-red-500">{purchaseError}</span>}
              </span>
              {isLoggedIn && upgradeNotice.plans?.[0] && (
                <button
                  onClick={() => purchasePlan(upgradeNotice.plans[0].name)}
                  disabled={!!purchaseBusy}
                  className="bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 rounded-lg font-bold text-xs transition flex-shrink-0 disabled:opacity-50"
                >
                  ⬆ {upgradeNotice.plans[0].label}
                </button>
              )}
              <button onClick={dismissUpgradeNotice} aria-label="dismiss" className="text-amber-500 hover:text-amber-700 px-1.5 font-bold flex-shrink-0">
                ✕
              </button>
            </div>
          )}
          <Composer
            variant="chat"
            t={t}
            message={message}
            setMessage={setMessage}
            sendMessage={sendMessage}
            loading={loading}
            models={models}
            selectedModel={selectedModel}
            selectedModelData={selectedModelData}
            setSelectedModel={setSelectedModel}
            dropdownOpen={dropdownOpen}
            setDropdownOpen={setDropdownOpen}
            dropdownRef={dropdownRef}
            inputRef={inputRef}
            fileInputRef={fileInputRef}
            onPickFile={onPickFile}
            attachFileAllowed={attachFileAllowed}
            audioOk={audioOk}
            recording={recording}
            startRecording={startRecording}
            stopRecording={stopRecording}
            attachment={attachment}
            removeAttachment={removeAttachment}
            attachError={attachError}
          />
        </div>
      </main>

      <PlansModal
        open={plansOpen}
        onClose={closePlans}
        catalog={catalog}
        planHint={planHint}
        purchaseError={purchaseError}
        purchaseBusy={purchaseBusy}
        bundleAmount={bundleAmount}
        setBundleAmount={setBundleAmount}
        onBuyPlan={handlePlanBuy}
        onBuyBundle={handleBundleBuy}
      />
    </div>
  );
}

import Head from 'next/head';
import Link from 'next/link';
import { useState, useEffect } from 'react';
import { useLanguage } from '../i18n/LanguageContext';
import Navbar from '../components/Navbar';
import EarningsBreakdown from '../components/EarningsBreakdown';
import { useAuth, apiFetch } from '../utils/api';

const CATEGORY_ICONS = { chat: '💻', code: '💻', vision: '👁️', embedding: '🔗' };

// v3.29.0 — the 5 earnings sources shown to prospective workers
const EARNING_SOURCES = [
  { emoji: '🎟️', label: 'profile.bdTokens', bg: 'bg-sky-50', border: 'border-sky-100', color: 'text-sky-700' },
  { emoji: '👛', label: 'profile.bdWallet', bg: 'bg-gray-50', border: 'border-gray-100', color: 'text-gray-600' },
  { emoji: '⭐', label: 'profile.bdPlus',   bg: 'bg-amber-50', border: 'border-amber-100', color: 'text-amber-600' },
  { emoji: '🚀', label: 'profile.bdPro',    bg: 'bg-emerald-50', border: 'border-emerald-100', color: 'text-emerald-600' },
  { emoji: '👑', label: 'profile.bdMax',    bg: 'bg-violet-50', border: 'border-violet-100', color: 'text-violet-600' },
];

export default function Worker() {
  const { t, lang } = useLanguage();
  const [models, setModels] = useState([]);
  const [myRank, setMyRank] = useState(null); // v3.29.0 — real numbers when logged in

  // F1: /worker is a PUBLIC docs page (guest CTA + Navbar link) — never bounce.
  const { user } = useAuth(false);

  useEffect(() => { fetchModels(); }, []);
  useEffect(() => { if (user) fetchRank(); }, [user]);

  const fetchModels = async () => {
    try {
      const res = await fetch('/api/models');
      const data = await res.json();
      if (data.success) setModels(data.models);
    } catch (err) { console.error('Failed to load models'); }
  };

  const fetchRank = async () => {
    try {
      const data = await apiFetch('/api/leaderboard/mine');
      if (data.success && data.breakdown) setMyRank(data);
    } catch (err) {}
  };

  const ubuntuCmd = 'wget https://raw.githubusercontent.com/jamalmousavii/plankton.click/main/worker-app/install-ubuntu.sh && bash install-ubuntu.sh';
  const redhatCmd = 'wget https://raw.githubusercontent.com/jamalmousavii/plankton.click/main/worker-app/install-redhat.sh && bash install-redhat.sh';
  const macosCmd = 'curl -fsSL https://raw.githubusercontent.com/jamalmousavii/plankton.click/main/worker-app/install-macos.sh -o install-macos.sh && bash install-macos.sh';
  const windowsCmd = 'Invoke-WebRequest -Uri https://raw.githubusercontent.com/jamalmousavii/plankton.click/main/worker-app/install-windows.ps1 -OutFile install-windows.ps1';
  const windowsUninstall = 'Invoke-WebRequest -Uri https://raw.githubusercontent.com/jamalmousavii/plankton.click/main/worker-app/uninstall-windows.ps1 -OutFile uninstall-windows.ps1';
  const ubuntuUninstall = 'wget https://raw.githubusercontent.com/jamalmousavii/plankton.click/main/worker-app/uninstall-ubuntu.sh && bash uninstall-ubuntu.sh';
  const redhatUninstall = 'wget https://raw.githubusercontent.com/jamalmousavii/plankton.click/main/worker-app/uninstall-redhat.sh && bash uninstall-redhat.sh';
  const macosUninstall = 'curl -fsSL https://raw.githubusercontent.com/jamalmousavii/plankton.click/main/worker-app/uninstall-macos.sh -o uninstall-macos.sh && bash uninstall-macos.sh';

  const categories = [...new Set(models.map(m => m.category))];

  return (
    <div className={`flex-1 page-surface`}>
      <Head><title>{t('worker.title')}</title></Head>

      <Navbar />

      <main className="container mx-auto px-4 md:px-6 py-6 md:py-12 pb-8">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-2xl md:text-4xl font-bold text-gray-800 text-center mb-3 md:mb-4">🖥️ {t('worker.heading')}</h1>
          <p className="text-center text-gray-500 mb-6 md:mb-8 text-sm md:text-lg">{t('worker.installDocsDesc')}</p>

          <div className="flex flex-wrap gap-3 justify-center mb-8">
            <a href="https://github.com/jamalmousavii/plankton.click" target="_blank" rel="noopener noreferrer"
              className="bg-gray-900 hover:bg-gray-800 text-white px-5 py-2.5 rounded-lg text-sm font-bold transition inline-flex items-center gap-2 min-h-[44px]">
              ⭐ {t('worker.github')}
            </a>
            <a href="https://github.com/jamalmousavii/plankton.click#readme" target="_blank" rel="noopener noreferrer"
              className="bg-white hover:bg-sky-50 text-gray-700 border border-sky-200 px-5 py-2.5 rounded-lg text-sm font-bold transition inline-flex items-center gap-2 min-h-[44px]">
              📖 {t('worker.viewGuide')}
            </a>
          </div>

          {/* Install (docs, no copy buttons) */}
          <div className="bg-white border border-sky-100 shadow-sm rounded-xl p-5 md:p-8 mb-6">
            <h2 className="text-xl md:text-2xl font-bold text-gray-800 mb-4">⚡ {t('worker.installTitle')}</h2>
            <div className="mb-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg">🐧</span>
                <span className="text-gray-800 font-bold text-sm md:text-base">{t('worker.ubuntu')}</span>
              </div>
              <div className="bg-sky-50 border border-sky-100 rounded-lg px-3 md:px-4 py-2 md:py-3 font-mono text-xs md:text-sm text-emerald-700 overflow-x-auto">
                <code>{ubuntuCmd}</code>
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg">🎩</span>
                <span className="text-gray-800 font-bold text-sm md:text-base">{t('worker.redhat')}</span>
              </div>
              <div className="bg-sky-50 border border-sky-100 rounded-lg px-3 md:px-4 py-2 md:py-3 font-mono text-xs md:text-sm text-emerald-700 overflow-x-auto">
                <code>{redhatCmd}</code>
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg">🍎</span>
                <span className="text-gray-800 font-bold text-sm md:text-base">{t('worker.macos')}</span>
              </div>
              <div className="bg-sky-50 border border-sky-100 rounded-lg px-3 md:px-4 py-2 md:py-3 font-mono text-xs md:text-sm text-emerald-700 overflow-x-auto">
                <code>{macosCmd}</code>
              </div>
              <p className="text-gray-400 text-xs mt-1">{t('worker.macosNote')}</p>
            </div>
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg">🪟</span>
                <span className="text-gray-800 font-bold text-sm md:text-base">{t('worker.windows')}</span>
              </div>
              <div className="bg-sky-50 border border-sky-100 rounded-lg px-3 md:px-4 py-2 md:py-3 font-mono text-xs md:text-sm text-emerald-700 overflow-x-auto">
                <code>{windowsCmd}</code>
              </div>
              <p className="text-gray-400 text-xs mt-1">{t('worker.windowsNote')}</p>
            </div>
          </div>

          {/* Connect */}
          <div className="bg-white border border-sky-100 shadow-sm rounded-xl p-5 md:p-8 mb-6">
            <h2 className="text-xl md:text-2xl font-bold text-gray-800 mb-4">🔗 {t('worker.connectTitle')}</h2>
            <ol className="text-gray-600 space-y-3 text-sm md:text-base">
              <li>{t('worker.connectStep1')}</li>
              <li>{t('worker.connectStep2')}</li>
              <li className="bg-sky-50 border border-sky-100 rounded-lg px-3 py-2 font-mono text-xs text-emerald-700 overflow-x-auto">
                {ubuntuCmd} --token YOUR_TOKEN
              </li>
              <li>{t('worker.connectStep3')}</li>
              <li className="text-gray-400">{t('worker.connectStep4')}</li>
            </ol>
          </div>

          {/* Delete / Uninstall */}
          <div className="bg-white border border-sky-100 shadow-sm rounded-xl p-5 md:p-8 mb-6">
            <h2 className="text-xl md:text-2xl font-bold text-gray-800 mb-4">🗑️ {t('worker.deleteTitle')}</h2>
            <p className="text-gray-600 text-sm md:text-base mb-4">{t('worker.deleteFromSite')}</p>
            <p className="text-gray-600 text-sm md:text-base mb-3">{t('worker.deleteFromServer')}</p>
            <div className="space-y-3">
              <div>
                <div className="text-gray-800 font-bold text-sm mb-1">🐧 {t('worker.uninstallUbuntu')}</div>
                <div className="bg-sky-50 border border-sky-100 rounded-lg px-3 py-2 font-mono text-xs text-emerald-700 overflow-x-auto">
                  <code>{ubuntuUninstall}</code>
                </div>
              </div>
              <div>
                <div className="text-gray-800 font-bold text-sm mb-1">🎩 {t('worker.uninstallRedhat')}</div>
                <div className="bg-sky-50 border border-sky-100 rounded-lg px-3 py-2 font-mono text-xs text-emerald-700 overflow-x-auto">
                  <code>{redhatUninstall}</code>
                </div>
              </div>
              <div>
                <div className="text-gray-800 font-bold text-sm mb-1">🍎 {t('worker.uninstallMacos')}</div>
                <div className="bg-sky-50 border border-sky-100 rounded-lg px-3 py-2 font-mono text-xs text-emerald-700 overflow-x-auto">
                  <code>{macosUninstall}</code>
                </div>
              </div>
              <div>
                <div className="text-gray-800 font-bold text-sm mb-1">🪟 {t('worker.uninstallWindows')}</div>
                <div className="bg-sky-50 border border-sky-100 rounded-lg px-3 py-2 font-mono text-xs text-emerald-700 overflow-x-auto">
                  <code>{windowsUninstall}</code>
                </div>
              </div>
            </div>
          </div>

          {/* Model catalog */}
          <div className="bg-white border border-sky-100 shadow-sm rounded-xl p-5 md:p-8 mb-6">
            <h2 className="text-xl md:text-2xl font-bold text-gray-800 mb-2">🤖 {t('worker.selectModels')}</h2>
            <p className="text-gray-500 text-xs md:text-sm mb-4 md:mb-6">{t('worker.selectModelsDesc')}</p>
            {categories.map(cat => (
              <div key={cat} className="mb-4 md:mb-6">
                <h3 className="text-gray-700 font-bold mb-2 md:mb-3 flex items-center gap-2 text-sm md:text-base">
                  <span>{CATEGORY_ICONS[cat]}</span>
                  <span>{cat.charAt(0).toUpperCase() + cat.slice(1)}</span>
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 md:gap-3">
                  {models.filter(m => m.category === cat).map(model => (
                    <div key={model.id} className="text-left p-3 md:p-4 rounded-xl border-2 border-sky-100 bg-white">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-gray-800 font-bold text-xs md:text-sm">{model.name}</span>
                        <span className="text-sky-600 text-xs">{model.size}</span>
                      </div>
                      <p className="text-gray-500 text-xs mb-2 hidden sm:block">{model.desc}</p>
                      <span className="text-gray-400 text-xs">RAM: {model.ram}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Requirements */}
          <div className="bg-white border border-sky-100 shadow-sm rounded-xl p-5 md:p-8 mb-6">
            <h2 className="text-xl md:text-2xl font-bold text-gray-800 mb-4">{t('worker.requirements')}</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-sky-50 rounded-lg p-4 border border-sky-100">
                <h3 className="text-gray-800 font-bold mb-3 text-sm md:text-base">🧑‍💻 {t('worker.userSection')}</h3>
                <p className="text-gray-600 text-sm">{t('worker.userRequirements')}</p>
              </div>
              <div className="bg-sky-50 rounded-lg p-4 border border-sky-100">
                <h3 className="text-gray-800 font-bold mb-3 text-sm md:text-base">🖥️ {t('worker.workerSection')}</h3>
                <p className="text-gray-600 text-sm">{t('worker.workerRequirements')}</p>
              </div>
            </div>
          </div>

          {/* How it works */}
          <div className="bg-white border border-sky-100 shadow-sm rounded-xl p-5 md:p-8 mb-6">
            <h2 className="text-xl md:text-2xl font-bold text-gray-800 mb-4">{t('worker.howItWorks')}</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <h3 className="text-gray-800 font-bold mb-3 text-sm md:text-base">🧑‍💻 {t('worker.userSection')}</h3>
                <ol className="text-gray-600 space-y-3 text-sm md:text-base">
                  {[1,2,3,4].map(n => (
                    <li key={n} className="flex items-start">
                      <span className="bg-sky-500 text-white rounded-full w-7 h-7 md:w-8 md:h-8 flex items-center justify-center mr-3 flex-shrink-0 text-sm">{n}</span>
                      <span>{t(`worker.userStep${n}`)}</span>
                    </li>
                  ))}
                </ol>
              </div>
              <div>
                <h3 className="text-gray-800 font-bold mb-3 text-sm md:text-base">🖥️ {t('worker.workerSection')}</h3>
                <ol className="text-gray-600 space-y-3 text-sm md:text-base">
                  {[1,2,3,4].map(n => (
                    <li key={n} className="flex items-start">
                      <span className="bg-violet-500 text-white rounded-full w-7 h-7 md:w-8 md:h-8 flex items-center justify-center mr-3 flex-shrink-0 text-sm">{n}</span>
                      <span>{t(`worker.workerStep${n}`)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </div>

          {/* v3.29.0 — earnings: flat 90% of every paid message, by source */}
          <div className="bg-white border border-emerald-100 shadow-sm rounded-xl p-5 md:p-8">
            <h2 className="text-xl md:text-2xl font-bold text-gray-800 mb-2">💰 {t('worker.earningsTitle')}</h2>
            <p className="text-emerald-700 font-semibold text-sm md:text-base mb-1">{t('worker.earningsShare')}</p>
            <p className="text-gray-500 text-xs md:text-sm mb-4">{t('worker.earningsDesc')}</p>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-2 md:gap-3 mb-4">
              {EARNING_SOURCES.map(src => (
                <div key={src.label} className={`${src.bg} border ${src.border} rounded-lg p-3`}>
                  <div className={`${src.color} font-bold text-sm`}>{src.emoji} {t(src.label)}</div>
                  <div className="text-gray-500 text-xs mt-0.5">{t('worker.earningsSourceHint')}</div>
                </div>
              ))}
            </div>
            {myRank?.breakdown ? (
              <EarningsBreakdown breakdown={myRank.breakdown} />
            ) : (
              <p className="text-xs text-gray-400">
                {user
                  ? t('worker.earningsNoWorker')
                  : <><Link href="/profile" className="text-sky-600 hover:text-sky-700">{t('worker.earningsLoginHint')}</Link></>}
              </p>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

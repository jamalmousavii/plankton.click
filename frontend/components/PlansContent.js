import { useLanguage } from '../i18n/LanguageContext';

// v3.30.0 — the pricing cards extracted from the homepage section so the same
// markup renders inline (empty state) and inside PlansModal (#plans in any state).
// Props stay owned by the page: catalog + purchase handlers + hint/error text.
export default function PlansContent({
  catalog,
  planHint,
  purchaseError,
  purchaseBusy,
  bundleAmount,
  setBundleAmount,
  onBuyPlan,
  onBuyBundle,
}) {
  const { t } = useLanguage();

  return (
    <>
      <div className="text-center mb-3">
        <h2 className="text-lg md:text-xl font-bold text-gray-800">⭐ {t('home.pricingTitle')}</h2>
        <p className="text-gray-500 text-xs md:text-sm mt-0.5">{t('home.freeNote')}</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {(catalog.plans || []).map(p => {
          const active = catalog.plan?.active && catalog.plan.name === p.name;
          const icon = p.name === 'plus' ? '⭐' : p.name === 'pro' ? '🚀' : '👑';
          return (
            <div key={p.name} className={`rounded-2xl border p-4 text-center shadow-sm flex flex-col ${active ? 'bg-emerald-50 border-emerald-300' : 'bg-white border-sky-100'}`}>
              <div className="text-2xl">{icon}</div>
              <div className="font-bold text-gray-800 mt-1">{p.label}</div>
              <div className="text-2xl font-black text-gray-900 mt-1">
                ${p.price}<span className="text-xs font-normal text-gray-500">/mo</span>
              </div>
              <div className="text-xs text-gray-600 mt-1">
                {t('chat.planRow')
                  .replace('{price}', `$${p.price}`)
                  .replace('{tokens}', Number(p.daily_tokens).toLocaleString('en-US'))}
              </div>
              <div className="text-[10px] text-gray-400">
                {t('chat.planValue').replace('{value}', `$${p.value_usd_day}`)}
              </div>
              {active && <div className="text-emerald-600 text-xs font-semibold mt-1">✓ {t('profile.planBadgeActive')}</div>}
              <div className="mt-auto pt-2">
                <button
                  onClick={() => onBuyPlan(p.name)}
                  disabled={!!purchaseBusy}
                  className={`w-full py-2 rounded-xl transition text-sm font-bold text-white disabled:opacity-50 ${active ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-violet-600 hover:bg-violet-700'}`}
                >
                  {purchaseBusy === p.name ? '…' : (active ? t('profile.planRenew') : t('profile.planUpgrade'))}
                </button>
              </div>
            </div>
          );
        })}
        {/* token bundle card */}
        <div className="rounded-2xl border p-4 text-center bg-white border-sky-100 shadow-sm flex flex-col">
          <div className="text-2xl">🎟️</div>
          <div className="font-bold text-gray-800 mt-1">{t('profile.bundleTitle')}</div>
          <div className="text-xs text-gray-600 mt-1">
            {t('profile.bundleDesc').replace('{rate}', Number(catalog.token_bundle?.tokens_per_usd || 40000000).toLocaleString('en-US'))}
          </div>
          <div className="text-[10px] text-gray-400 mt-0.5">
            ${catalog.token_bundle?.min_usd || 1} – ${catalog.token_bundle?.max_usd || 500}
          </div>
          <div className="flex items-center gap-1.5 mt-auto pt-2">
            <input
              value={bundleAmount}
              onChange={(e) => setBundleAmount(e.target.value.replace(/[^0-9]/g, ''))}
              inputMode="numeric"
              aria-label={t('profile.bundlePlaceholder')}
              placeholder={t('profile.bundlePlaceholder')}
              className="w-full min-w-0 border border-sky-200 rounded-xl px-2 py-2 text-sm text-center"
            />
            <button
              onClick={onBuyBundle}
              disabled={!!purchaseBusy}
              className="bg-sky-600 hover:bg-sky-700 text-white px-3 py-2 rounded-xl transition text-sm font-bold whitespace-nowrap disabled:opacity-50"
            >
              {purchaseBusy === 'tokens' ? '…' : t('profile.bundleBtn')}
            </button>
          </div>
        </div>
      </div>
      {(planHint || purchaseError) && (
        <p className="text-center text-red-500 text-xs mt-3">{planHint || purchaseError}</p>
      )}
      <p className="text-center text-gray-400 text-xs mt-2">{t('home.pricingSub')}</p>
    </>
  );
}

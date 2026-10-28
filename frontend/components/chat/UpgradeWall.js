import { memo } from 'react';

// The 402 upgrade wall rendered inside a chat bubble: plan rows, token
// bundle, guest hint. Extracted from pages/index.js in Phase 6 — module-level
// + memo so typing in the composer never re-renders the plan rows.
function UpgradeWall({ wall, content, t, purchasePlan, purchaseTokens, purchaseBusy, bundleAmount, setBundleAmount, purchaseError }) {
  return (
    <div className="min-w-[240px] md:min-w-[340px]">
      <div className="font-bold text-violet-800 mb-1">⭐ {t('chat.upgradeTitle')}</div>
      <div className="text-gray-700 mb-2 whitespace-pre-wrap">{content}</div>
      {wall.free && (
        <div className="text-xs text-gray-500 mb-2">
          {t('chat.upgradeFree')
            .replace('{used}', Number(wall.free.used || 0).toLocaleString('en-US'))
            .replace('{limit}', Number(wall.free.limit || 0).toLocaleString('en-US'))}
        </div>
      )}
      <div className="flex flex-col gap-1.5 mb-3">
        {(wall.plans || []).map(p => (
          <div key={p.name} className="flex items-center justify-between gap-2 bg-white border border-violet-100 rounded-lg px-2.5 py-2">
            <div className="min-w-0 text-xs">
              <span className="font-bold text-gray-800">{p.label}</span>
              <span className="text-gray-600">
                {' — '}
                {t('chat.planRow')
                  .replace('{price}', `$${p.price}`)
                  .replace('{tokens}', Number(p.daily_tokens).toLocaleString('en-US'))}
              </span>
              <div className="text-[10px] text-gray-400">
                {t('chat.planValue').replace('{value}', `$${p.value_usd_day}`)}
              </div>
            </div>
            {wall.signed_in && (
              <button
                onClick={() => purchasePlan(p.name)}
                disabled={!!purchaseBusy}
                className="bg-violet-600 hover:bg-violet-700 text-white px-3 py-1.5 rounded-lg text-xs font-bold transition flex-shrink-0 disabled:opacity-50"
              >
                {purchaseBusy === p.name ? '…' : `⬆ ${p.label}`}
              </button>
            )}
          </div>
        ))}
      </div>
      {wall.signed_in && wall.token_bundle && (
        <div className="bg-white border border-gray-200 rounded-lg px-2.5 py-2 mb-2 flex items-center gap-2">
          <div className="min-w-0 flex-1 text-xs text-gray-600">
            🎟️ {t('chat.bundleDesc')
              .replace('{rate}', Number(wall.token_bundle.tokens_per_usd || 40000000).toLocaleString('en-US'))}
          </div>
          <input
            value={bundleAmount}
            onChange={(e) => setBundleAmount(e.target.value.replace(/[^0-9]/g, ''))}
            inputMode="numeric"
            aria-label={t('chat.bundlePlaceholder')}
            className="w-16 border border-gray-200 rounded-lg px-2 py-1.5 text-xs text-center"
          />
          <button
            onClick={purchaseTokens}
            disabled={!!purchaseBusy}
            className="bg-sky-600 hover:bg-sky-700 text-white px-3 py-1.5 rounded-lg text-xs font-bold transition flex-shrink-0 disabled:opacity-50"
          >
            {purchaseBusy === 'tokens' ? '…' : t('chat.bundleBtn')}
          </button>
        </div>
      )}
      {!wall.signed_in && (
        <div className="text-xs text-gray-600 bg-white border border-violet-100 rounded-lg px-3 py-2">
          {t('chat.upgradeGuestHint')}
        </div>
      )}
      {purchaseError && <div className="text-red-500 text-xs mt-2">{purchaseError}</div>}
    </div>
  );
}

export default memo(UpgradeWall);

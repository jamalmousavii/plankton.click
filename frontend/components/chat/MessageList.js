import { memo } from 'react';
import { isRtl } from '../../i18n/translations';
import UpgradeWall from './UpgradeWall';

// Chat transcript: bubbles, media chips, source/payment captions, typing
// indicator, scroll spacer. Extracted from pages/index.js in Phase 6 —
// module-level + memo (defining this inside Home would create a new component
// type each render and remount the whole subtree, F7).
function MessageList({ messagesRef, chat, loading, lang, t, hasSubjectBar, purchasePlan, purchaseTokens, purchaseBusy, bundleAmount, setBundleAmount, purchaseError, onRetryWaiting, onDismissFailed, onSwitchModel }) {
  const rtl = isRtl(lang);
  return (
    <div ref={messagesRef} className={`bg-white border border-gray-200/80 ${hasSubjectBar ? 'rounded-b-2xl' : 'rounded-2xl'} p-3 md:p-5 flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain mb-3 shadow-sm`}>
      {chat.map((msg, i) => (
        <div key={i} className={`mb-4 ${msg.role === 'user' ? (rtl ? 'text-left' : 'text-right') : (rtl ? 'text-right' : 'text-left')}`}>
          <div className={`inline-block max-w-[85%] rounded-2xl text-sm md:text-base ${
            msg.role === 'user'
              ? 'bg-gray-100 text-gray-900 p-3 md:p-4 md:max-w-[80%]'
              : 'bg-transparent text-gray-800 p-0 md:max-w-[90%]'
          }`}>
            {msg.media && msg.media.type === 'image' && msg.media.data && (
              <img
                src={`data:${msg.media.mime || 'image/jpeg'};base64,${msg.media.data}`}
                alt={msg.media.name || 'image'}
                loading="lazy"
                decoding="async"
                className="rounded-xl max-h-48 md:max-h-64 max-w-full mb-2"
              />
            )}
            {msg.media && msg.media.type !== 'image' && (
              <div className="inline-flex items-center gap-1.5 text-xs rounded-lg px-2 py-1 mb-1 bg-white text-gray-600 border border-gray-200">
                <span>{msg.media.type === 'audio' ? '🎙️' : '📄'}</span>
                <span className="truncate max-w-[180px]">{msg.media.name}</span>
              </div>
            )}
            {msg.upgrade_wall ? (
              <UpgradeWall
                wall={msg.upgrade_wall}
                content={msg.content}
                t={t}
                purchasePlan={purchasePlan}
                purchaseTokens={purchaseTokens}
                purchaseBusy={purchaseBusy}
                bundleAmount={bundleAmount}
                setBundleAmount={setBundleAmount}
                purchaseError={purchaseError}
              />
            ) : msg.waiting ? (
              <div className="min-w-[220px]">
                <div className="font-bold text-amber-700 mb-1">⏳ {t('chat.waitTitle')}</div>
                <div className="text-gray-700 mb-2 whitespace-pre-wrap">{msg.content}</div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => onRetryWaiting && onRetryWaiting(i)}
                    className="bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 rounded-lg text-xs font-bold transition flex-shrink-0"
                  >
                    🔄 {t('chat.waitRetry')}
                  </button>
                  <button
                    onClick={() => onDismissFailed && onDismissFailed(i)}
                    className="text-gray-400 hover:text-gray-600 px-2 py-1.5 text-xs transition flex-shrink-0"
                  >
                    {t('chat.waitDismiss')}
                  </button>
                </div>
                {msg.waiting.auto && (
                  <div className="text-[11px] text-gray-400 mt-1.5">{t('chat.waitAuto')}</div>
                )}
              </div>
            ) : msg.model_switch ? (
              <div className="min-w-[220px]">
                <div className="font-bold text-sky-800 mb-1">🔀 {t('chat.noModelTitle')}</div>
                <div className="text-gray-700 mb-2 whitespace-pre-wrap">{msg.content}</div>
                <div className="flex flex-col gap-1.5">
                  {(msg.model_switch.alternatives || []).map((alt) => (
                    <button
                      key={alt.id}
                      onClick={() => onSwitchModel && onSwitchModel(i, alt.id)}
                      className="flex items-center justify-between gap-2 bg-white border border-sky-200 hover:bg-sky-50 rounded-lg px-2.5 py-2 text-xs transition text-left"
                    >
                      <span className="font-bold text-gray-800 truncate">{alt.name}</span>
                      <span className="text-emerald-600 flex-shrink-0">✅ {alt.workers_online}</span>
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => onDismissFailed && onDismissFailed(i)}
                  className="text-gray-400 hover:text-gray-600 px-1 py-1.5 text-xs transition mt-1"
                >
                  {t('chat.waitDismiss')}
                </button>
              </div>
            ) : msg.content ? <div className="break-words whitespace-pre-wrap">{msg.content}</div> : null}
          </div>
          {msg.role === 'assistant' && (
            <div className={`text-xs text-gray-400 mt-1 ${rtl ? 'text-right' : 'text-left'}`}>
              {msg.source === 'worker' && (
                <span className="text-emerald-600">🖥️ {t('chat.viaWorker')}{msg.worker_id ? ` #${msg.worker_id}` : ''}</span>
              )}
              {msg.source === 'local' && (
                <span>💻 {t('chat.viaLocal')}</span>
              )}
              {msg.payment_status === 'free_worker' && (
                <span className="text-amber-600"> 🎁 {t('chat.freeWorkerCredit')}</span>
              )}
              {msg.payment_status === 'tokens' && (
                <span className="text-sky-600"> 🎟️ {t('chat.paidTokens')}</span>
              )}
            </div>
          )}
        </div>
      ))}
      {loading && (
        <div className={rtl ? 'text-right' : 'text-left'}>
          <div className="inline-block bg-gray-100 text-gray-600 rounded-2xl px-4 py-3 text-sm md:text-base animate-pulse">{t('chat.typing')}</div>
        </div>
      )}
      <div />
    </div>
  );
}

export default memo(MessageList);

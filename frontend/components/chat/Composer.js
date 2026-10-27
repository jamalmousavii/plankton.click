import { memo, useEffect } from 'react';
import { CATEGORY_ICONS, CATEGORY_I18N_KEY, groupModels, workerCount } from '../../utils/models';

// Shared composer for both homepage states: ChatGPT-style card with an
// auto-growing textarea on top and a tools row underneath (model picker,
// 📎/🎙, circular send). `variant` picks the empty-state ("hero") or in-chat
// dropdown direction. Extracted from pages/index.js in Phase 6 as a
// module-level component (F7: an inline component type would remount the
// hidden file input on every keystroke and drop the selection).
// v3.40.0: models arrive pre-sorted (busiest first) and render grouped by
// category with sticky headers; zero-worker rows stay disabled.

function Composer({
  variant = 'chat',
  t, message, setMessage, sendMessage, loading,
  models, selectedModel, selectedModelData, setSelectedModel,
  dropdownOpen, setDropdownOpen, dropdownRef, inputRef,
  fileInputRef, onPickFile, attachFileAllowed, audioOk,
  recording, startRecording, stopRecording,
  attachment, removeAttachment, attachError,
}) {
  // Clearing the draft (after send / session switch) collapses the textarea
  // back to one line — without this the explicit height would stick around.
  useEffect(() => {
    if (!message && inputRef.current) inputRef.current.style.height = 'auto';
  }, [message, inputRef]);

  const growTextarea = (el) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  const renderModelDropdown = () => (
    <div className="relative min-w-0 max-w-[60%]" ref={dropdownRef}>
      <button
        onClick={() => setDropdownOpen(!dropdownOpen)}
        className="max-w-full bg-white hover:bg-gray-50 text-gray-700 border border-gray-200 px-3 py-1.5 rounded-full transition flex items-center gap-2 justify-between text-sm"
      >
        <span className="truncate font-medium">
          {selectedModelData ? `${CATEGORY_ICONS[selectedModelData.category]} ${selectedModelData.name}` : selectedModel}
        </span>
        <span className="text-gray-400 text-xs">▼</span>
      </button>
      {dropdownOpen && (
        <div className={`absolute ${variant === 'chat' ? 'bottom-full mb-2' : 'top-full mt-2'} left-0 w-[min(20rem,85vw)] bg-white border border-gray-200 rounded-2xl shadow-xl overflow-hidden z-50 max-h-[min(300px,40dvh)] overflow-y-auto`}>
          {groupModels(models).map((group) => (
            <div key={group.category}>
              <div role="presentation" className="sticky top-0 bg-gray-50/95 backdrop-blur px-4 py-1.5 text-[11px] font-bold uppercase tracking-wide text-gray-500 border-b border-gray-100">
                {CATEGORY_ICONS[group.category] || '📦'} {t(CATEGORY_I18N_KEY[group.category] || 'chat.catChat')}
              </div>
              {group.items.map((model) => {
                const isSelected = selectedModel === model.id;
                const hasWorkers = workerCount(model) > 0;
                const canSelect = hasWorkers;
                return (
                  <button
                    key={model.id}
                    onClick={() => { if (canSelect) { setSelectedModel(model.id); setDropdownOpen(false); } }}
                    disabled={!canSelect}
                    aria-disabled={!canSelect}
                    className={`w-full text-left px-4 py-3 flex items-center justify-between transition text-sm border-b border-gray-100 last:border-0 ${
                      isSelected ? 'bg-sky-50 text-sky-800' : canSelect ? 'hover:bg-gray-50 text-gray-700' : 'opacity-40 cursor-not-allowed text-gray-400'
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span>{CATEGORY_ICONS[model.category]}</span>
                      <span className="truncate font-medium">{model.name}</span>
                      <span className="text-sky-600 text-xs">{model.size}</span>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {hasWorkers ? (
                        <span className="text-emerald-600 text-xs">✅ {workerCount(model)}</span>
                      ) : (
                        <span className="text-red-400 text-xs">⚠️ 0</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const renderMediaButtons = () => (
    <div className="flex items-center gap-1 flex-shrink-0">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,.pdf,.txt,.md,.csv,.json,application/pdf,text/*"
        className="hidden"
        onChange={onPickFile}
      />
      <button
        type="button"
        onClick={() => { if (attachFileAllowed) fileInputRef.current?.click(); }}
        disabled={!attachFileAllowed}
        title={attachFileAllowed ? t('chat.attach') : t('chat.attachEmbedding')}
        className="flex-shrink-0 w-9 h-9 rounded-full text-base hover:bg-gray-100 transition disabled:opacity-40 disabled:cursor-not-allowed"
        aria-label={t('chat.attach')}
      >📎</button>
      <button
        type="button"
        onClick={recording ? stopRecording : startRecording}
        disabled={!audioOk && !recording}
        title={audioOk ? (recording ? t('chat.voiceStop') : t('chat.voice')) : t('chat.needAudioModel')}
        className={`flex-shrink-0 w-9 h-9 rounded-full text-base transition disabled:opacity-40 disabled:cursor-not-allowed ${
          recording ? 'bg-red-500 text-white animate-pulse' : 'hover:bg-gray-100'
        }`}
        aria-label={recording ? t('chat.voiceStop') : t('chat.voice')}
      >{recording ? '⏹' : '🎙️'}</button>
    </div>
  );

  const pendingAttachmentChip = attachment && (
    <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-full pl-2.5 pr-2 py-1.5 text-xs text-gray-700 shadow-sm max-w-full">
      {attachment.type === 'image' ? (
        <img src={`data:${attachment.mime || 'image/jpeg'};base64,${attachment.data}`} alt="" width={20} height={20} className="w-5 h-5 rounded object-cover flex-shrink-0" />
      ) : (
        <span>{attachment.type === 'audio' ? '🎙️' : '📄'}</span>
      )}
      <span className="truncate max-w-[160px]">{attachment.name}</span>
      <button
        type="button"
        onClick={removeAttachment}
        className="flex items-center justify-center w-9 h-9 -my-1.5 -mr-1.5 text-gray-400 hover:text-red-500 font-bold rounded-md active:bg-red-50"
        title={t('chat.removeAttachment')}
      >✕</button>
    </div>
  );

  const attachErrorLine = attachError ? (
    <div className="text-red-500 text-xs">⚠️ {attachError}</div>
  ) : null;

  return (
    <>
      {(attachment || attachError) && (
        <div className={`flex flex-col gap-1.5 ${variant === 'hero' ? 'mb-3' : 'mb-2'} items-start`}>
          {pendingAttachmentChip}
          {attachErrorLine}
        </div>
      )}
      <div className={`bg-white border border-gray-200/80 rounded-3xl shadow-[0_4px_24px_rgba(0,0,0,0.05)] focus-within:border-sky-300 focus-within:ring-2 focus-within:ring-sky-400/50 transition ${variant === 'hero' ? 'p-2.5 md:p-3' : 'p-2 md:p-2.5'}`}>
        <textarea
          ref={inputRef}
          rows={1}
          value={message}
          onChange={(e) => { growTextarea(e.target); setMessage(e.target.value); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
              e.preventDefault();
              sendMessage();
            }
          }}
          placeholder={t('chat.placeholder')}
          className="w-full resize-none bg-transparent border-0 text-gray-800 placeholder-gray-500 px-3 py-2.5 text-sm md:text-base focus:outline-none overflow-y-auto max-h-40 leading-relaxed"
        />
        <div className="flex items-center gap-2 px-1 pb-0.5">
          {renderModelDropdown()}
          <div className="flex-1" />
          {renderMediaButtons()}
          <button
            onClick={sendMessage}
            disabled={loading}
            aria-label={t('chat.send')}
            title={t('chat.send')}
            className="flex items-center justify-center w-9 h-9 rounded-full bg-gray-900 hover:bg-gray-700 text-white transition disabled:opacity-40 flex-shrink-0 text-lg leading-none"
          >
            {loading ? '…' : '↑'}
          </button>
        </div>
      </div>
    </>
  );
}

export default memo(Composer);

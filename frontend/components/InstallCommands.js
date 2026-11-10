// Install commands for every OS with the worker token already inside (1.2.2),
// so the owner copies one line and the installer never asks for the token.
// The token is also shown on its own (for the Manager menu / re-installs).
import { useState } from 'react';
import { useLanguage } from '../i18n/LanguageContext';

const RAW = 'https://raw.githubusercontent.com/jamalmousavii/plankton.click/main/worker-app';
const TOKEN_RE = /^(pw|kz)_[0-9a-f]{32,64}$/;

// Exported for tests. A token that is not the expected shape is never
// pasted into a shell command (it would otherwise be shell input).
export function installCommands(token) {
  const tok = TOKEN_RE.test(String(token || '')) ? token : 'YOUR_TOKEN';
  return {
    ubuntu: `wget -O install-ubuntu.sh ${RAW}/install-ubuntu.sh && bash install-ubuntu.sh --token ${tok}`,
    redhat: `wget -O install-redhat.sh ${RAW}/install-redhat.sh && bash install-redhat.sh --token ${tok}`,
    macos: `curl -fsSL -o install-macos.sh ${RAW}/install-macos.sh && bash install-macos.sh --token ${tok}`,
    windows: `cd $HOME; Invoke-WebRequest -UseBasicParsing -Uri ${RAW}/install-windows.ps1 -OutFile install-windows.ps1; powershell -ExecutionPolicy Bypass -File .\\install-windows.ps1 -Token ${tok}`,
  };
}

const OS_LIST = [
  { id: 'ubuntu', icon: '🐧', label: 'worker.ubuntu' },
  { id: 'redhat', icon: '🎩', label: 'worker.redhat' },
  { id: 'macos', icon: '🍎', label: 'worker.macos' },
  { id: 'windows', icon: '🪟', label: 'worker.windows' },
];

export default function InstallCommands({ token, showToken = true }) {
  const { t } = useLanguage();
  const [os, setOs] = useState('ubuntu');
  const [copied, setCopied] = useState(null);
  const cmds = installCommands(token);
  const hasToken = cmds.ubuntu.indexOf('YOUR_TOKEN') === -1;

  const copy = (text, id) => {
    try { navigator.clipboard.writeText(text); } catch (e) { /* clipboard blocked */ }
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };
  const btn = (id) => `px-3 py-1.5 rounded-lg text-xs font-bold transition min-h-[36px] flex-shrink-0 ${
    copied === id ? 'bg-emerald-500 text-white' : 'bg-sky-500 hover:bg-sky-600 text-white'}`;

  return (
    <div className="space-y-2">
      {showToken && hasToken && (
        <div>
          <p className="text-gray-500 text-xs font-medium mb-1">🔑 {t('worker.tokenLabel')}</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 text-emerald-700 text-xs break-all bg-sky-50 border border-sky-100 px-2 py-1.5 rounded">{token}</code>
            <button onClick={() => copy(token, 'token')} className={btn('token')}>
              {copied === 'token' ? t('worker.copied') : t('worker.copyCmd')}
            </button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-1" role="tablist">
        {OS_LIST.map((o) => (
          <button key={o.id} role="tab" aria-selected={os === o.id} onClick={() => setOs(o.id)}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-bold border transition min-h-[36px] ${
              os === o.id ? 'bg-sky-500 text-white border-sky-500' : 'bg-white text-gray-600 border-sky-200 hover:bg-sky-50'}`}>
            {o.icon} {t(o.label)}
          </button>
        ))}
      </div>
      <div className="flex flex-col sm:flex-row items-stretch sm:items-start gap-2">
        <code className="flex-1 min-w-0 bg-sky-50 border border-sky-100 rounded-lg px-3 py-2 font-mono text-xs text-emerald-700 break-all">{cmds[os]}</code>
        <button onClick={() => copy(cmds[os], os)} className={btn(os)}>
          {copied === os ? t('worker.copied') : t('worker.copyCmd')}
        </button>
      </div>
      <p className="text-gray-400 text-xs">
        {os === 'windows' ? t('worker.windowsHint') : null}
        {os === 'windows' && hasToken ? ' ' : null}
        {hasToken ? t('worker.tokenInside') : t('worker.createForToken')}
      </p>
    </div>
  );
}

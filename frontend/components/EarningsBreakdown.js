import { useLanguage } from '../i18n/LanguageContext';

// v3.29.0 — shared 5-way earnings breakdown (source × payer plan).
// Used by profile (rank card), /workers (account totals) and /worker (real
// numbers when the visitor has a worker). `breakdown` = { tokens, wallet,
// plus, pro, max } from GET /api/leaderboard/mine.
const ROWS = [
  { key: 'tokens', emoji: '🎟️', label: 'profile.bdTokens', color: 'text-sky-700' },
  { key: 'wallet', emoji: '👛', label: 'profile.bdWallet', color: 'text-gray-600' },
  { key: 'plus',   emoji: '⭐', label: 'profile.bdPlus',   color: 'text-amber-600' },
  { key: 'pro',    emoji: '🚀', label: 'profile.bdPro',    color: 'text-emerald-600' },
  { key: 'max',    emoji: '👑', label: 'profile.bdMax',    color: 'text-violet-600' },
];

export default function EarningsBreakdown({ breakdown, className = '' }) {
  const { t } = useLanguage();
  if (!breakdown) return null;
  return (
    <div className={`bg-gray-50 rounded-xl border border-gray-100 p-3 ${className}`}>
      <div className="text-xs font-semibold text-gray-600 mb-1.5">🧾 {t('profile.breakdownTitle')}</div>
      <div className="flex flex-col gap-0.5 text-xs">
        {ROWS.map(row => (
          <div key={row.key} className={`flex justify-between ${row.color}`}>
            <span>{row.emoji} {t(row.label)}</span>
            <span className="font-semibold">{Number(breakdown[row.key] || 0).toFixed(2)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

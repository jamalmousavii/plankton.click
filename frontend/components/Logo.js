// Plankton mark: a single cell (membrane ring + nucleus) ringed by six
// cilia nodes — one organism among many, the way one worker joins the swarm.
export function LogoMark({ size = 32, className = '' }) {
  const cilia = [0, 60, 120, 180, 240, 300];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="pk-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#082b33" />
          <stop offset="1" stopColor="#127b88" />
        </linearGradient>
        <radialGradient id="pk-core" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.45" stopColor="#7cf5c6" />
          <stop offset="1" stopColor="#36b9c0" />
        </radialGradient>
      </defs>
      <rect width="64" height="64" rx="18" fill="url(#pk-bg)" />
      <circle cx="32" cy="32" r="15" fill="none" stroke="#7cf5c6" strokeOpacity="0.9" strokeWidth="3" />
      <circle cx="32" cy="32" r="7" fill="url(#pk-core)" />
      {cilia.map((deg) => {
        const rad = (deg * Math.PI) / 180;
        return (
          <circle
            key={deg}
            cx={32 + Math.cos(rad) * 23}
            cy={32 + Math.sin(rad) * 23}
            r={deg === 300 ? 3.4 : 2.4}
            fill={deg === 300 ? '#ff8a73' : '#ade9e8'}
          />
        );
      })}
    </svg>
  );
}

export default function Logo({ size = 32, showWord = true, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark size={size} />
      {showWord && (
        <span className="font-display font-bold tracking-tight text-gray-900 text-lg md:text-xl leading-none">
          plankton<span className="text-sky-500">.</span>
        </span>
      )}
    </span>
  );
}

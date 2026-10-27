// Decorative drifting "plankton" behind hero sections. Positions come from a
// fixed seed so server and client render the same markup (no hydration
// mismatch); motion is pure CSS and switches off under reduced-motion.
function seeded(n) {
  let s = 1337;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  return Array.from({ length: n }, () => ({
    left: rnd() * 100,
    top: rnd() * 100,
    size: 3 + rnd() * 9,
    t: 10 + rnd() * 14,
    d: -rnd() * 14,
    dx: (rnd() - 0.5) * 60,
    dy: -10 - rnd() * 40,
  }));
}

const PARTICLES = seeded(28);

export default function PlanktonField() {
  return (
    <div className="plankton-field" aria-hidden="true">
      {PARTICLES.map((p, i) => (
        <span
          key={i}
          style={{
            left: `${p.left}%`,
            top: `${p.top}%`,
            width: p.size,
            height: p.size,
            '--t': `${p.t}s`,
            '--d': `${p.d}s`,
            '--dx': `${p.dx}px`,
            '--dy': `${p.dy}px`,
          }}
        />
      ))}
    </div>
  );
}

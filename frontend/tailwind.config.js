/** @type {import('tailwindcss').Config} */
// Plankton design tokens. The brand accent ("lagoon", a bioluminescent
// teal) is mapped onto `sky` and the cool ocean-ink neutrals onto `gray`, so
// every existing utility (bg-sky-500, text-gray-800, ...) picks up the theme
// without touching each component.
const lagoon = {
  50: '#eefcfb',
  100: '#d4f6f4',
  200: '#ade9e8',
  300: '#74d6d8',
  400: '#36b9c0',
  500: '#1798a3',
  600: '#127b88',
  700: '#146370',
  800: '#17515c',
  900: '#18444e',
  950: '#082b33',
};

const ink = {
  50: '#f5f8f8',
  100: '#ebf1f1',
  200: '#d9e3e4',
  300: '#b9c8ca',
  400: '#8a9ea2',
  500: '#64787d',
  600: '#4b5d62',
  700: '#3a4a4f',
  800: '#24343a',
  900: '#142328',
  950: '#0a161a',
};

module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        sky: lagoon,
        gray: ink,
        lagoon,
        ink,
        glow: '#7cf5c6',
        coral: '#ff8a73',
        abyss: '#05161c',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['"Space Grotesk"', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(54, 185, 192, 0.18), 0 10px 40px -12px rgba(23, 152, 163, 0.45)',
        card: '0 1px 2px rgba(10, 22, 26, 0.04), 0 8px 24px -12px rgba(10, 22, 26, 0.12)',
      },
      keyframes: {
        drift: {
          '0%': { transform: 'translate3d(0, 0, 0) scale(1)' },
          '50%': { transform: 'translate3d(var(--dx, 12px), var(--dy, -24px), 0) scale(1.15)' },
          '100%': { transform: 'translate3d(0, 0, 0) scale(1)' },
        },
        pulseGlow: {
          '0%, 100%': { opacity: '0.55' },
          '50%': { opacity: '1' },
        },
        rise: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        drift: 'drift var(--t, 14s) ease-in-out infinite',
        'pulse-glow': 'pulseGlow 3.2s ease-in-out infinite',
        rise: 'rise .5s cubic-bezier(.2,.7,.2,1) both',
      },
    },
  },
  plugins: [],
};

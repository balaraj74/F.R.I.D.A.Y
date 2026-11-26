/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        hud: {
          bg: "#030712",
          panel: "rgba(6, 15, 30, 0.65)",
          panelBorder: "rgba(0, 229, 255, 0.35)",
          cyan: "#00E5FF",
          cyanDim: "#0099b8",
          blue: "#0077b6",
          darkBlue: "#0b2545",
          accent: "#38bdf8",
        }
      },
      fontFamily: {
        hud: ["Orbitron", "Rajdhani", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
      animation: {
        'spin-slow': 'spin 20s linear infinite',
        'spin-reverse': 'spin-reverse 25s linear infinite',
        'spin-reverse-fast': 'spin-reverse 12s linear infinite',
        'spin-fast': 'spin 8s linear infinite',
        'pulse-glow': 'pulse-glow 2.5s ease-in-out infinite',
        'pulse-fast': 'pulse-fast 1.2s ease-in-out infinite',
        'wave': 'wave 1.5s ease-in-out infinite',
      },
      keyframes: {
        'spin-reverse': {
          from: { transform: 'rotate(360deg)' },
          to: { transform: 'rotate(0deg)' },
        },
        'pulse-glow': {
          '0%, 100%': { opacity: '0.6', transform: 'scale(0.98)' },
          '50%': { opacity: '1', transform: 'scale(1.02)' },
        },
        'pulse-fast': {
          '0%, 100%': { opacity: '0.6' },
          '50%': { opacity: '1' },
        },
        'wave': {
          '0%, 100%': { transform: 'scaleY(0.4)' },
          '50%': { transform: 'scaleY(1)' },
        }
      },
      boxShadow: {
        'hud-glow': '0 0 25px rgba(0, 229, 255, 0.25)',
        'hud-glow-lg': '0 0 40px rgba(0, 229, 255, 0.45)',
        'hud-card': '0 8px 32px 0 rgba(0, 10, 25, 0.7)',
      }
    },
  },
  plugins: [],
}


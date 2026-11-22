/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        'space': 'rgb(var(--space-rgb) / <alpha-value>)',
        'panel': 'rgb(var(--panel-rgb) / <alpha-value>)',
        'panel-border': 'rgb(var(--panel-border-rgb) / <alpha-value>)',
        'cyan': 'rgb(var(--cyan-rgb) / <alpha-value>)',
        'amber': 'rgb(var(--amber-rgb) / <alpha-value>)',
        'crimson': 'rgb(var(--crimson-rgb) / <alpha-value>)',
        'green': 'rgb(var(--green-rgb) / <alpha-value>)',
        'text-primary': 'rgb(var(--text-primary-rgb) / <alpha-value>)',
        'text-secondary': 'rgb(var(--text-secondary-rgb) / <alpha-value>)',
        'text-dim': 'rgb(var(--text-dim-rgb) / <alpha-value>)',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'scan': 'scan 2s linear infinite',
        'blink': 'blink 1s step-end infinite',
        'slide-up': 'slideUp 0.3s ease-out',
        'fade-in': 'fadeIn 0.2s ease-out',
      },
      keyframes: {
        scan: {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100%)' },
        },
        blink: {
          '0%, 50%': { opacity: '1' },
          '51%, 100%': { opacity: '0' },
        },
        slideUp: {
          '0%': { transform: 'translateY(10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
      },
      boxShadow: {
        'glow-cyan': '0 0 0 1px rgba(255, 255, 255, 0.12)',
        'glow-amber': '0 0 0 1px rgba(255, 255, 255, 0.1)',
        'glow-crimson': '0 0 0 1px rgba(255, 255, 255, 0.14)',
        'inner-glow': 'inset 0 0 0 1px rgba(255, 255, 255, 0.06)',
      },
    },
  },
  plugins: [],
}

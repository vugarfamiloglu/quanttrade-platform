const path = require('path');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    path.join(__dirname, 'app/**/*.{ts,tsx}'),
    path.join(__dirname, 'components/**/*.{ts,tsx}'),
  ],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter Tight"', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      colors: {
        ink:    { DEFAULT: '#0b0e14', deep: '#06090f', soft: '#131720' },
        bid:    '#4ade80',
        ask:    '#f87171',
        cyan:   '#38bdf8',
        amber:  '#fbbf24',
        plum:   '#a78bfa',
        steel:  '#7c89a8',
      },
    },
  },
  plugins: [],
};

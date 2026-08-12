/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'mint': '#6EC4B1',
        'cream': '#F7D44A',
        'warm-white': '#FDF8F4',
        'card-white': '#FFFFFF',
        'sage': '#7C9885',
      },
      fontFamily: {
        'sans': ['PingFang SC', 'HarmonyOS Sans SC', 'Microsoft YaHei', 'sans-serif'],
      },
      borderRadius: {
        'card': '16px',
        'button': '20px',
      },
      boxShadow: {
        'light': '0 2px 12px rgba(0, 0, 0, 0.04)',
        'medium': '0 4px 20px rgba(0, 0, 0, 0.06)',
      },
      animation: {
        'check': 'check 0.3s ease-out',
        'fill': 'fill 0.8s ease-out',
        'scale': 'scale 0.15s ease-out',
        'bounce-light': 'bounce-light 0.3s ease-out',
      },
      keyframes: {
        check: {
          '0%': { transform: 'scale(0)', opacity: '0' },
          '50%': { transform: 'scale(1.2)', opacity: '1' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        fill: {
          '0%': { width: '0%' },
          '100%': { width: 'var(--fill-width, 100%)' },
        },
        scale: {
          '0%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(0.96)' },
          '100%': { transform: 'scale(1)' },
        },
        'bounce-light': {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-3px)' },
        },
      },
    },
  },
  plugins: [],
}

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // 关闭 preflight，避免全局 reset 影响 Ant Design 工作台；
  // 基础 reset 在 src/tailwind.css 的 base 层按需补齐。
  corePlugins: { preflight: false },
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f1f3f8', 100: '#dde3f2', 200: '#b7c3e4', 300: '#8698cc',
          400: '#5873e6', 500: '#2b57cf', 600: '#2449ad', 700: '#1f3e8f',
          800: '#1b3576', 900: '#172b5c',
        },
        ink: { DEFAULT: '#1a1d23', soft: '#4e5969', mute: '#86909c', faint: '#9aa3b2' },
        line: { DEFAULT: '#eceef2', soft: '#f1f3f7' },
        canvas: { DEFAULT: '#ffffff', soft: '#f6f8fc', sunk: '#eef2f8' },
        success: '#12a38a', warning: '#e08a00', danger: '#d4380d',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', '"PingFang SC"', '"Microsoft YaHei"', '"Helvetica Neue"', 'Arial', 'sans-serif'],
        mono: ['"SFMono-Regular"', 'Consolas', '"Liberation Mono"', 'Menlo', 'monospace'],
      },
      fontSize: {
        display: ['clamp(2.5rem, 1.6rem + 3vw, 3.75rem)', { lineHeight: '1.08', letterSpacing: '-0.03em' }],
        h1: ['clamp(2rem, 1.4rem + 2vw, 2.75rem)', { lineHeight: '1.14', letterSpacing: '-0.02em' }],
        h2: ['clamp(1.5rem, 1.2rem + 1vw, 2rem)', { lineHeight: '1.2', letterSpacing: '-0.01em' }],
      },
      borderRadius: { xl: '14px', '2xl': '18px', '3xl': '24px', '4xl': '32px' },
      boxShadow: {
        card: '0 1px 2px rgba(28,52,102,.04), 0 4px 14px rgba(28,52,102,.05)',
        elevated: '0 12px 36px rgba(28,52,102,.09)',
        float: '0 18px 50px rgba(28,52,102,.12)',
        glow: '0 8px 20px rgba(28,52,102,.12)',
        ring: '0 0 0 1px rgba(28,52,102,.08), 0 8px 24px rgba(28,52,102,.10)',
      },
      maxWidth: { content: '1200px', wide: '1280px' },
      backgroundImage: {
        'grid-soft': 'linear-gradient(to right, rgba(43,99,240,.05) 1px, transparent 1px), linear-gradient(to bottom, rgba(43,99,240,.05) 1px, transparent 1px)',
      },
      backgroundSize: { grid: '44px 44px' },
      keyframes: {
        marquee: { from: { transform: 'translateX(0)' }, to: { transform: 'translateX(-50%)' } },
        floaty: { '0%,100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-8px)' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        flow: { to: { strokeDashoffset: '-18.5' } },
        pulsering: { '0%': { transform: 'scale(.55)', opacity: '.5' }, '70%': { opacity: '0' }, '100%': { transform: 'scale(1.75)', opacity: '0' } },
        draw: { from: { strokeDashoffset: '1' }, to: { strokeDashoffset: '0' } },
        growx: { from: { transform: 'scaleX(0)' }, to: { transform: 'scaleX(1)' } },
        fadeup: { from: { opacity: '0', transform: 'translateY(14px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        'accordion-down': { from: { height: '0' }, to: { height: 'var(--radix-accordion-content-height)' } },
        'accordion-up': { from: { height: 'var(--radix-accordion-content-height)' }, to: { height: '0' } },
      },
      animation: {
        marquee: 'marquee 28s linear infinite',
        floaty: 'floaty 6s ease-in-out infinite',
        flow: 'flow 1.5s linear infinite',
        pulsering: 'pulsering 3s ease-out infinite',
        draw: 'draw 1.8s .15s cubic-bezier(.4,.1,.2,1) both',
        growx: 'growx .9s .3s cubic-bezier(.2,.75,.3,1) both',
        fadeup: 'fadeup .6s cubic-bezier(.2,.7,.3,1) both',
        'accordion-down': 'accordion-down .24s ease-out',
        'accordion-up': 'accordion-up .2s ease-in',
      },
    },
  },
  plugins: [],
}

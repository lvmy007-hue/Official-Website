import { defineConfig, type Connect, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const spaPaths = new Set(['/', '/site', '/product', '/product/stores', '/product/orders', '/product/returns', '/product/finance', '/product/advertising', '/product/permissions', '/product/inventory', '/product/listings', '/product/inbound', '/solutions', '/solutions/advertising', '/pricing', '/about', '/news', '/resources', '/contact', '/privacy', '/terms', '/security', '/login'])

function isAppDocument(pathname: string) {
  if (spaPaths.has(pathname) || pathname.startsWith('/app')) return true
  if (pathname.startsWith('/api') || pathname.startsWith('/src') || pathname.startsWith('/node_modules') || pathname.startsWith('/docs') || pathname.startsWith('/@') || pathname.startsWith('/__')) return true
  return pathname.includes('.')
}

function publicNotFound(): Plugin {
  const guard: Connect.NextHandleFunction = (req, res, next) => {
    const pathname = decodeURIComponent((req.url ?? '/').split('?')[0] || '/')
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    if (isAppDocument(pathname)) return next()
    res.statusCode = 404
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>页面不存在｜NOVA ERP</title></head><body><main><h1>页面不存在</h1><p>该地址没有对应的公开页面。</p><p><a href="/">返回首页</a></p></main></body></html>')
  }
  return {
    name: 'nova-public-404',
    configureServer(server) { server.middlewares.use(guard) },
    configurePreviewServer(server) { server.middlewares.use(guard) },
  }
}

export default defineConfig({
  plugins: [react(), publicNotFound()],
  server: {
    host: '127.0.0.1',
    watch: {
      ignored: [
        '**/.git/**',
        '**/node_modules/**',
        (file: string) => file.replace(/\\/g, '/').toLowerCase().includes('/docs/evidence/'),
      ],
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4000',
        changeOrigin: true,
      },
    },
  },
  build: { rollupOptions: { output: { manualChunks: { react: ['react', 'react-dom'], arco: ['@arco-design/web-react'] } } } },
})

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
var spaPaths = new Set(['/', '/site', '/product', '/product/stores', '/product/orders', '/product/returns', '/product/finance', '/product/advertising', '/product/permissions', '/product/inventory', '/product/listings', '/product/inbound', '/solutions', '/solutions/advertising', '/pricing', '/about', '/news', '/resources', '/contact', '/privacy', '/terms', '/security', '/login', '/en', '/en/product', '/en/product/stores', '/en/product/orders', '/en/product/returns', '/en/product/finance', '/en/product/advertising', '/en/product/permissions', '/en/product/inventory', '/en/product/listings', '/en/product/inbound', '/en/solutions', '/en/solutions/advertising', '/en/pricing', '/en/about', '/en/news', '/en/resources', '/en/contact', '/en/privacy', '/en/terms', '/en/security']);
function isAppDocument(pathname) {
    if (spaPaths.has(pathname) || pathname.startsWith('/app') || pathname.startsWith('/platform') || pathname.startsWith('/invite/'))
        return true;
    if (pathname.startsWith('/api') || pathname.startsWith('/src') || pathname.startsWith('/node_modules') || pathname.startsWith('/docs') || pathname.startsWith('/@') || pathname.startsWith('/__'))
        return true;
    return pathname.includes('.');
}
function publicNotFound() {
    var guard = function (req, res, next) {
        var _a;
        var pathname = decodeURIComponent(((_a = req.url) !== null && _a !== void 0 ? _a : '/').split('?')[0] || '/');
        if (req.method !== 'GET' && req.method !== 'HEAD')
            return next();
        if (isAppDocument(pathname))
            return next();
        res.statusCode = 404;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>页面不存在｜NOVA ERP</title></head><body><main><h1>页面不存在</h1><p>该地址没有对应的公开页面。</p><p><a href="/">返回首页</a></p></main></body></html>');
    };
    return {
        name: 'nova-public-404',
        configureServer: function (server) { server.middlewares.use(guard); },
        configurePreviewServer: function (server) { server.middlewares.use(guard); },
    };
}
var fromRoot = function (path) { return fileURLToPath(new URL(path, import.meta.url)); };
export default defineConfig(function (_a) {
    var isSsrBuild = _a.isSsrBuild;
    return ({
        plugins: [react(), publicNotFound()],
        // 前端直接引用共享包的源码（查询契约、权限目录），不依赖它们的编译产物
        resolve: {
            alias: {
                '@nova/api-contracts': fromRoot('./packages/api-contracts/src/index.ts'),
                '@nova/authz': fromRoot('./packages/authz/src/index.ts'),
            },
        },
        server: {
            host: '127.0.0.1',
            watch: {
                ignored: [
                    '**/.git/**',
                    '**/node_modules/**',
                    function (file) { return file.replace(/\\/g, '/').toLowerCase().includes('/docs/evidence/'); },
                ],
            },
            proxy: {
                '/api': {
                    target: 'http://127.0.0.1:4000',
                    changeOrigin: true,
                },
            },
        },
        build: isSsrBuild
            ? { rollupOptions: { output: { entryFileNames: '[name].mjs', format: 'es' } } }
            : { manifest: true, rollupOptions: { output: { manualChunks: { react: ['react', 'react-dom'] } } } },
    });
});

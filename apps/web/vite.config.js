import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
    server: {
        port: 5173,
        proxy: {
            // Auth service (port 3001) — gateway rewrites /api/auth/* → /auth/*
            '/api/auth': {
                target: 'http://localhost:3001',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api\/auth/, '/auth'),
            },
            // Tenant routes also live on the auth service
            '/api/tenants': {
                target: 'http://localhost:3001',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api\/tenants/, '/tenants'),
            },
            // Catalog service (port 3002) — no path rewrite needed
            '/api/catalog': {
                target: 'http://localhost:3002',
                changeOrigin: true,
            },
            // Kanban service (port 3003) — no path rewrite needed
            '/api/kanban': {
                target: 'http://localhost:3003',
                changeOrigin: true,
            },
            // Orders service (port 3004) — no path rewrite needed
            '/api/orders': {
                target: 'http://localhost:3004',
                changeOrigin: true,
            },
            // Notifications service (port 3005) — no path rewrite needed
            '/api/notifications': {
                target: 'http://localhost:3005',
                changeOrigin: true,
            },
            // Public scan endpoint → kanban service
            '/scan': {
                target: 'http://localhost:3003',
                changeOrigin: true,
            },
        },
    },
});

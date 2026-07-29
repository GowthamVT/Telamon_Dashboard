import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * In dev we proxy /api to the Express backend so the browser sees a single
 * origin. That keeps local development free of CORS entirely; the backend's CORS
 * config is what matters in production, when the frontend is served from its own
 * origin (or embedded in an iframe on someone else's).
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_PROXY_TARGET || 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});

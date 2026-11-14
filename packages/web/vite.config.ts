import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run web:dev` serves the UI with hot reload and proxies the API and live feed to the
// dashboard server (npm run dashboard, port 4100).
const dashboard = process.env['DASHBOARD_URL'] ?? 'http://127.0.0.1:4100';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': dashboard,
      '/ws': { target: dashboard.replace(/^http/, 'ws'), ws: true },
    },
  },
});

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The server owns /api, /health, and the /ws upgrade.
    // Proxying rather than using an absolute origin keeps requests same-origin, which is
    // what makes the SameSite=Lax session cookie work in development — and the gateway
    // authenticates from that cookie at the upgrade, so /ws needs it just as much as /api.
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/health': 'http://127.0.0.1:8787',
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});

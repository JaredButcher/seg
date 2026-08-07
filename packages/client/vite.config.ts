import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The server owns /api and /health, and will own the WebSocket upgrade later.
    // Proxying rather than using an absolute origin keeps requests same-origin, which is
    // what makes the SameSite=Lax session cookie work in development.
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/health': 'http://127.0.0.1:8787',
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});

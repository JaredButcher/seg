import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The server owns /health today and will own /api and the WebSocket upgrade later.
    proxy: {
      '/health': 'http://127.0.0.1:8787',
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});

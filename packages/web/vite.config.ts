import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Loopback only, matching the server's privacy posture.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      // The API server binds 127.0.0.1:3001 (see packages/server/src/config.ts).
      '/api': 'http://127.0.0.1:3001',
      '/health': 'http://127.0.0.1:3001',
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
});

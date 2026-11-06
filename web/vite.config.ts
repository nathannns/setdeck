import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // HTTP_PORT: the SetDeck server to talk to (7300, the app's, by default; the mock setup uses its own)
  server: { proxy: {
    '/ws': { target: `ws://localhost:${process.env.HTTP_PORT ?? 7300}`, ws: true },
    '/api': `http://localhost:${process.env.HTTP_PORT ?? 7300}`,
  } },
});

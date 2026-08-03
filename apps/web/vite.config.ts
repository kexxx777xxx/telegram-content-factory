import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const serverPort = process.env.PORT ?? '3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // In a workspace monorepo a linked package can pull React through a second
    // resolution path, which surfaces as "Invalid hook call" from whichever
    // library renders first. Pinning both to one copy prevents that class of bug.
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: 5173,
    // Loopback by default; inside a container the dev server has to bind all
    // interfaces to be reachable through the published port.
    host: process.env.VITE_HOST === 'true',
    // The API lives on the Express server; same-origin in production, proxied here.
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${serverPort}`,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});

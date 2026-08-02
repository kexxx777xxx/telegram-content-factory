import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const serverPort = process.env.PORT ?? '3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
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

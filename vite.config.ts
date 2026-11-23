import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  // Prevent Vite from loading anything from the network.
  // All assets must be local — this is enforced at the bundler level.
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // Build output and packaged app folders are large and are rewritten
      // while the dev server is running. Watching them makes Vite die with
      // `EBUSY: resource busy or locked` on Windows the moment a build writes
      // into release/, which takes the whole dev session down with it.
      ignored: [
        '**/release/**',
        '**/release-new/**',
        '**/dist/**',
        '**/dist-electron/**',
      ],
    },
  },
});

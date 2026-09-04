import { crx } from '@crxjs/vite-plugin';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import manifest from './manifest.json';

export default defineConfig({
  plugins: [vue(), crx({ manifest })],
  build: {
    target: 'esnext',
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['v86'],
  },
});

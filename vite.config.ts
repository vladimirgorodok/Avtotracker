import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Сборка кладётся в dist и упаковывается в APK через Capacitor.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 2000,
  },
  optimizeDeps: {
    exclude: ['sql.js'],
  },
});

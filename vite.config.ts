import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Сборка кладётся в dist и упаковывается в APK через Capacitor.
export default defineConfig({
  base: './',
  plugins: [react()],
  // Номер версии и репозиторий зашиваются в код: по ним приложение понимает,
  // нет ли на GitHub сборки новее. В CI значения приходят из переменных окружения
  // (те же, что читает сборка APK), локально остаются запасными.
  define: {
    __APP_VERSION__: JSON.stringify(process.env.AVTOBAZA_VERSION_NAME ?? '0.0.0'),
    __APP_VERSION_CODE__: JSON.stringify(process.env.AVTOBAZA_VERSION_CODE ?? '0'),
    __UPDATE_REPO__: JSON.stringify('vladimirgorodok/Avtotracker'),
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 2000,
  },
  optimizeDeps: {
    exclude: ['sql.js'],
  },
});

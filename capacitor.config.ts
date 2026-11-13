import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ru.avtobaza.app',
  appName: 'АвтоБаза',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
  },
  plugins: {
    SystemBars: {
      /*
        Сразу считаем, что приложение рисуется во весь экран (viewport-fit=cover).
        Без этой подсказки при запуске окно сначала меньше, а потом раздвигается —
        подложка «прыгает» и заставка с меню уезжают в сторону.
      */
      initialViewportFitValueHint: 'cover',
      insetsHandling: 'css',
    },
  },
};

export default config;

import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ru.avtobaza.app',
  appName: 'АвтоБаза',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
  },
};

export default config;

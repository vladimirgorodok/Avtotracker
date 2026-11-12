import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ru.avtotracker.app',
  appName: 'Автотрекер',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
  },
};

export default config;

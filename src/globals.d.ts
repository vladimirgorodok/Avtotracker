/**
 * Значения, которые подставляет сборка (см. define в vite.config.ts).
 * В проверке ядра эти переменные не объявлены, поэтому в коде к ним
 * обращаются только через typeof с запасным значением.
 */
declare const __APP_VERSION__: string;
declare const __APP_VERSION_CODE__: string;
declare const __UPDATE_REPO__: string;

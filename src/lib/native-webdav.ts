/**
 * Родные запросы к Яндекс Диску.
 *
 * Обычный сетевой мост Capacitor работает через HttpURLConnection, а он пускает только
 * обычные методы (GET, POST, PUT, DELETE и ещё несколько) — методы WebDAV PROPFIND и MKCOL
 * он отвергает. Поэтому в приложении есть свой обработчик `WebDav` на OkHttp, который умеет
 * любые методы. Здесь — тонкая обёртка над ним: в браузере обработчика нет, и это честно
 * проверяется перед вызовом.
 */

import { Capacitor, registerPlugin } from '@capacitor/core';

export interface WebDavRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Двоичное тело, уже в base64 */
  bodyBase64?: string;
  /** Ждём двоичный ответ */
  binary?: boolean;
}

export interface WebDavAnswer {
  status: number;
  /** Текстовое тело (когда ответ не двоичный) */
  text: string;
  /** Двоичное тело в base64 (когда ответ двоичный) */
  base64: string;
  headers: Record<string, string>;
}

interface WebDavNative {
  request(options: WebDavRequest): Promise<{
    status: number;
    headers?: Record<string, string>;
    text?: string;
    base64?: string;
  }>;
}

const WebDav = registerPlugin<WebDavNative>('WebDav');

/** Есть ли родной обработчик: в браузере его нет, и обмен там невозможен */
export function nativeWebDavReady(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('WebDav');
  } catch {
    return false;
  }
}

/** Отправляет запрос родным обработчиком приложения */
export async function nativeWebDavRequest(request: WebDavRequest): Promise<WebDavAnswer> {
  const answer = await WebDav.request(request);
  return {
    status: Number(answer?.status ?? 0),
    text: request.binary ? '' : String(answer?.text ?? ''),
    base64: request.binary ? String(answer?.base64 ?? '') : '',
    headers: answer?.headers ?? {},
  };
}

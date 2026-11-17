/**
 * Яндекс Диск по протоколу WebDAV.
 *
 * Авторизация — логин Яндекс и «пароль приложения» с типом «WebDAV-клиент для Яндекс Диска»:
 * регистрировать приложение и получать ключи не нужно. На телефоне запросы идут родным
 * обработчиком приложения (OkHttp: методы WebDAV обычный сетевой мост Android не пропускает),
 * поэтому ограничение браузера на чужие адреса обмену не мешает: в браузере Яндекс Диск
 * по WebDAV недоступен, и об этом честно сообщаем.
 *
 * Разбор ответов (XML) и подготовка путей сделаны обычными функциями — их видно
 * в проверках без телефона.
 */

import { nativeWebDavReady, nativeWebDavRequest } from './native-webdav';

export const YADISK_HOST = 'https://webdav.yandex.ru';

/** Ошибка обмена с Яндекс Диском: текст понятен пользователю */
export class CloudError extends Error {
  readonly code: number;

  constructor(message: string, code = 0) {
    super(message);
    this.name = 'CloudError';
    this.code = code;
  }
}

/** Файл или папка на Диске */
export interface RemoteEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
}

const USER_AGENT = 'Avtobaza/1.0 (Android)';

/** Сколько раз повторяем запрос при сбое сети или ошибке сервера */
const RETRIES = 1;
const RETRY_DELAY_MS = 700;
const MAX_REDIRECTS = 3;

/* ------------------------------------------------------------------ */
/* Кодирование и пути                                                  */
/* ------------------------------------------------------------------ */

/** Строка → base64 с поддержкой кириллицы */
export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text.replace(/\s+/g, ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Путь на Диске: с ведущей «/», без двойных и хвостовых слэшей */
export function normalizePath(path: string): string {
  const trimmed = (path || '').trim().replace(/\\/g, '/');
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const clean = withLeading.replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1');
  return clean === '' ? '/' : clean;
}

/** Кодирует путь для запроса, сохраняя разделители «/» */
export function encodePath(path: string): string {
  return normalizePath(path)
    .split('/')
    .map((segment) => (segment === '' ? '' : encodeURIComponent(segment)))
    .join('/');
}

/** `href` из ответа → обычный путь «/Папка/файл» */
export function pathOfHref(href: string): string {
  const raw = href.trim();
  const withoutHost = raw.startsWith('http')
    ? raw.slice(raw.indexOf('/', raw.indexOf('://') + 3))
    : raw;
  let decoded = withoutHost;
  try {
    decoded = decodeURIComponent(withoutHost.replace(/\+/g, '%2B'));
  } catch {
    /* оставляем как есть */
  }
  const withLeading = decoded.startsWith('/') ? decoded : `/${decoded}`;
  return normalizePath(withLeading);
}

/** Человекочитаемый размер */
export function humanSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} ГБ`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} МБ`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${bytes} Б`;
}

/* ------------------------------------------------------------------ */
/* Разбор ответов WebDAV                                               */
/* ------------------------------------------------------------------ */

/** Разбирает ответ `207 Multi-Status` в список файлов и папок */
export function parseMultiStatus(xml: string): RemoteEntry[] {
  const entries: RemoteEntry[] = [];
  const blocks = xml.match(/<[^>]*response[\s>][\s\S]*?<\/[^>]*response>/gi) ?? [];
  for (const block of blocks) {
    const href = block.match(/<[^>]*href[^>]*>([\s\S]*?)<\/[^>]*href>/i)?.[1] ?? '';
    if (!href.trim()) continue;
    const displayName = block.match(/<[^>]*displayname[^>]*>([\s\S]*?)<\/[^>]*displayname>/i)?.[1] ?? '';
    const length = block.match(/<[^>]*getcontentlength[^>]*>([\s\S]*?)<\/[^>]*getcontentlength>/i)?.[1] ?? '';
    const path = pathOfHref(decodeXml(href));
    const name = decodeXml(displayName).trim() || path.slice(path.lastIndexOf('/') + 1);
    entries.push({
      name,
      path,
      isDirectory: /<[^>]*collection[\s/>]/i.test(block),
      size: Number(length.trim()) || 0,
    });
  }
  return entries;
}

/** Свободное место на Диске из ответа PROPFIND */
export function parseQuota(xml: string): number {
  const raw = xml.match(/<[^>]*quota-available-bytes[^>]*>\s*(\d+)\s*</i)?.[1] ?? '';
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

/* ------------------------------------------------------------------ */
/* Транспорт                                                           */
/* ------------------------------------------------------------------ */

interface Answer {
  status: number;
  text: string;
  base64: string;
  location: string;
}

interface Body {
  /** Текст тела (JSON, XML) */
  text?: string;
  /** Двоичное тело, уже в base64 */
  base64?: string;
  /** Content-Type тела */
  type?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function headerOf(headers: Record<string, string>, name: string): string {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === lower) return value;
  }
  return '';
}

async function once(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: Body | undefined,
  binary: boolean,
): Promise<Answer> {
  const all = body?.type ? { ...headers, 'Content-Type': body.type } : headers;

  // Телефон: родной обработчик приложения (OkHttp). Он, в отличие от сетевого моста
  // Capacitor, умеет методы WebDAV — PROPFIND и MKCOL.
  if (nativeWebDavReady()) {
    const answer = await nativeWebDavRequest({
      url,
      method,
      headers: all,
      bodyBase64: body ? (body.base64 ?? utf8ToBase64(body.text ?? '')) : undefined,
      binary,
    });
    return {
      status: answer.status,
      text: answer.text,
      base64: answer.base64,
      location: headerOf(answer.headers, 'location'),
    };
  }

  // Браузер: обычный запрос. Яндекс Диск чужие адреса не пускает, но проверки
  // и работа на телефоне от этого не зависят.
  let payload: BodyInit | undefined;
  if (body) {
    if (body.base64) {
      const bytes = base64ToBytes(body.base64);
      payload = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    } else {
      payload = body.text ?? '';
    }
  }
  const res = await fetch(url, {
    method,
    headers: all,
    body: payload,
    redirect: 'follow',
  });
  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  return {
    status: res.status,
    text: binary ? '' : new TextDecoder().decode(bytes),
    base64: binary ? bytesToBase64(bytes) : '',
    location: res.headers.get('location') ?? '',
  };
}

function networkMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/Failed to fetch|NetworkError|ERR_|network/i.test(text)) {
    return 'Не удалось связаться с Яндекс Диском — проверьте интернет. В браузере на компьютере обмен не работает: он идёт из приложения на телефоне.';
  }
  return `Ошибка сети при обмене с Яндекс Диском: ${text}`;
}

async function perform(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: Body,
  binary = false,
): Promise<Answer> {
  let target = url;
  let redirects = 0;
  let retries = 0;

  for (;;) {
    let answer: Answer;
    try {
      answer = await once(method, target, headers, body, binary);
    } catch (error) {
      if (retries < RETRIES) {
        retries++;
        await delay(RETRY_DELAY_MS);
        continue;
      }
      throw new CloudError(networkMessage(error));
    }

    if (answer.status >= 500 && retries < RETRIES) {
      retries++;
      await delay(RETRY_DELAY_MS);
      continue;
    }

    if (
      answer.status >= 300 &&
      answer.status < 400 &&
      answer.location &&
      redirects < MAX_REDIRECTS
    ) {
      redirects++;
      target = answer.location.startsWith('http')
        ? answer.location
        : YADISK_HOST + answer.location;
      continue;
    }

    return answer;
  }
}

function messageFor(code: number, what: string): string {
  if (code === 401) return `«${what}»: Яндекс не принял логин или пароль приложения`;
  if (code === 403) {
    return `«${what}»: доступ запрещён — проверьте, что пароль создан с типом «WebDAV-клиент для Яндекс Диска»`;
  }
  if (code === 404) return `«${what}»: файл или папка не найдены на Яндекс Диске`;
  if (code === 409) return `«${what}»: конфликт имён на Яндекс Диске`;
  if (code === 423) return `«${what}»: файл занят другим приложением`;
  if (code === 429) return `«${what}»: слишком много запросов, попробуйте позже`;
  if (code === 507) return `«${what}»: на Яндекс Диске закончилось свободное место`;
  if (code >= 500) return `«${what}»: сервис Яндекс Диска недоступен (код ${code})`;
  return `«${what}»: ошибка Яндекс Диска (код ${code})`;
}

function ensureSuccess(answer: Answer, what: string): void {
  if (answer.status >= 200 && answer.status < 300) return;
  throw new CloudError(messageFor(answer.status, what), answer.status);
}

/* ------------------------------------------------------------------ */
/* Клиент                                                              */
/* ------------------------------------------------------------------ */

/**
 * Обмен с Яндекс Диском: проверка доступа, папки, выгрузка и загрузка файлов.
 * Логин и пароль приложения берутся из настроек.
 */
export class YandexDisk {
  private readonly auth: string;

  constructor(login: string, password: string) {
    if (!login.trim() || !password.trim()) {
      throw new CloudError('Заполните логин Яндекс и пароль приложения');
    }
    this.auth = `Basic ${utf8ToBase64(`${login.trim()}:${password}`)}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: this.auth, 'User-Agent': USER_AGENT, Accept: '*/*', ...extra };
  }

  private url(path: string): string {
    return YADISK_HOST + encodePath(path);
  }

  /** Проверяет доступ и создаёт папку синхронизации вместе с родительскими */
  async check(folder: string): Promise<string> {
    const answer = await perform('PROPFIND', this.url('/'), this.headers({ Depth: '0' }));
    ensureSuccess(answer, 'Проверка подключения');
    await this.createChain(folder);
    const free = parseQuota(answer.text);
    return free > 0
      ? `Подключение выполнено. Свободно на Диске: ${humanSize(free)}`
      : 'Подключение выполнено';
  }

  /** Содержимое папки без самой папки */
  async list(path: string): Promise<RemoteEntry[]> {
    const target = normalizePath(path);
    const answer = await perform('PROPFIND', this.url(target), this.headers({ Depth: '1' }));
    ensureSuccess(answer, 'Чтение папки');
    return parseMultiStatus(answer.text)
      .filter((entry) => entry.path !== target)
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }

  /** Создаёт папку; уже существующая ошибкой не считается */
  async createFolder(path: string): Promise<void> {
    const answer = await perform('MKCOL', this.url(path), this.headers());
    if (answer.status >= 200 && answer.status < 300) return;
    if (answer.status === 405 || answer.status === 301) return;
    throw new CloudError(messageFor(answer.status, 'Создание папки'), answer.status);
  }

  /** Создаёт папку вместе со всеми родительскими */
  async createChain(path: string): Promise<void> {
    const target = normalizePath(path);
    if (target === '/') return;
    let current = '';
    for (const segment of target.split('/').filter(Boolean)) {
      current += `/${segment}`;
      await this.createFolder(current);
    }
  }

  /** Выгружает текстовый файл (JSON) */
  async putText(path: string, text: string, type = 'application/json'): Promise<void> {
    const answer = await perform('PUT', this.url(path), this.headers(), { text, type });
    ensureSuccess(answer, 'Сохранение копии');
  }

  /** Выгружает двоичный файл (архив значков) */
  async putBytes(path: string, bytes: Uint8Array, type = 'application/zip'): Promise<void> {
    const answer = await perform('PUT', this.url(path), this.headers(), {
      base64: bytesToBase64(bytes),
      type,
    });
    ensureSuccess(answer, 'Сохранение архива значков');
  }

  async getText(path: string): Promise<string> {
    const answer = await perform('GET', this.url(path), this.headers());
    ensureSuccess(answer, 'Загрузка копии');
    return answer.text;
  }

  async getBytes(path: string): Promise<Uint8Array> {
    const answer = await perform('GET', this.url(path), this.headers(), undefined, true);
    ensureSuccess(answer, 'Загрузка архива значков');
    return base64ToBytes(answer.base64);
  }

  /** Размер файла на Диске или null, если файла нет */
  async size(path: string): Promise<number | null> {
    const target = normalizePath(path);
    const answer = await perform('PROPFIND', this.url(target), this.headers({ Depth: '0' }));
    if (answer.status < 200 || answer.status >= 300) return null;
    const entries = parseMultiStatus(answer.text);
    const found = entries.find((entry) => entry.path === target) ?? entries[0];
    return found ? found.size : null;
  }

  async remove(path: string): Promise<void> {
    const answer = await perform('DELETE', this.url(path), this.headers());
    if (answer.status >= 200 && answer.status < 300) return;
    if (answer.status === 404) return;
    throw new CloudError(messageFor(answer.status, 'Удаление старой копии'), answer.status);
  }
}

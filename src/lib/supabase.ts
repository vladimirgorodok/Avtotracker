/**
 * Клиент Supabase: вход по почте и паролю, работа с таблицами и файлами.
 * Ключ проекта и адрес вводятся в настройках приложения, в коде не хранятся.
 */

import { useApp } from '../store';
import type { AppSettings } from '../types';

export interface SupabaseConfig {
  url: string;
  key: string;
}

export function readConfig(): SupabaseConfig | null {
  const s = useApp.getState().settings;
  const url = s.supabase_url.trim().replace(/\/+$/, '');
  const key = s.supabase_key.trim();
  if (!url || !key) return null;
  return { url, key };
}

export function isConfigured(): boolean {
  return readConfig() !== null;
}

export function isSignedIn(): boolean {
  const s = useApp.getState().settings;
  return s.supabase_access_token !== '' && s.supabase_user_id !== '';
}

export class SupabaseError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
    this.name = 'SupabaseError';
  }
}

/**
 * Что не так с адресом проекта. Пустая строка — адрес выглядит правдоподобно.
 * Частая ошибка — вставить адрес сайта supabase.com вместо адреса своего проекта.
 */
export function urlProblem(url: string): string {
  const value = url.trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) return 'Адрес должен начинаться с https://';
  const host = value.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
  if (host === 'supabase.com' || host === 'www.supabase.com' || host === 'app.supabase.com') {
    return 'Это адрес сайта Supabase, а не вашего проекта. Нужен адрес вида https://xxxx.supabase.co — его видно в проекте: Settings → API.';
  }
  if (!/\.supabase\.(co|in)$/.test(host)) {
    return 'Адрес проекта обычно выглядит так: https://xxxx.supabase.co';
  }
  return '';
}

/** Понятное объяснение вместо «Failed to fetch» */
function networkHint(url: string): string {
  const problem = urlProblem(url);
  if (problem) return problem;
  return `Не удалось связаться с ${url}: нет интернета или адрес проекта указан неверно.`;
}

async function request(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string>; token?: string | null; raw?: boolean } = {},
): Promise<unknown> {
  const cfg = readConfig();
  if (!cfg) throw new SupabaseError('Не указаны адрес и ключ проекта Supabase');
  const token = options.token ?? useApp.getState().settings.supabase_access_token;

  let res: Response;
  try {
    res = await fetch(`${cfg.url}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${token || cfg.key}`,
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers ?? {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new SupabaseError(networkHint(cfg.url), 0);
  }

  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const json = (await res.json()) as { message?: string; error_description?: string; msg?: string; hint?: string };
      detail = json.message ?? json.error_description ?? json.msg ?? json.hint ?? detail;
    } catch {
      /* тело не JSON */
    }
    throw new SupabaseError(detail, res.status);
  }

  if (options.raw) return res;
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text) as unknown;
}

/* ---------- Вход ---------- */

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  user?: { id?: string; email?: string };
  error?: string;
  error_description?: string;
}

function applyToken(json: TokenResponse): void {
  const store = useApp.getState();
  const expiresAt = new Date(Date.now() + (json.expires_in ?? 3600) * 1000).toISOString();
  store.patch({
    supabase_access_token: json.access_token ?? '',
    supabase_refresh_token: json.refresh_token ?? store.settings.supabase_refresh_token,
    supabase_user_id: json.user?.id ?? store.settings.supabase_user_id,
    supabase_expires_at: expiresAt,
    supabase_email: json.user?.email ?? store.settings.supabase_email,
    sync_last_error: '',
  });
  const s = useApp.getState().settings;
  store.saveSetting('supabase_access_token', s.supabase_access_token);
  store.saveSetting('supabase_refresh_token', s.supabase_refresh_token);
  store.saveSetting('supabase_user_id', s.supabase_user_id);
  store.saveSetting('supabase_expires_at', s.supabase_expires_at);
  store.saveSetting('supabase_email', s.supabase_email);
}

export async function signIn(email: string, password: string): Promise<void> {
  const json = (await request('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email, password },
    token: null,
  })) as TokenResponse;
  if (!json.access_token) throw new SupabaseError(json.error_description ?? 'Не удалось войти');
  applyToken(json);
}

export async function signUp(email: string, password: string): Promise<string> {
  const json = (await request('/auth/v1/signup', {
    method: 'POST',
    body: { email, password },
    token: null,
  })) as TokenResponse;
  if (json.access_token) {
    applyToken(json);
    return 'Учётная запись создана, вход выполнен';
  }
  return 'Заявка отправлена. Подтвердите почту по ссылке из письма, затем войдите.';
}

export function signOut(): void {
  const store = useApp.getState();
  store.patch({
    supabase_access_token: '',
    supabase_refresh_token: '',
    supabase_user_id: '',
    supabase_expires_at: '',
  });
  for (const key of ['supabase_access_token', 'supabase_refresh_token', 'supabase_user_id', 'supabase_expires_at'] as const) {
    store.saveSetting(key, '');
  }
}

/** Обновить токен, если срок истекает */
export async function ensureToken(): Promise<void> {
  const s = useApp.getState().settings;
  if (!s.supabase_access_token) throw new SupabaseError('Нужно войти в облако');
  const expires = Date.parse(s.supabase_expires_at || '');
  if (Number.isFinite(expires) && expires - 60_000 > Date.now()) return;
  if (!s.supabase_refresh_token) throw new SupabaseError('Срок входа истёк, войдите заново');
  const json = (await request('/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    body: { refresh_token: s.supabase_refresh_token },
    token: null,
  })) as TokenResponse;
  if (!json.access_token) throw new SupabaseError('Срок входа истёк, войдите заново');
  applyToken(json);
}

/* ---------- Таблицы ---------- */

export const PULL_LIMIT = 1000;

/** Отправить записи в облако (совпадающие id перезаписываются) */
export async function upsertRows(table: string, rows: Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;
  await request(`/rest/v1/${table}`, {
    method: 'POST',
    body: rows,
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
  });
}

/** Забрать записи, изменённые после указанного момента */
export async function fetchRows(
  table: string,
  since: string,
  limit = PULL_LIMIT,
): Promise<Record<string, unknown>[]> {
  const query = new URLSearchParams({
    select: '*',
    order: 'updated_at.asc',
    limit: String(limit),
  });
  if (since) query.set('updated_at', `gt.${since}`);
  const json = await request(`/rest/v1/${table}?${query.toString()}`);
  return Array.isArray(json) ? (json as Record<string, unknown>[]) : [];
}

/** Сколько всего записей в облачной таблице */
export async function countRemote(table: string): Promise<number> {
  const res = (await request(`/rest/v1/${table}?select=id`, {
    method: 'HEAD',
    headers: { Prefer: 'count=exact', Range: '0-0' },
    raw: true,
  })) as Response;
  const range = res.headers.get('content-range');
  if (!range) return 0;
  const total = range.split('/')[1];
  return total ? Number(total) : 0;
}

/* ---------- Файлы ---------- */

export const BUCKET = 'documents';

export async function uploadFile(path: string, bytes: Uint8Array, mime: string): Promise<void> {
  const cfg = readConfig();
  if (!cfg) throw new SupabaseError('Не указаны адрес и ключ проекта Supabase');
  const s = useApp.getState().settings;
  const res = await fetch(`${cfg.url}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: cfg.key,
      Authorization: `Bearer ${s.supabase_access_token || cfg.key}`,
      'Content-Type': mime,
      'x-upsert': 'true',
      'cache-control': '3600',
    },
    body: bytes as unknown as BodyInit,
  });
  if (!res.ok) {
    let detail = `Не удалось загрузить файл (${res.status})`;
    try {
      const json = (await res.json()) as { message?: string };
      detail = json.message ?? detail;
    } catch {
      /* тело не JSON */
    }
    throw new SupabaseError(detail, res.status);
  }
}

export async function downloadFile(path: string): Promise<Uint8Array | null> {
  const cfg = readConfig();
  if (!cfg) return null;
  const s = useApp.getState().settings;
  const res = await fetch(`${cfg.url}/storage/v1/object/${BUCKET}/${path}`, {
    headers: {
      apikey: cfg.key,
      Authorization: `Bearer ${s.supabase_access_token || cfg.key}`,
    },
  });
  if (!res.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}

export async function removeFile(path: string): Promise<void> {
  const cfg = readConfig();
  if (!cfg) return;
  const s = useApp.getState().settings;
  await fetch(`${cfg.url}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'DELETE',
    headers: {
      apikey: cfg.key,
      Authorization: `Bearer ${s.supabase_access_token || cfg.key}`,
    },
  });
}

export function settingsSnapshot(): AppSettings {
  return useApp.getState().settings;
}

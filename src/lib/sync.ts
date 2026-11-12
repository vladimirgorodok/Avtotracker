/**
 * Синхронизация с облаком: отправка локальных изменений, приём чужих,
 * передача фото документов.
 *
 * Правило разрешения конфликтов: побеждает запись с более новым updated_at.
 * Время последней отправки и приёма хранится в настройках, поэтому повторная
 * синхронизация отправляет только изменения.
 */

import { dbSync } from '../db';
import { countRows, nowIso, updateRow } from '../db/repo';
import { useApp } from '../store';
import { getBlob, putBlob } from './files';
import * as sb from './supabase';
import { TABLES, type TableName } from '../types';

const PUSH_BATCH = 400;
/** Перекрытие по времени при приёме: защита от расхождения часов */
const PULL_OVERLAP_MS = 10 * 60 * 1000;

export interface SyncState {
  configured: boolean;
  signedIn: boolean;
  /** Сколько локальных записей ждёт отправки */
  pending: number;
  lastSyncAt: string;
  lastError: string;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  files: number;
  errors: string[];
  startedAt: string;
  finishedAt: string;
}

function settings() {
  return useApp.getState().settings;
}

/** Сколько записей изменено после последней отправки */
export function pendingCount(): number {
  const since = settings().sync_pushed_at;
  let total = 0;
  for (const table of TABLES) {
    total += countRows(table, since ? 'updated_at > ?' : '1=1', since ? [since] : []);
  }
  return total;
}

export function syncState(): SyncState {
  const s = settings();
  return {
    configured: sb.isConfigured(),
    signedIn: sb.isSignedIn(),
    pending: pendingCount(),
    lastSyncAt: s.sync_last_at,
    lastError: s.sync_last_error,
  };
}

function rowsToPush(table: TableName, since: string): Record<string, unknown>[] {
  const db = dbSync();
  const sql = since
    ? `SELECT * FROM ${table} WHERE updated_at > ? ORDER BY updated_at ASC LIMIT ${PUSH_BATCH}`
    : `SELECT * FROM ${table} ORDER BY updated_at ASC LIMIT ${PUSH_BATCH}`;
  const rows = db.all<Record<string, unknown>>(sql, since ? [since] : []);
  const userId = settings().supabase_user_id;
  return rows.map((r) => ({ ...r, user_id: userId }));
}

/** Локальные записи, которые ещё не отправлены (для индикатора) */
export function pendingByTable(): { table: TableName; count: number }[] {
  const since = settings().sync_pushed_at;
  return TABLES.map((table) => ({
    table,
    count: countRows(table, since ? 'updated_at > ?' : '1=1', since ? [since] : []),
  })).filter((x) => x.count > 0);
}

/** Записи, ожидающие отправки в облако (для списков) */
export function pendingIds(): Set<string> {
  const since = settings().sync_pushed_at;
  const out = new Set<string>();
  for (const table of TABLES) {
    const rows = dbSync().all<{ id: string }>(
      `SELECT id FROM ${table} WHERE ${since ? 'updated_at > ?' : '1=1'}`,
      since ? [since] : [],
    );
    for (const r of rows) out.add(`${table}:${r.id}`);
  }
  return out;
}

export function isPending(table: string, id: string): boolean {
  const since = settings().sync_pushed_at;
  if (!since) return true;
  const row = dbSync().one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE id = ? AND updated_at > ?`,
    [id, since],
  );
  return (row?.n ?? 0) > 0;
}

/** Записать момент, до которого всё отправлено */
function markPushed(upTo: string): void {
  const store = useApp.getState();
  const current = settings().sync_pushed_at;
  const next = !current || upTo > current ? upTo : current;
  store.saveSetting('sync_pushed_at', next);
}

function markPulled(upTo: string): void {
  const store = useApp.getState();
  const current = settings().sync_pulled_at;
  const next = !current || upTo > current ? upTo : current;
  store.saveSetting('sync_pulled_at', next);
}

async function pushTable(table: TableName): Promise<number> {
  let pushed = 0;
  for (;;) {
    const since = settings().sync_pushed_at;
    const rows = rowsToPush(table, since);
    if (rows.length === 0) break;
    // отправляем всё, кроме служебных колонок, которых нет в облаке
    await sb.upsertRows(table, rows);
    pushed += rows.length;
    const last = String(rows[rows.length - 1].updated_at ?? '');
    if (last) markPushed(last);
    if (rows.length < PUSH_BATCH) break;
  }
  return pushed;
}

async function pullTable(table: TableName, errors: string[]): Promise<number> {
  const db = dbSync();
  const sinceRaw = settings().sync_pulled_at;
  const since = sinceRaw ? new Date(Date.parse(sinceRaw) - PULL_OVERLAP_MS).toISOString() : '';
  let pulled = 0;
  let newest = sinceRaw;

  for (;;) {
    let rows: Record<string, unknown>[];
    try {
      rows = await sb.fetchRows(table, since);
    } catch (e) {
      errors.push(`${table}: ${e instanceof Error ? e.message : String(e)}`);
      return pulled;
    }
    if (rows.length === 0) break;

    db.tx(() => {
      for (const remote of rows) {
        const id = String(remote.id ?? '');
        if (!id) continue;
        const clean: Record<string, unknown> = { ...remote };
        delete clean.user_id;
        const local = dbSync().one<{ updated_at: string }>(
          `SELECT updated_at FROM ${table} WHERE id = ?`,
          [id],
        );
        const remoteTime = String(clean.updated_at ?? '');
        if (local && local.updated_at >= remoteTime) continue;
        if (local) {
          const entries = Object.entries(clean).filter(([k]) => k !== 'id');
          updateRow(table, id, Object.fromEntries(entries));
        } else {
          const keys = Object.keys(clean);
          dbSync().run(
            `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
            keys.map((k) => normalizeValue(clean[k])),
          );
        }
        pulled++;
        if (remoteTime > (newest ?? '')) newest = remoteTime;
      }
    });

    if (rows.length < sb.PULL_LIMIT) break;
    // при большом объёме сдвигаем окно приёма
    if (newest) {
      markPulled(newest);
      return pulled;
    }
    break;
  }

  if (newest) markPulled(newest);
  return pulled;
}

function normalizeValue(v: unknown): string | number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/* ---------- Файлы документов ---------- */

function attachmentRows(): Record<string, unknown>[] {
  const since = settings().sync_pushed_at;
  const sql = since
    ? `SELECT * FROM attachments WHERE deleted = 0 AND updated_at > ? ORDER BY updated_at ASC LIMIT ${PUSH_BATCH}`
    : `SELECT * FROM attachments WHERE deleted = 0 ORDER BY updated_at ASC LIMIT ${PUSH_BATCH}`;
  return dbSync().all<Record<string, unknown>>(sql, since ? [since] : []);
}

async function uploadMissingFiles(errors: string[]): Promise<number> {
  const userId = settings().supabase_user_id;
  let sent = 0;
  for (const row of attachmentRows()) {
    const key = String(row.path ?? '');
    if (!key) continue;
    const remotePath = `${userId}/${key}`;
    const bytes = await getBlob(key);
    if (!bytes) continue;
    try {
      await sb.uploadFile(remotePath, bytes, String(row.mime ?? 'image/jpeg'));
      sent++;
    } catch (e) {
      errors.push(`файл ${key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return sent;
}

/** Скачать из облака файлы, которых нет на устройстве */
export async function downloadMissingFiles(errors: string[] = []): Promise<number> {
  const userId = settings().supabase_user_id;
  const rows = dbSync().all<{ id: string; path: string; mime: string }>(
    'SELECT id, path, mime FROM attachments WHERE deleted = 0',
  );
  let got = 0;
  for (const row of rows) {
    const local = await getBlob(row.path);
    if (local) continue;
    try {
      const bytes = await sb.downloadFile(`${userId}/${row.path}`);
      if (bytes) {
        await putBlob(row.path, bytes);
        got++;
      }
    } catch (e) {
      errors.push(`файл ${row.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return got;
}

/* ---------- Общий запуск ---------- */

export async function runSync(): Promise<SyncResult> {
  const store = useApp.getState();
  const startedAt = nowIso();
  const errors: string[] = [];

  if (!sb.isConfigured()) throw new Error('Укажите адрес и ключ проекта Supabase');
  await sb.ensureToken();

  let pushed = 0;
  let pulled = 0;

  for (const table of TABLES) {
    try {
      pushed += await pushTable(table);
    } catch (e) {
      errors.push(`${table} (отправка): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  for (const table of TABLES) {
    pulled += await pullTable(table, errors);
  }

  let files = 0;
  try {
    files += await uploadMissingFiles(errors);
    files += await downloadMissingFiles(errors);
  } catch (e) {
    errors.push(`файлы: ${e instanceof Error ? e.message : String(e)}`);
  }

  const finishedAt = nowIso();
  store.saveSetting('sync_last_at', finishedAt);
  store.saveSetting('sync_last_error', errors.join('; '));
  store.touch();

  return { pushed, pulled, files, errors, startedAt, finishedAt };
}

/** Сбросить отметки синхронизации: следующая синхронизация отправит всё заново */
export function resetSyncMarkers(): void {
  const store = useApp.getState();
  store.saveSetting('sync_pushed_at', '');
  store.saveSetting('sync_pulled_at', '');
  store.saveSetting('sync_last_at', '');
  store.saveSetting('sync_last_error', '');
}

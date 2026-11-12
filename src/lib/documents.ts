/**
 * Документы: фото накладных, чеков, ТТН.
 * Файлы лежат отдельно от базы (на телефоне — в папке приложения, в браузере — в IndexedDB),
 * в базе хранится только описание. Так база остаётся быстрой при больших объёмах.
 */

import { dbSync } from '../db';
import { insertRow, softDelete, uid, updateRow } from '../db/repo';
import { deleteBlob, downscaleImage, getBlob, putBlob, bytesToDataUrl } from './files';

export interface DocumentRow {
  id: string;
  owner_table: string;
  owner_id: string;
  title: string;
  mime: string;
  path: string;
  thumb_path: string;
  size: number;
  created_at: string;
  updated_at: string;
  deleted: 0 | 1;
}

export function listDocuments(ownerTable: string, ownerId: string): DocumentRow[] {
  return dbSync().all<DocumentRow>(
    `SELECT * FROM attachments WHERE deleted = 0 AND owner_table = ? AND owner_id = ?
     ORDER BY created_at ASC`,
    [ownerTable, ownerId],
  );
}

export function countDocuments(ownerTable: string, ownerId: string): number {
  const row = dbSync().one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM attachments WHERE deleted = 0 AND owner_table = ? AND owner_id = ?`,
    [ownerTable, ownerId],
  );
  return row?.n ?? 0;
}

/** Добавить фото: сжимаем, кладём файл рядом с базой, в базу пишем описание */
export async function addPhoto(
  ownerTable: string,
  ownerId: string,
  file: Blob,
  title = '',
): Promise<string> {
  const id = uid();
  const { full, thumb, mime } = await downscaleImage(file);
  const path = `${id}.jpg`;
  const thumbPath = `${id}.thumb.jpg`;
  await putBlob(path, full);
  await putBlob(thumbPath, thumb);
  insertRow('attachments', {
    id,
    owner_table: ownerTable,
    owner_id: ownerId,
    title: title || `Фото от ${new Date().toLocaleDateString('ru-RU')}`,
    mime,
    path,
    size: full.length,
    thumb_path: thumbPath,
  });
  return id;
}

/** Изображение в виде data-ссылки: уменьшенное или полное */
export async function documentDataUrl(doc: DocumentRow, thumb = false): Promise<string | null> {
  const key = thumb ? doc.thumb_path || doc.path : doc.path;
  const bytes = await getBlob(key);
  if (!bytes) {
    // миниатюры может не быть — покажем основной файл
    const fallback = await getBlob(doc.path);
    return fallback ? bytesToDataUrl(fallback, doc.mime || 'image/jpeg') : null;
  }
  return bytesToDataUrl(bytes, doc.mime || 'image/jpeg');
}

export async function renameDocument(id: string, title: string): Promise<void> {
  updateRow('attachments', id, { title });
}

export async function deleteDocument(id: string): Promise<void> {
  const row = dbSync().one<DocumentRow>('SELECT * FROM attachments WHERE id = ?', [id]);
  softDelete('attachments', id);
  if (row) {
    await deleteBlob(row.path);
    if (row.thumb_path) await deleteBlob(row.thumb_path);
  }
}

/** Все файлы, которые сейчас есть у документов */
export function allDocumentRows(): DocumentRow[] {
  return dbSync().all<DocumentRow>('SELECT * FROM attachments WHERE deleted = 0');
}

export function documentSummary(): { count: number; bytes: number; lastAt: string } {
  const row = dbSync().one<{ n: number; s: number | null; last: string | null }>(
    'SELECT COUNT(*) AS n, SUM(size) AS s, MAX(created_at) AS last FROM attachments WHERE deleted = 0',
  );
  return { count: row?.n ?? 0, bytes: Number(row?.s ?? 0), lastAt: row?.last ?? '' };
}

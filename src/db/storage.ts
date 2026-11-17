/**
 * Хранение файла базы данных.
 * На телефоне (Android) — файл в личной папке приложения через Capacitor Filesystem.
 * В браузере — IndexedDB.
 *
 * Рядом с базой всегда лежит её копия (avtobaza.db.bak): состояние на момент
 * запуска приложения. Копия обновляется перед первой записью новой сессии, поэтому
 * одна версия данных всегда остаётся целой.
 *
 * Если файл базы есть, но прочитать его не удалось, база открывается пустой и
 * помечается как «не читается»: до решения пользователя файл не перезаписывается,
 * иначе пустая база затрёт данные. Разобраться помогают копия и «отложенный» файл.
 */

import { Capacitor } from '@capacitor/core';

const DB_FILE = 'avtobaza.db';
const DB_BACKUP = 'avtobaza.db.bak';
/** Прежнее имя базы (до переименования приложения) — читаем, если нового файла нет */
const DB_FILE_OLD = 'avtotracker.db';
const IDB_NAME = 'avtobaza';
const IDB_STORE = 'files';

/** Сведения о копии базы на устройстве */
export interface BackupInfo {
  size: number;
  /** Когда сделана копия (ISO) или '' — если дата неизвестна */
  at: string;
}

export interface Persister {
  load(): Promise<Uint8Array | null>;
  save(data: Uint8Array): Promise<void>;
  /** Откуда читается база — для диагностики в настройках */
  describe(): string;
  /** Почему базу не удалось прочитать (файл есть, но открыть не вышло) */
  problem(): string | null;
  /** Обновить копию базы на устройстве */
  writeBackup(bytes: Uint8Array): Promise<void>;
  /** Сделать копию текущей базы на устройстве */
  snapshot(): Promise<void>;
  /** Что лежит в копии */
  backupInfo(): Promise<BackupInfo | null>;
  /** Вернуть копию на место базы */
  restoreBackup(): Promise<boolean>;
  /** Отложить непрочитанный файл в сторону, чтобы не затереть его */
  parkBroken(): Promise<string | null>;
}

function toBase64(bytes: Uint8Array): string {
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(out);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Файлы Capacitor отдаёт строкой base64 или Blob — принимаем оба вида */
async function toBytes(raw: unknown): Promise<Uint8Array> {
  if (typeof raw === 'string') return fromBase64(raw);
  const blob = raw as Blob | null;
  if (blob && typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new Uint8Array(0);
}

class NativePersister implements Persister {
  /** Что было в файле при запуске — это и станет копией */
  private firstBytes: Uint8Array | null = null;
  private trouble: string | null = null;

  private async fs() {
    return await import('@capacitor/filesystem');
  }

  private async exists(path: string): Promise<boolean> {
    const { Filesystem, Directory } = await this.fs();
    try {
      await Filesystem.stat({ path, directory: Directory.Data });
      return true;
    } catch {
      return false;
    }
  }

  private async read(path: string): Promise<Uint8Array | null> {
    const { Filesystem, Directory } = await this.fs();
    try {
      const res = await Filesystem.readFile({ path, directory: Directory.Data });
      return await toBytes(res.data);
    } catch {
      return null;
    }
  }

  private async write(path: string, bytes: Uint8Array): Promise<void> {
    const { Filesystem, Directory } = await this.fs();
    await Filesystem.writeFile({
      path,
      directory: Directory.Data,
      data: toBase64(bytes),
      recursive: true,
    });
  }

  async load(): Promise<Uint8Array | null> {
    for (const name of [DB_FILE, DB_FILE_OLD]) {
      if (!(await this.exists(name))) continue;
      const bytes = await this.read(name);
      if (!bytes || bytes.length === 0) {
        this.trouble =
          `База «${name}» есть на устройстве, но прочитать её не удалось. ` +
          'Мы не перезаписываем этот файл, чтобы не потерять данные.';
        return null;
      }
      this.firstBytes = bytes;
      return bytes;
    }
    return null;
  }

  async save(data: Uint8Array): Promise<void> {
    await this.write(DB_FILE, data);
  }

  async writeBackup(bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0) return;
    await this.write(DB_BACKUP, bytes);
  }

  async snapshot(): Promise<void> {
    const current = (await this.read(DB_FILE)) ?? this.firstBytes;
    if (!current || current.length === 0) {
      throw new Error('Копировать пока нечего: база ещё ни разу не сохранялась');
    }
    await this.write(DB_BACKUP, current);
  }

  async backupInfo(): Promise<BackupInfo | null> {
    const { Filesystem, Directory } = await this.fs();
    try {
      const info = await Filesystem.stat({ path: DB_BACKUP, directory: Directory.Data });
      return {
        size: Number(info.size ?? 0),
        at: info.mtime ? new Date(Number(info.mtime)).toISOString() : '',
      };
    } catch {
      return null;
    }
  }

  async restoreBackup(): Promise<boolean> {
    const bytes = await this.read(DB_BACKUP);
    if (!bytes || bytes.length === 0) return false;
    await this.write(DB_FILE, bytes);
    return true;
  }

  async parkBroken(): Promise<string | null> {
    const { Filesystem, Directory } = await this.fs();
    for (const name of [DB_FILE, DB_FILE_OLD]) {
      if (!(await this.exists(name))) continue;
      const target = `${name}.broken`;
      try {
        await Filesystem.deleteFile({ path: target, directory: Directory.Data }).catch(
          () => undefined,
        );
        await Filesystem.rename({ from: name, to: target, directory: Directory.Data });
        return target;
      } catch {
        return null;
      }
    }
    return null;
  }

  problem() {
    return this.trouble;
  }

  describe() {
    return 'Файл приложения: avtobaza.db';
  }
}

class IdbPersister implements Persister {
  private firstBytes: Uint8Array | null = null;
  private trouble: string | null = null;

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private async withStore<T>(
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore) => IDBRequest,
  ): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, mode);
      const req = fn(tx.objectStore(IDB_STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  }

  private async getRaw(key: string): Promise<Uint8Array | null> {
    try {
      const v = await this.withStore<Uint8Array | undefined>('readonly', (s) => s.get(key));
      return v ? new Uint8Array(v) : null;
    } catch {
      return null;
    }
  }

  private async get(key: string): Promise<Uint8Array | null> {
    const v = await this.getRaw(key);
    return v && v.length > 0 ? v : null;
  }

  private async has(key: string): Promise<boolean> {
    try {
      const v = await this.withStore<unknown>('readonly', (s) => s.get(key));
      return v !== undefined && v !== null;
    } catch {
      return false;
    }
  }

  private async put(key: string, bytes: Uint8Array): Promise<void> {
    await this.withStore('readwrite', (s) => s.put(bytes, key));
  }

  private async drop(key: string): Promise<void> {
    await this.withStore('readwrite', (s) => s.delete(key)).catch(() => undefined);
  }

  async load(): Promise<Uint8Array | null> {
    for (const key of [DB_FILE, DB_FILE_OLD]) {
      if (!(await this.has(key))) continue;
      const bytes = await this.get(key);
      if (!bytes) {
        this.trouble =
          `База «${key}» есть в хранилище браузера, но прочитать её не удалось. ` +
          'Мы не перезаписываем её, чтобы не потерять данные.';
        return null;
      }
      this.firstBytes = bytes;
      return bytes;
    }
    return null;
  }

  async save(data: Uint8Array): Promise<void> {
    await this.put(DB_FILE, data);
  }

  async writeBackup(bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0) return;
    await this.put(DB_BACKUP, bytes);
  }

  async snapshot(): Promise<void> {
    const current = (await this.get(DB_FILE)) ?? this.firstBytes;
    if (!current || current.length === 0) {
      throw new Error('Копировать пока нечего: база ещё ни разу не сохранялась');
    }
    await this.put(DB_BACKUP, current);
  }

  async backupInfo(): Promise<BackupInfo | null> {
    const bytes = await this.get(DB_BACKUP);
    if (!bytes) return null;
    return { size: bytes.length, at: '' };
  }

  async restoreBackup(): Promise<boolean> {
    const bytes = await this.get(DB_BACKUP);
    if (!bytes) return false;
    await this.put(DB_FILE, bytes);
    return true;
  }

  async parkBroken(): Promise<string | null> {
    for (const key of [DB_FILE, DB_FILE_OLD]) {
      if (!(await this.has(key))) continue;
      const target = `${key}.broken`;
      const bytes = await this.getRaw(key);
      await this.drop(target);
      if (bytes) await this.put(target, bytes).catch(() => undefined);
      await this.drop(key);
      return target;
    }
    return null;
  }

  problem() {
    return this.trouble;
  }

  describe() {
    return 'Хранилище браузера (IndexedDB)';
  }
}

export function createPersister(): Persister {
  return Capacitor.isNativePlatform() ? new NativePersister() : new IdbPersister();
}

/** Скачивание файла: на телефоне через «Поделиться», в браузере обычным сохранением */
export async function saveBinaryFile(
  filename: string,
  data: Uint8Array | string,
  mime = 'application/octet-stream',
): Promise<void> {
  const blob = typeof data === 'string' ? new Blob([data], { type: mime }) : new Blob([data as BlobPart], { type: mime });

  if (Capacitor.isNativePlatform()) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const base64 = typeof data === 'string' ? btoa(unescape(encodeURIComponent(data))) : toBase64(data);
    const res = await Filesystem.writeFile({
      path: filename,
      directory: Directory.Cache,
      data: base64,
      recursive: true,
    });
    try {
      await Share.share({ title: filename, url: res.uri, dialogTitle: 'Сохранить или отправить файл' });
    } catch {
      /* пользователь закрыл окно */
    }
    return;
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Чтение выбранного пользователем файла */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

export async function fileToBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

export async function fileToText(file: File): Promise<string> {
  return await file.text();
}

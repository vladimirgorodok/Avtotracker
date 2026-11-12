/**
 * Хранение файла базы данных.
 * На телефоне (Android) — файл в личной папке приложения через Capacitor Filesystem.
 * В браузере — IndexedDB.
 */

import { Capacitor } from '@capacitor/core';

const DB_FILE = 'avtotracker.db';
const IDB_NAME = 'avtotracker';
const IDB_STORE = 'files';

export interface Persister {
  load(): Promise<Uint8Array | null>;
  save(data: Uint8Array): Promise<void>;
  /** Откуда читается база — для диагностики в настройках */
  describe(): string;
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

class NativePersister implements Persister {
  async load(): Promise<Uint8Array | null> {
    try {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      const res = await Filesystem.readFile({ path: DB_FILE, directory: Directory.Data });
      const data = typeof res.data === 'string' ? res.data : '';
      return fromBase64(data);
    } catch {
      return null;
    }
  }

  async save(data: Uint8Array): Promise<void> {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    await Filesystem.writeFile({
      path: DB_FILE,
      directory: Directory.Data,
      data: toBase64(data),
      recursive: true,
    });
  }

  describe() {
    return 'Файл приложения: avtotracker.db';
  }
}

class IdbPersister implements Persister {
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

  private async withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, mode);
      const req = fn(tx.objectStore(IDB_STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  }

  async load(): Promise<Uint8Array | null> {
    try {
      const v = await this.withStore<Uint8Array | undefined>('readonly', (s) => s.get(DB_FILE));
      return v ? new Uint8Array(v) : null;
    } catch {
      return null;
    }
  }

  async save(data: Uint8Array): Promise<void> {
    await this.withStore('readwrite', (s) => s.put(data, DB_FILE));
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

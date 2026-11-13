/**
 * Хранилище бинарных файлов (фото документов).
 * На телефоне — файлы в личной папке приложения, в браузере — IndexedDB.
 */

import { Capacitor } from '@capacitor/core';

const IDB_NAME = 'avtobaza';
const IDB_STORE = 'files';
const FOLDER = 'blobs';

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

function openIdb(): Promise<IDBDatabase> {
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

async function idb<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openIdb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, mode);
    const req = fn(tx.objectStore(IDB_STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

const idbKey = (key: string) => `blob:${key}`;

/** Сохранить файл */
export async function putBlob(key: string, bytes: Uint8Array): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    await Filesystem.writeFile({
      path: `${FOLDER}/${key}`,
      directory: Directory.Data,
      data: toBase64(bytes),
      recursive: true,
    });
    return;
  }
  await idb('readwrite', (s) => s.put(bytes, idbKey(key)));
}

/** Прочитать файл или null */
export async function getBlob(key: string): Promise<Uint8Array | null> {
  try {
    if (Capacitor.isNativePlatform()) {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      const res = await Filesystem.readFile({ path: `${FOLDER}/${key}`, directory: Directory.Data });
      return fromBase64(typeof res.data === 'string' ? res.data : '');
    }
    const v = await idb<Uint8Array | undefined>('readonly', (s) => s.get(idbKey(key)));
    return v ? new Uint8Array(v) : null;
  } catch {
    return null;
  }
}

/** Удалить файл */
export async function deleteBlob(key: string): Promise<void> {
  try {
    if (Capacitor.isNativePlatform()) {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      await Filesystem.deleteFile({ path: `${FOLDER}/${key}`, directory: Directory.Data });
      return;
    }
    await idb('readwrite', (s) => s.delete(idbKey(key)));
  } catch {
    /* файла уже нет */
  }
}

export function bytesToDataUrl(bytes: Uint8Array, mime = 'image/jpeg'): string {
  return `data:${mime};base64,${toBase64(bytes)}`;
}

/** Разбирает data URL обратно в байты — например, чтобы сохранить картинку файлом */
export function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mime: string } | null {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const mime = match[1] && match[1] !== '' ? match[1] : 'image/png';
  const body = match[3] ?? '';
  if (match[2]) return { bytes: fromBase64(body), mime };
  try {
    return { bytes: new TextEncoder().encode(decodeURIComponent(body)), mime };
  } catch {
    return null;
  }
}

/** Уменьшить изображение, чтобы база и облако не разрастались */
export async function downscaleImage(
  file: Blob,
  maxSize = 1600,
  quality = 0.82,
): Promise<{ full: Uint8Array; thumb: Uint8Array; mime: string }> {
  const bitmap = await loadBitmap(file);
  const full = await drawToJpeg(bitmap, maxSize, quality);
  const thumb = await drawToJpeg(bitmap, 360, 0.6);
  if ('close' in bitmap && typeof bitmap.close === 'function') bitmap.close();
  return { full, thumb, mime: 'image/jpeg' };
}

interface BitmapLike {
  width: number;
  height: number;
  close?: () => void;
}

async function loadBitmap(file: Blob): Promise<BitmapLike> {
  if (typeof createImageBitmap === 'function') {
    try {
      return (await createImageBitmap(file)) as unknown as BitmapLike;
    } catch {
      /* ниже запасной способ */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Не удалось прочитать изображение'));
      el.src = url;
    });
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

async function drawToJpeg(source: BitmapLike, maxSize: number, quality: number): Promise<Uint8Array> {
  const scale = Math.min(1, maxSize / Math.max(source.width, source.height));
  const w = Math.max(1, Math.round(source.width * scale));
  const h = Math.max(1, Math.round(source.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Не удалось подготовить изображение');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source as unknown as CanvasImageSource, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('Не удалось сжать изображение');
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Картинка → data URL для хранения в справочнике.
 * Прозрачность сохраняется (PNG), фотографии сжимаются в JPEG.
 */
export async function imageToDataUrl(blob: Blob, maxSize = 256, quality = 0.85): Promise<string> {
  const keepAlpha = /png|svg|webp|gif/i.test(blob.type);
  const source = await loadBitmap(blob);
  const scale = Math.min(1, maxSize / Math.max(source.width, source.height));
  const w = Math.max(1, Math.round(source.width * scale));
  const h = Math.max(1, Math.round(source.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Не удалось подготовить изображение');
  if (!keepAlpha) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(source as unknown as CanvasImageSource, 0, 0, w, h);
  if ('close' in source && typeof source.close === 'function') source.close();
  const out = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, keepAlpha ? 'image/png' : 'image/jpeg', quality),
  );
  if (!out) throw new Error('Не удалось сжать изображение');
  return bytesToDataUrl(new Uint8Array(await out.arrayBuffer()), out.type);
}

/** Сколько места занимают файлы (приблизительно, для диагностики) */
export async function blobKeys(): Promise<string[]> {
  if (Capacitor.isNativePlatform()) return [];
  const keys = await idb<IDBValidKey[]>('readonly', (s) => s.getAllKeys());
  return keys.map((k) => String(k)).filter((k) => k.startsWith('blob:'));
}

/**
 * Обмен с Яндекс Диском: данные — отдельно, значки — отдельно.
 *
 * В папке на Диске лежат файлы двух видов:
 *  - `avtobaza-<дата>.json` — данные: справочники, путевые листы, поездки, деньги,
 *    настройки. Картинок в нём нет, поэтому файл лёгкий и уходит быстро;
 *  - `avtobaza-icons-<дата>.zip` — архив картинок: логотипы и значки справочников
 *    и фотографии документов. Значки подбираются к записям по названию (у техники —
 *    ещё и по номеру), поэтому архив можно подтянуть на другом устройстве.
 *
 * В облаке хранятся последние несколько копий каждого файла, старые удаляются.
 * Скачанные картинки не затирают уже подобранные: заполняются только пустые поля.
 */

import { dbSync, getDb } from '../db';
import { countRows, nowIso, updateRow } from '../db/repo';
import { useApp } from '../store';
import {
  buildCloudData,
  importJson,
  isEmbeddedPicture,
  PICTURE_COLUMNS,
  replaceFromJson,
  type ImportResult,
} from './backup';
import { allDocumentRows, documentSummary } from './documents';
import { bytesToDataUrl, dataUrlToBytes, getBlob, putBlob } from './files';
import { normalizeName } from './order';
import { TABLES } from '../types';
import { CloudError, humanSize, normalizePath, YandexDisk, type RemoteEntry } from './webdav';

/** Таблицы, у которых есть поле с картинкой */
export type PictureTable = 'companies' | 'cargo_types' | 'fuel_stations' | 'vehicles';

export const DATA_PREFIX = 'avtobaza-';
export const DATA_SUFFIX = '.json';
export const ICONS_PREFIX = 'avtobaza-icons-';
export const ICONS_SUFFIX = '.zip';
/** Имя списка внутри архива значков */
const MANIFEST = 'icons.json';

/* ------------------------------------------------------------------ */
/* Настройки                                                           */
/* ------------------------------------------------------------------ */

function settings() {
  return useApp.getState().settings;
}

/** Логин и пароль приложения заполнены */
export function cloudConfigured(): boolean {
  const s = settings();
  return String(s.yadisk_login ?? '').trim() !== '' && String(s.yadisk_password ?? '').trim() !== '';
}

/** Папка синхронизации на Диске */
export function folderPath(): string {
  return normalizePath(String(settings().yadisk_folder ?? '') || '/avtobaza');
}

/** Место выгрузки: логин и папка. Отпечатки архива привязаны к нему. */
export function cloudPlace(): string {
  return `${String(settings().yadisk_login ?? '').trim()}@${folderPath()}`;
}

/** Сколько копий держать в облаке */
export function keepCopies(): number {
  const n = Number(settings().yadisk_keep);
  return Number.isFinite(n) && n >= 1 ? Math.min(20, Math.round(n)) : 5;
}

export interface CloudState {
  configured: boolean;
  auto: boolean;
  folder: string;
  login: string;
  /** Время последнего удачного обмена, ISO */
  lastAt: string;
  /** Имя последнего выгруженного файла данных */
  lastData: string;
  /** Имя последнего архива значков */
  lastIcons: string;
  /** Есть невыгруженные изменения */
  dirty: boolean;
  /** Текст последней ошибки обмена */
  lastError: string;
}

export function cloudState(): CloudState {
  const s = settings();
  return {
    configured: cloudConfigured(),
    auto: Number(s.yadisk_auto) === 1,
    folder: folderPath(),
    login: String(s.yadisk_login ?? ''),
    lastAt: String(s.yadisk_last_at ?? ''),
    lastData: String(s.yadisk_last_data ?? ''),
    lastIcons: String(s.yadisk_last_icons ?? ''),
    dirty: Number(s.yadisk_dirty) === 1,
    lastError: String(s.yadisk_last_error ?? ''),
  };
}

/** Отметить, что появились изменения, которых нет в облаке */
export function markDirty(): void {
  if (Number(settings().yadisk_dirty) === 1) return;
  useApp.getState().saveSetting('yadisk_dirty', 1);
}

function markClean(): void {
  useApp.getState().saveSetting('yadisk_dirty', 0);
}

/** Запомнить текст последней ошибки обмена (виден на экране Диска) */
export function noteError(text: string): void {
  useApp.getState().saveSetting('yadisk_last_error', text);
}

function client(): YandexDisk {
  const s = settings();
  return new YandexDisk(String(s.yadisk_login ?? ''), String(s.yadisk_password ?? ''));
}

/* ------------------------------------------------------------------ */
/* Имена файлов                                                        */
/* ------------------------------------------------------------------ */

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/** Отметка времени в имени файла: 2026-11-17_1830 */
function stamp(at: Date): string {
  return (
    `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}` +
    `_${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`
  );
}

export function dataFileName(at = new Date()): string {
  return `${DATA_PREFIX}${stamp(at)}${DATA_SUFFIX}`;
}

export function iconsFileName(at = new Date()): string {
  return `${ICONS_PREFIX}${stamp(at)}${ICONS_SUFFIX}`;
}

/* ------------------------------------------------------------------ */
/* Архив значков                                                       */
/* ------------------------------------------------------------------ */

/** Картинка справочника внутри архива */
export interface PictureRecord {
  table: PictureTable;
  /** Название записи — по нему картинка находится на другом устройстве */
  name: string;
  /** Номер машины: уточняет запись, если названия совпали */
  plate: string;
  mime: string;
  /** Имя файла внутри архива */
  file: string;
  size: number;
}

/** Файл документа внутри архива */
export interface DocumentRecord {
  /** Номер записи в таблице документов */
  id: string;
  title: string;
  mime: string;
  /** Путь в хранилище устройства */
  path: string;
  file: string;
  size: number;
}

export interface IconsManifest {
  app: string;
  kind: 'icons';
  version: number;
  exported_at: string;
  pictures: PictureRecord[];
  documents: DocumentRecord[];
}

/** Что удалось восстановить из архива */
export interface RestoreResult {
  pictures: number;
  documents: number;
  /** Сколько записей в архиве не нашло пары на устройстве */
  missing: number;
}

function fieldOf(table: PictureTable): string {
  return PICTURE_COLUMNS.find((p) => p.table === table)?.column ?? 'logo';
}

/** Отпечаток содержимого архива: по нему видно, менялся ли он с прошлой выгрузки */
function contentFingerprint(items: { meta: string; bytes: Uint8Array }[]): string {
  let hash = 0x811c9dc5;
  const mix = (byte: number) => {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  for (const item of items) {
    for (let i = 0; i < item.meta.length; i++) mix(item.meta.charCodeAt(i) & 0xff);
    for (let i = 0; i < item.bytes.length; i++) mix(item.bytes[i]);
  }
  return `${items.length}:${hash.toString(16)}`;
}

/** Что получилось собрать: сам архив и отпечаток его содержимого */
export interface IconsArchive {
  bytes: Uint8Array;
  /** Отпечаток содержимого (не архива: у ZIP меняется дата внутри) */
  fingerprint: string;
}

/** Собирает архив картинок. Если картинок нет — архива нет. */
export async function buildIconsArchive(): Promise<IconsArchive | null> {
  const JSZip = (await import('jszip')).default;
  const db = dbSync();
  const zip = new JSZip();
  const pictures: PictureRecord[] = [];
  const documents: DocumentRecord[] = [];
  const content: { meta: string; bytes: Uint8Array }[] = [];

  for (const { table, column } of PICTURE_COLUMNS) {
    // Номер есть только у техники: по нему уточняем запись, если названия совпали
    const plate = table === 'vehicles' ? 'plate' : "''";
    const rows = db.all<Record<string, unknown>>(
      `SELECT id, name, ${plate} AS plate, ${column} AS picture FROM ${table} WHERE deleted = 0`,
    );
    for (const row of rows) {
      const value = String(row.picture ?? '');
      if (!isEmbeddedPicture(value)) continue;
      const image = dataUrlToBytes(value);
      if (!image || image.bytes.length === 0) continue;
      const file = `pic/${pictures.length}.img`;
      zip.file(file, image.bytes);
      pictures.push({
        table: table as PictureTable,
        name: String(row.name ?? ''),
        plate: String(row.plate ?? ''),
        mime: image.mime || 'image/jpeg',
        file,
        size: image.bytes.length,
      });
      content.push({
        meta: `${table}|${row.name ?? ''}|${row.plate ?? ''}|${image.mime}|${image.bytes.length}`,
        bytes: image.bytes,
      });
    }
  }

  for (const doc of allDocumentRows()) {
    const bytes = await getBlob(doc.path);
    if (!bytes || bytes.length === 0) continue;
    const file = `doc/${documents.length}.bin`;
    zip.file(file, bytes);
    documents.push({
      id: doc.id,
      title: doc.title,
      mime: doc.mime || 'image/jpeg',
      path: doc.path,
      file,
      size: bytes.length,
    });
    content.push({ meta: `doc|${doc.id}|${doc.mime}|${bytes.length}`, bytes });
  }

  if (pictures.length === 0 && documents.length === 0) return null;

  const manifest: IconsManifest = {
    app: 'avtobaza',
    kind: 'icons',
    version: 1,
    exported_at: nowIso(),
    pictures,
    documents,
  };
  zip.file(MANIFEST, JSON.stringify(manifest));
  return {
    // Картинки уже сжаты (JPEG и PNG), поэтому упаковка без сжатия: архив
    // собирается заметно быстрее, а размер почти не меняется.
    bytes: await zip.generateAsync({ type: 'uint8array', compression: 'STORE' }),
    fingerprint: contentFingerprint(content),
  };
}

/**
 * Отпечаток значков и документов по одной базе — без чтения файлов с устройства.
 *
 * Сборка архива читает с устройства все фотографии и занимает заметное время,
 * поэтому сначала сверяем дешёвый отпечаток: если значков не касались, архив
 * не собираем вовсе. Картинки справочников лежат прямо в базе (она и так в
 * памяти) — их берём как есть; файлы документов не читаем, их опознаём по
 * числу, размеру и времени. В отпечаток входит и место выгрузки: в новой папке
 * или под другим логином архив должен уйти заново.
 */
export function iconsMeta(): string {
  const db = dbSync();
  let hash = 0x811c9dc5;
  const mix = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i) & 0xff;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  };

  for (const { table, column } of PICTURE_COLUMNS) {
    const rows = db.all<{ name: string; picture: string }>(
      `SELECT name, ${column} AS picture FROM ${table}
       WHERE deleted = 0 AND ${column} LIKE 'data:%'`,
    );
    mix(`${table}:${rows.length}`);
    for (const row of rows) mix(`${row.name}|${row.picture}`);
  }

  const docs = documentSummary();
  return `${cloudPlace()}|${hash.toString(16)}|doc:${docs.count}:${docs.bytes}:${docs.lastAt}`;
}

/** Читает архив значков: опись и содержимое файлов */
export async function readIconsArchive(
  bytes: Uint8Array,
): Promise<{ manifest: IconsManifest; files: Map<string, Uint8Array> }> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(bytes);
  const manifestFile = zip.file(MANIFEST);
  if (!manifestFile) throw new CloudError('Архив значков без описи — файл повреждён');
  const manifest = JSON.parse(await manifestFile.async('string')) as IconsManifest;
  if (!manifest || !Array.isArray(manifest.pictures)) {
    throw new CloudError('Архив значков не похож на архив АвтоБазы');
  }
  const files = new Map<string, Uint8Array>();
  for (const item of [...manifest.pictures, ...(manifest.documents ?? [])]) {
    const entry = zip.file(item.file);
    if (!entry) continue;
    files.set(item.file, await entry.async('uint8array'));
  }
  return { manifest, files };
}

/** Ищет запись справочника, к которой относится картинка */
function findPictureRow(item: PictureRecord): Record<string, unknown> | null {
  const db = dbSync();
  const rows = db.all<Record<string, unknown>>(
    `SELECT * FROM ${item.table} WHERE deleted = 0`,
  );
  const key = normalizeName(item.name);
  if (!key) return null;
  const same = rows.filter((row) => normalizeName(String(row.name ?? '')) === key);
  if (same.length === 0) return null;
  if (same.length === 1) return same[0];
  // Названия совпали — уточняем по номеру машины
  const plate = item.plate.trim();
  if (plate) {
    const byPlate = same.find((row) => String(row.plate ?? '').trim() === plate);
    if (byPlate) return byPlate;
  }
  return same[0];
}

/**
 * Раскладывает картинки из архива по записям.
 * Пустые поля заполняются, уже подобранные картинки не затираются
 * (кроме случая `onlyMissing = false` — тогда архив главнее).
 */
export async function restoreIcons(
  bytes: Uint8Array,
  onlyMissing = true,
): Promise<RestoreResult> {
  const { manifest, files } = await readIconsArchive(bytes);
  const db = dbSync();
  let pictures = 0;
  let documents = 0;
  let missing = 0;

  for (const item of manifest.pictures ?? []) {
    const data = files.get(item.file);
    if (!data || data.length === 0) continue;
    const row = findPictureRow(item);
    if (!row) {
      missing++;
      continue;
    }
    const field = fieldOf(item.table);
    if (onlyMissing && String(row[field] ?? '') !== '') continue;
    updateRow(item.table, String(row.id), {
      [field]: bytesToDataUrl(data, item.mime || 'image/jpeg'),
    });
    pictures++;
  }

  for (const item of manifest.documents ?? []) {
    const data = files.get(item.file);
    if (!data || data.length === 0) continue;
    const row = db.one<{ id: string; path: string }>(
      'SELECT id, path FROM attachments WHERE id = ? AND deleted = 0',
      [item.id],
    );
    if (!row) {
      missing++;
      continue;
    }
    const path = String(row.path ?? '') || item.path;
    if (!path) {
      missing++;
      continue;
    }
    if (onlyMissing && (await getBlob(path))) continue;
    await putBlob(path, data);
    documents++;
  }

  return { pictures, documents, missing };
}

/* ------------------------------------------------------------------ */
/* Список файлов в папке                                               */
/* ------------------------------------------------------------------ */

function newestFirst(entries: RemoteEntry[]): RemoteEntry[] {
  return [...entries].sort((a, b) => b.name.localeCompare(a.name));
}

/** Файлы данных в облаке, свежие сверху */
export async function listDataFiles(target = folderPath()): Promise<RemoteEntry[]> {
  const entries = await client().list(target);
  return newestFirst(
    entries.filter(
      (e) => !e.isDirectory && e.name.startsWith(DATA_PREFIX) && e.name.endsWith(DATA_SUFFIX),
    ),
  );
}

/** Архивы значков в облаке, свежие сверху */
export async function listIconsFiles(target = folderPath()): Promise<RemoteEntry[]> {
  const entries = await client().list(target);
  return newestFirst(
    entries.filter(
      (e) => !e.isDirectory && e.name.startsWith(ICONS_PREFIX) && e.name.endsWith(ICONS_SUFFIX),
    ),
  );
}

/** Что лежит в папке: и данные, и значки — за одно чтение папки */
async function listCloud(
  target: string,
): Promise<{ data: RemoteEntry[]; icons: RemoteEntry[] }> {
  const entries = await client().list(target);
  const files = entries.filter((e) => !e.isDirectory);
  return {
    data: newestFirst(
      files.filter((e) => e.name.startsWith(DATA_PREFIX) && e.name.endsWith(DATA_SUFFIX)),
    ),
    icons: newestFirst(
      files.filter((e) => e.name.startsWith(ICONS_PREFIX) && e.name.endsWith(ICONS_SUFFIX)),
    ),
  };
}

/** Удаляет копии сверх положенного числа; ошибки чистки выгрузку не ломают */
async function trimOld(disk: YandexDisk, list: RemoteEntry[], keep: number): Promise<void> {
  for (const entry of list.slice(keep)) {
    try {
      await disk.remove(entry.path);
    } catch {
      /* старая копия останется — не беда */
    }
  }
}

/** Выгружает файл и убеждается, что он долетел целиком */
async function uploadChecked(
  disk: YandexDisk,
  path: string,
  size: number,
  write: () => Promise<void>,
): Promise<void> {
  try {
    await write();
  } catch (error) {
    // Бывает так: файл записался, а ответ не дошёл. Тогда это не ошибка.
    const remote = await disk.size(path).catch(() => null);
    if (remote !== null && remote === size) return;
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Выгрузка                                                            */
/* ------------------------------------------------------------------ */

export interface CloudPushResult {
  dataName: string;
  /** Имя архива значков или null, если выгружать было нечего */
  iconsName: string | null;
  /** Архив не ушёл, хотя картинки есть (данные при этом уже сохранены) */
  iconsFailed: boolean;
}

/** Что сейчас происходит при выгрузке — чтобы показать это на экране */
export interface PushStage {
  step: 'data' | 'icons' | 'trim';
  text: string;
}

export type PushReporter = (stage: PushStage) => void;

export async function pushToDisk(report?: PushReporter): Promise<CloudPushResult> {
  const disk = client();
  const target = folderPath();
  report?.({ step: 'data', text: 'Готовлю папку на Диске' });
  await disk.createChain(target);

  // Пустая база не должна затирать копию с данными: иначе после сбоя
  // на устройстве в облаке останется пустой файл, и вернуть данные будет нечем
  const local = localRowCount();
  if (local === 0) {
    const files = await listDataFiles(target);
    if (files[0]) {
      const cloud = await disk
        .getText(files[0].path)
        .then((text) => rowsInData(text))
        .catch(() => 0);
      if (cloud > 0) {
        throw new CloudError(
          `На устройстве нет ни одной записи, а в облаке их ${cloud}. Выгрузка отменена, ` +
            'чтобы не затереть копию: сначала загрузите данные из облака или верните базу из копии.',
        );
      }
    }
  }

  const at = new Date();
  const dataName = dataFileName(at);
  const data = buildCloudData();
  const dataPath = `${target}/${dataName}`;
  report?.({ step: 'data', text: `Отправляю данные (${humanSize(utf8Length(data))})` });
  await uploadChecked(disk, dataPath, utf8Length(data), () =>
    disk.putText(dataPath, data, 'application/json'),
  );

  let iconsName: string | null = null;
  let iconsFailed = false;
  try {
    iconsName = await uploadIcons(disk, target, at, false, report);
  } catch {
    iconsFailed = true;
  }

  const keep = keepCopies();
  report?.({ step: 'trim', text: 'Убираю старые копии' });
  const cloud = await listCloud(target);
  await trimOld(disk, cloud.data, keep);
  await trimOld(disk, cloud.icons, keep);

  const store = useApp.getState();
  store.saveSetting('yadisk_last_at', nowIso());
  store.saveSetting('yadisk_last_data', dataName);
  if (iconsName) store.saveSetting('yadisk_last_icons', iconsName);
  markClean();
  noteError('');
  return { dataName, iconsName, iconsFailed };
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Сколько записей сейчас в базе на устройстве (настройки не считаем) */
export function localRowCount(): number {
  let total = 0;
  for (const table of TABLES) total += countRows(table);
  return total;
}

/** Сколько записей в файле данных из облака */
export function rowsInData(text: string): number {
  const payload = JSON.parse(text) as { tables?: Record<string, unknown[]> };
  let total = 0;
  for (const rows of Object.values(payload.tables ?? {})) {
    if (Array.isArray(rows)) total += rows.length;
  }
  return total;
}

async function uploadIcons(
  disk: YandexDisk,
  target: string,
  at: Date,
  force = false,
  report?: PushReporter,
): Promise<string | null> {
  const store = useApp.getState();
  const meta = iconsMeta();
  // Значков и документов не касались — архив даже не собираем: сборка
  // читает с устройства все фотографии и на телефоне идёт долго.
  if (!force && meta === String(store.settings.yadisk_icons_meta ?? '')) return null;

  report?.({ step: 'icons', text: 'Собираю архив значков и фотографий' });
  const archive = await buildIconsArchive();
  if (!archive) {
    store.saveSetting('yadisk_icons_meta', meta);
    return null;
  }
  // Значки меняются редко, а архив бывает тяжёлым: если содержимое то же,
  // что в прошлой выгрузке, второй раз его не гоняем.
  const content = `${cloudPlace()}|${archive.fingerprint}`;
  if (!force && String(store.settings.yadisk_icons_hash ?? '') === content) {
    store.saveSetting('yadisk_icons_meta', meta);
    return null;
  }
  const name = iconsFileName(at);
  const path = `${target}/${name}`;
  report?.({
    step: 'icons',
    text: `Отправляю значки и фотографии (${humanSize(archive.bytes.length)})`,
  });
  await uploadChecked(disk, path, archive.bytes.length, () =>
    disk.putBytes(path, archive.bytes, 'application/zip'),
  );
  store.saveSetting('yadisk_icons_hash', content);
  store.saveSetting('yadisk_icons_meta', meta);
  return name;
}

/** Выгрузить только значки (данные не трогаем) */
export async function pushIconsOnly(report?: PushReporter): Promise<string | null> {
  const disk = client();
  const target = folderPath();
  await disk.createChain(target);
  const name = await uploadIcons(disk, target, new Date(), true, report);
  await trimOld(disk, await listIconsFiles(target), keepCopies());
  if (name) {
    useApp.getState().saveSetting('yadisk_last_icons', name);
    useApp.getState().saveSetting('yadisk_last_at', nowIso());
    noteError('');
  }
  return name;
}

/* ------------------------------------------------------------------ */
/* Загрузка                                                            */
/* ------------------------------------------------------------------ */

export interface CloudPullResult {
  dataName: string;
  inserted: number;
  updated: number;
  skipped: number;
  icons: RestoreResult;
}

export async function pullFromDisk(replace = false): Promise<CloudPullResult> {
  const disk = client();
  const target = folderPath();
  const files = await listDataFiles(target);
  const newest = files[0];
  if (!newest) {
    throw new CloudError(`В папке «${target}» на Яндекс Диске нет файлов данных АвтоБазы`);
  }

  const text = await disk.getText(newest.path);
  let result: ImportResult;
  try {
    if (replace) {
      // Замена необратима: сначала оставляем копию того, что есть на устройстве
      await getDb().then((db) => db.snapshot()).catch(() => undefined);
    }
    result = replace ? replaceFromJson(text) : importJson(text, true);
  } catch (error) {
    throw new CloudError(
      error instanceof Error ? error.message : 'Не удалось прочитать данные из облака',
    );
  }

  const icons = await restoreIconsFromDisk(disk, target, true).catch(() => ({
    pictures: 0,
    documents: 0,
    missing: 0,
  }));

  const store = useApp.getState();
  store.saveSetting('yadisk_last_at', nowIso());
  store.saveSetting('yadisk_last_data', newest.name);
  markClean();
  noteError('');
  store.touch();

  return {
    dataName: newest.name,
    inserted: result.inserted,
    updated: result.updated,
    skipped: result.skipped,
    icons,
  };
}

/** Подтянуть значки из самого свежего архива */
export async function restoreIconsFromDisk(
  disk = client(),
  target = folderPath(),
  onlyMissing = true,
): Promise<RestoreResult> {
  const files = await listIconsFiles(target);
  const newest = files[0];
  if (!newest) throw new CloudError(`В папке «${target}» нет архива значков`);
  const bytes = await disk.getBytes(newest.path);
  const result = await restoreIcons(bytes, onlyMissing);
  const store = useApp.getState();
  store.saveSetting('yadisk_last_icons', newest.name);
  noteError('');
  store.touch();
  return result;
}

/* ------------------------------------------------------------------ */
/* Проверка и сводка                                                   */
/* ------------------------------------------------------------------ */

/** Проверить подключение и завести папку */
export async function checkDisk(login: string, password: string, folder: string): Promise<string> {
  const disk = new YandexDisk(login, password);
  return await disk.check(normalizePath(folder || '/avtobaza'));
}

/** Сколько картинок и документов уйдёт в архив */
export function localPictureStats(): { pictures: number; documents: number } {
  const db = dbSync();
  let pictures = 0;
  for (const { table, column } of PICTURE_COLUMNS) {
    const rows = db.all<Record<string, unknown>>(
      `SELECT ${column} AS picture FROM ${table} WHERE deleted = 0`,
    );
    for (const row of rows) if (isEmbeddedPicture(row.picture)) pictures++;
  }
  return { pictures, documents: allDocumentRows().length };
}

/** Есть ли записи, у которых картинки ещё нет */
export function hasMissingPictures(): boolean {
  const db = dbSync();
  for (const { table, column } of PICTURE_COLUMNS) {
    const empty = db.one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table}
       WHERE deleted = 0 AND (${column} IS NULL OR ${column} = '')`,
    );
    if (Number(empty?.n ?? 0) > 0) return true;
  }
  return false;
}

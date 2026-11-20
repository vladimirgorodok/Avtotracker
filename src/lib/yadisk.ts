/**
 * Обмен с Яндекс Диском: данные — отдельным лёгким файлом, картинки — поштучно.
 *
 * В папке на Диске лежат:
 *  - `avtobaza-<дата>.json` — данные: справочники, путевые листы, поездки, деньги,
 *    настройки. Картинок в нём нет, поэтому файл лёгкий и уходит быстро;
 *  - `avtobaza-files.json` — опись картинок и фотографий: что лежит в папке `files`
 *    и к каким записям относится (значки подбираются по названию, у техники — ещё
 *    и по номеру), поэтому значки можно подтянуть на другом устройстве;
 *  - `files/` — сами файлы: логотипы и значки справочников и фотографии документов.
 *
 * Каждый файл уходит в облако один раз: перед выгрузкой смотрим, что уже лежит
 * в папке `files`, и отправляем только новое. Раньше всё складывалось в один архив,
 * и при добавлении одной фотографии в облако уходил архив целиком — из-за этого
 * выгрузка занимала минуты.
 *
 * Прежние архивы `avtobaza-icons-<дата>.zip` ещё читаются: устройство со старой
 * версией приложения продолжит подтягивать из них значки. Новые архивы не пишем.
 *
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
import { blobKeys, bytesToDataUrl, dataUrlToBytes, getBlob, putBlob } from './files';
import { normalizeName } from './names';
import { TABLES } from '../types';
import { CloudError, humanSize, normalizePath, YandexDisk, type RemoteEntry } from './webdav';

/** Таблицы, у которых есть поле с картинкой */
export type PictureTable = 'companies' | 'cargo_types' | 'fuel_stations' | 'vehicles';

export const DATA_PREFIX = 'avtobaza-';
export const DATA_SUFFIX = '.json';
export const ICONS_PREFIX = 'avtobaza-icons-';
export const ICONS_SUFFIX = '.zip';
/** Имя списка внутри архива значков (прежний вид облака) */
const MANIFEST = 'icons.json';
/** Папка с картинками и фотографиями внутри папки обмена */
export const FILES_FOLDER = 'files';
/** Опись файлов: что лежит в папке files и к каким записям относится */
export const LIST_NAME = 'avtobaza-files.json';
/** Файл данных: `avtobaza-2026-11-20_183005.json` */
const DATA_RE = /^avtobaza-\d{4}-\d{2}-\d{2}_\d{6}\.json$/;
/** Архив значков прежнего вида: `avtobaza-icons-2026-11-20_183005.zip` */
const ICONS_RE = /^avtobaza-icons-\d{4}-\d{2}-\d{2}_\d{6}\.zip$/;

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

/** Место выгрузки: логин и папка. Отпечаток значков привязан к нему. */
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
  /** Сколько картинок и фотографий лежит в облаке */
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

/* ------------------------------------------------------------------ */
/* Опись значков и фотографий                                          */
/* ------------------------------------------------------------------ */

/** Картинка справочника в описи */
export interface PictureRecord {
  table: PictureTable;
  /** Название записи — по нему картинка находится на другом устройстве */
  name: string;
  /** Номер машины: уточняет запись, если названия совпали */
  plate: string;
  mime: string;
  /** Имя файла в папке files */
  file: string;
  size: number;
}

/** Файл документа в описи */
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

/** Что удалось восстановить из архива или из описи */
export interface RestoreResult {
  pictures: number;
  documents: number;
  /** Сколько записей в описи не нашло пары на устройстве */
  missing: number;
  /** Сколько файлов не удалось скачать (связь пропала — попробуем в следующий раз) */
  failed: number;
}

function fieldOf(table: PictureTable): string {
  return PICTURE_COLUMNS.find((p) => p.table === table)?.column ?? 'logo';
}

/**
 * Отпечаток содержимого: по нему картинка получает имя в облаке.
 * Одинаковые картинки называются одинаково и второй раз не выгружаются.
 */
function shortHash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (code + i), 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

function safeName(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[_.]+|[_.]+$/g, '').slice(0, 60);
}

/** Расширение файла — по нему видно, чем открывать картинку */
function extensionOf(mime: string, path = ''): string {
  if (/png/i.test(mime)) return 'png';
  if (/jpe?g/i.test(mime)) return 'jpg';
  const dot = path.lastIndexOf('.');
  const ext = dot >= 0 ? safeName(path.slice(dot + 1)).toLowerCase() : '';
  return ext || 'bin';
}

/** Файл картинки или фотографии для выгрузки в облако */
export interface IconsFile {
  /** Имя файла в папке files */
  file: string;
  /** Откуда брать содержимое: картинка справочника лежит в базе, документ — в хранилище устройства */
  kind: 'picture' | 'document';
  /** Ссылка на картинку (data URL) или путь файла документа */
  source: string;
  size: number;
  mime: string;
}

/** Опись для облака и файлы, которые к ней относятся */
export interface IconsList {
  manifest: IconsManifest;
  items: IconsFile[];
}

/**
 * Опись картинок и фотографий по одной базе — без чтения файлов с устройства.
 *
 * Картинки справочников лежат прямо в базе и называются по содержимому: если такую
 * картинку уже выгружали, второй раз она не уйдёт. Фотографии документов называются
 * по номеру записи, а размер берём из базы — файл читается только при самой выгрузке.
 */
export function buildIconsList(): IconsList | null {
  const db = dbSync();
  const pictures: PictureRecord[] = [];
  const documents: DocumentRecord[] = [];
  const items: IconsFile[] = [];

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
      const mime = image.mime || 'image/jpeg';
      const file = `pic-${shortHash(value)}.${extensionOf(mime)}`;
      pictures.push({
        table: table as PictureTable,
        name: String(row.name ?? ''),
        plate: String(row.plate ?? ''),
        mime,
        file,
        size: image.bytes.length,
      });
      items.push({ file, kind: 'picture', source: value, size: image.bytes.length, mime });
    }
  }

  for (const doc of allDocumentRows()) {
    if (!doc.path) continue;
    const mime = doc.mime || 'image/jpeg';
    const file = `doc-${safeName(doc.id) || shortHash(doc.path)}.${extensionOf(mime, doc.path)}`;
    documents.push({
      id: doc.id,
      title: doc.title,
      mime,
      path: doc.path,
      file,
      size: Number(doc.size) || 0,
    });
    items.push({ file, kind: 'document', source: doc.path, size: Number(doc.size) || 0, mime });
  }

  if (pictures.length === 0 && documents.length === 0) return null;

  return {
    manifest: {
      app: 'avtobaza',
      kind: 'icons',
      version: 1,
      exported_at: nowIso(),
      pictures,
      documents,
    },
    items,
  };
}

/**
 * Отпечаток значков и документов по одной базе — без чтения файлов с устройства.
 *
 * Сверка с облаком идёт по описи, но она собирается по этой же базе, поэтому
 * дешёвый отпечаток нужен, чтобы лишний раз не ходить в облако: если значков
 * не касались, обмен значками пропускаем целиком. Картинки справочников лежат
 * прямо в базе (она и так в памяти) — их берём как есть; файлы документов не
 * читаем, их опознаём по числу, размеру и времени. В отпечаток входит и место
 * выгрузки: в новой папке или под другим логином файлы должны уйти заново.
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
  // `files` в начале — примета нового вида обмена: устройство, которое раньше
  // выгружало архив, при первой же выгрузке разложит файлы поштучно
  return `files|${cloudPlace()}|${hash.toString(16)}|doc:${docs.count}:${docs.bytes}:${docs.lastAt}`;
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

  return { pictures, documents, missing, failed: 0 };
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
  return newestFirst(entries.filter((e) => !e.isDirectory && DATA_RE.test(e.name)));
}

/** Архивы значков прежнего вида в облаке, свежие сверху */
export async function listIconsFiles(target = folderPath()): Promise<RemoteEntry[]> {
  const entries = await client().list(target);
  return newestFirst(entries.filter((e) => !e.isDirectory && ICONS_RE.test(e.name)));
}

/** Что лежит в папке: и данные, и прежние архивы значков — за одно чтение папки */
async function listCloud(
  target: string,
): Promise<{ data: RemoteEntry[]; icons: RemoteEntry[] }> {
  const entries = await client().list(target);
  const files = entries.filter((e) => !e.isDirectory);
  return {
    data: newestFirst(files.filter((e) => DATA_RE.test(e.name))),
    icons: newestFirst(files.filter((e) => ICONS_RE.test(e.name))),
  };
}

/** Файлы картинок и фотографий, которые уже лежат в облаке */
async function listCloudFiles(disk: YandexDisk, target: string): Promise<Set<string>> {
  try {
    const entries = await disk.list(`${target}/${FILES_FOLDER}`);
    return new Set(entries.filter((e) => !e.isDirectory).map((e) => e.name));
  } catch (error) {
    // Папки ещё нет — значит, в облаке ни одного файла нет
    if (error instanceof CloudError && (error.code === 404 || error.code === 409)) return new Set();
    throw error;
  }
}

/** Наши файлы в папке files: значки справочников и фотографии документов */
const OUR_FILE_RE = /^(pic|doc)-[A-Za-z0-9_.-]+\.(jpe?g|png|gif|webp|bmp|heic)$/i;

/** Пустая опись: остаётся после того, как значки и фотографии убрали */
function emptyManifest(): IconsManifest {
  return {
    app: 'avtobaza',
    kind: 'icons',
    version: 1,
    exported_at: nowIso(),
    pictures: [],
    documents: [],
  };
}

/**
 * Можно ли чистить папку с файлами: наша база не должна отставать от облака.
 *
 * Если в облаке лежит копия новее нашей, в папке могут быть картинки другого
 * устройства, о которых мы ещё не знаем, — тогда чистку откладываем. `freshData`
 * означает, что свой файл данных мы только что записали, и опись самая свежая.
 */
async function mayCleanCloud(
  disk: YandexDisk,
  target: string,
  freshData: boolean,
): Promise<boolean> {
  if (freshData) return true;
  const state = cloudState();
  if (!state.lastData) return false;
  const entries = await disk.list(target);
  const newest = newestFirst(entries.filter((e) => !e.isDirectory && DATA_RE.test(e.name)))[0];
  return !newest || newest.name === state.lastData;
}

/**
 * Убирает из облака наши файлы, которых больше нет в описи.
 *
 * Иначе удалённые значки и фотографии оставались бы в папке навсегда: выгрузка
 * только добавляет файлы. Чужие файлы не трогаем — чистим лишь те, что названы
 * нашим способом (`pic-…` и `doc-…`).
 */
async function cleanLeftovers(
  disk: YandexDisk,
  target: string,
  present: Set<string>,
  keep: Set<string>,
  freshData: boolean,
  report?: PushReporter,
): Promise<number> {
  const lost = [...present].filter((name) => OUR_FILE_RE.test(name) && !keep.has(name));
  if (lost.length === 0) return 0;
  if (!(await mayCleanCloud(disk, target, freshData))) return 0;
  report?.({ step: 'icons', text: `Убираю из облака лишнее (${lost.length})` });
  let removed = 0;
  for (const name of lost) {
    try {
      await disk.remove(`${target}/${FILES_FOLDER}/${name}`);
      removed++;
    } catch {
      /* не вышло — уберём в следующий раз */
    }
  }
  return removed;
}

/** Опись картинок и фотографий из облака или null, если её там нет */
async function readIconsList(disk: YandexDisk, target: string): Promise<IconsManifest | null> {
  try {
    const text = await disk.getText(`${target}/${LIST_NAME}`);
    const parsed = JSON.parse(text) as IconsManifest;
    if (!parsed || (!Array.isArray(parsed.pictures) && !Array.isArray(parsed.documents))) return null;
    return parsed;
  } catch {
    return null;
  }
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
  /** Сколько файлов значков и фотографий догрузили в облако */
  filesUploaded: number;
  /** Сколько лишних файлов убрали из облака */
  filesRemoved: number;
  /** Файлы не ушли, хотя картинки есть (данные при этом уже сохранены) */
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

  let filesUploaded = 0;
  let filesRemoved = 0;
  let iconsFailed = false;
  try {
    // Свой файл данных уже записан — значит, опись самая свежая, и лишнее в
    // облаке можно убирать сразу
    const icons = await syncIcons(disk, target, false, report, true);
    filesUploaded = icons.uploaded;
    filesRemoved = icons.removed;
  } catch {
    iconsFailed = true;
  }

  const keep = keepCopies();
  report?.({ step: 'trim', text: 'Убираю старые копии' });
  const cloud = await listCloud(target);
  await trimOld(disk, cloud.data, keep);
  // Прежние архивы значков больше не пишем: держим один — он нужен только
  // устройству со старой версией приложения
  await trimOld(disk, cloud.icons, 1);

  const store = useApp.getState();
  store.saveSetting('yadisk_last_at', nowIso());
  store.saveSetting('yadisk_last_data', dataName);
  markClean();
  noteError('');
  return { dataName, filesUploaded, filesRemoved, iconsFailed };
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

/** Что получилось при обмене картинками и фотографиями */
export interface IconsSyncResult {
  /** Сколько файлов догрузили в облако */
  uploaded: number;
  /** Сколько всего картинок и фотографий в описи */
  total: number;
  /** Сколько лишних файлов убрали из облака */
  removed: number;
  /** Ничего не изменилось — в облако даже не смотрели */
  skipped: boolean;
}

/** Содержимое файла из описи: картинка лежит в базе, документ — в хранилище устройства */
async function iconsBytes(item: IconsFile): Promise<Uint8Array | null> {
  if (item.kind === 'picture') {
    const image = dataUrlToBytes(item.source);
    return image ? image.bytes : null;
  }
  return await getBlob(item.source);
}

/**
 * Выгружает картинки и фотографии: в облако уходит только то, чего там ещё нет,
 * а лишнее (удалённое на устройстве) из облака убирается.
 *
 * Раньше всё складывалось в один архив, и добавление одной фотографии заставляло
 * выгружать архив целиком. Теперь перед выгрузкой читаем список файлов в папке
 * `files` и отправляем только новые — на телефоне это занимает секунды.
 *
 * `freshData` — свой файл данных только что записан: значит, наша опись самая
 * свежая, и убирать за собой в облаке можно сразу.
 */
async function syncIcons(
  disk: YandexDisk,
  target: string,
  force = false,
  report?: PushReporter,
  freshData = false,
): Promise<IconsSyncResult> {
  const store = useApp.getState();
  const meta = iconsMeta();
  // Значков и документов не касались — в облако даже не смотрим и опись не собираем
  if (!force && meta === String(store.settings.yadisk_icons_meta ?? '')) {
    return { uploaded: 0, total: 0, removed: 0, skipped: true };
  }

  const list = buildIconsList();
  const keep = new Set(list ? list.items.map((item) => item.file) : []);
  const filesPath = `${target}/${FILES_FOLDER}`;
  report?.({ step: 'icons', text: 'Смотрю, что уже есть в облаке' });
  await disk.createChain(filesPath);
  const present = await listCloudFiles(disk, target);

  const missing = list ? list.items.filter((item) => !present.has(item.file)) : [];
  let uploaded = 0;
  for (const item of missing) {
    const bytes = await iconsBytes(item);
    if (!bytes || bytes.length === 0) continue;
    report?.({
      step: 'icons',
      text: `Отправляю значки и фотографии (${uploaded + 1} из ${missing.length})`,
    });
    const path = `${filesPath}/${item.file}`;
    await uploadChecked(disk, path, bytes.length, () =>
      disk.putBytes(path, bytes, item.mime),
    );
    uploaded++;
  }

  // Убираем за собой: файлов, которых больше нет в описи, в облаке остаться не должно
  const removed = await cleanLeftovers(disk, target, present, keep, freshData, report);

  // Опись обновляем после файлов: по ней другое устройство узнаёт, что подтягивать
  if (list || removed > 0) {
    report?.({ step: 'icons', text: 'Обновляю опись значков и фотографий' });
    const text = JSON.stringify(list ? list.manifest : emptyManifest());
    await uploadChecked(disk, `${target}/${LIST_NAME}`, utf8Length(text), () =>
      disk.putText(`${target}/${LIST_NAME}`, text, 'application/json'),
    );
  }

  // Отпечаток запоминаем только после удачной выгрузки: если связь пропала,
  // в следующий раз снова сверимся с облаком и догрузим то, что не дошло
  store.saveSetting('yadisk_icons_meta', meta);
  store.saveSetting('yadisk_last_icons', String(list ? list.items.length : 0));
  return { uploaded, total: list ? list.items.length : 0, removed, skipped: false };
}

/** Выгрузить только значки и фотографии (данные не трогаем) */
export async function pushIconsOnly(report?: PushReporter): Promise<IconsSyncResult> {
  const disk = client();
  const target = folderPath();
  await disk.createChain(target);
  const res = await syncIcons(disk, target, true, report, false);
  if (!res.skipped) {
    useApp.getState().saveSetting('yadisk_last_at', nowIso());
    noteError('');
  }
  return res;
}

/* ------------------------------------------------------------------ */
/* Загрузка                                                            */
/* ------------------------------------------------------------------ */

export interface CloudPullResult {
  dataName: string;
  inserted: number;
  updated: number;
  skipped: number;
  /** Сколько путевых листов слилось с уже заведёнными на устройстве */
  merged: number;
  /** Сколько записей справочников (грузы, АЗС) слилось со своими */
  mergedRefs: number;
  /** Сколько начислений слилось со своими по той же перевозке */
  mergedOps: number;
  icons: RestoreResult;
}

export async function pullFromDisk(
  replace = false,
  report?: PushReporter,
): Promise<CloudPullResult> {
  const disk = client();
  const target = folderPath();
  const files = await listDataFiles(target);
  const newest = files[0];
  if (!newest) {
    throw new CloudError(`В папке «${target}» на Яндекс Диске нет файлов данных АвтоБазы`);
  }

  report?.({ step: 'data', text: 'Читаю свежую копию из облака' });
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

  // Картинки и фотографии из облака скачиваем: на устройстве нужных файлов может не быть
  const icons = await restoreIconsFromDisk(disk, target, { report }).catch(
    () => NOTHING_RESTORED,
  );

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
    merged: result.merged,
    mergedRefs: result.mergedRefs,
    mergedOps: result.mergedOps,
    icons,
  };
}

/** Что нужно при подтягивании картинок и фотографий */
export interface RestoreOptions {
  /** Не затирать уже подобранные значки и имеющиеся файлы (по умолчанию так и есть) */
  onlyMissing?: boolean;
  report?: PushReporter;
}

const NOTHING_RESTORED: RestoreResult = { pictures: 0, documents: 0, missing: 0, failed: 0 };

/**
 * Подтягивает картинки и фотографии.
 *
 * По описи из облака видно, какие файлы к каким записям относятся: скачиваем
 * только то, чего на устройстве нет. Пустые поля заполняются, уже подобранные
 * значки не затираются. Если описи нет (облако со старой версии приложения),
 * работает прежний путь — архив `avtobaza-icons-*.zip`.
 */
export async function restoreIconsFromDisk(
  disk = client(),
  target = folderPath(),
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  const onlyMissing = options.onlyMissing ?? true;
  const list = await readIconsList(disk, target);
  if (!list) return await restoreArchiveFromDisk(disk, target, onlyMissing);

  const filesPath = `${target}/${FILES_FOLDER}`;
  const present = await listCloudFiles(disk, target);
  // Какие фотографии уже лежат на устройстве: одним запросом, без чтения файлов
  const local = await blobKeys();
  const total = (list.pictures?.length ?? 0) + (list.documents?.length ?? 0);
  let pictures = 0;
  let documents = 0;
  let missing = 0;
  let failed = 0;
  let done = 0;

  /** Скачивает файл описи; ошибку связи не роняем — просто пробуем в следующий раз */
  const fetchFile = async (name: string): Promise<Uint8Array | null> => {
    if (!present.has(name)) return null;
    done++;
    options.report?.({
      step: 'icons',
      text: `Скачиваю значки и фотографии (${done} из ${total})`,
    });
    try {
      return await disk.getBytes(`${filesPath}/${name}`);
    } catch {
      failed++;
      return null;
    }
  };

  for (const item of list.pictures ?? []) {
    const row = findPictureRow(item);
    if (!row) {
      missing++;
      continue;
    }
    const field = fieldOf(item.table);
    if (onlyMissing && String(row[field] ?? '') !== '') continue;
    const data = await fetchFile(item.file);
    if (!data || data.length === 0) continue;
    updateRow(item.table, String(row.id), {
      [field]: bytesToDataUrl(data, item.mime || 'image/jpeg'),
    });
    pictures++;
  }

  for (const item of list.documents ?? []) {
    const row = dbSync().one<{ id: string; path: string }>(
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
    // Файл уже на устройстве — качать нечего
    if (local.has(path)) continue;
    const data = await fetchFile(item.file);
    if (!data || data.length === 0) continue;
    await putBlob(path, data);
    local.add(path);
    documents++;
  }

  const store = useApp.getState();
  store.saveSetting('yadisk_last_icons', String(total));
  if (pictures > 0 || documents > 0) noteError('');
  store.touch();
  return { pictures, documents, missing, failed };
}

/** Прежний вид облака: картинки и фотографии лежат одним архивом */
async function restoreArchiveFromDisk(
  disk: YandexDisk,
  target: string,
  onlyMissing: boolean,
): Promise<RestoreResult> {
  // Архив весит десятки мегабайт: качаем его, только если есть что заполнять
  if (onlyMissing && !hasMissingPictures()) return NOTHING_RESTORED;
  const files = await listIconsFiles(target);
  const newest = files[0];
  if (!newest) {
    if (onlyMissing) return NOTHING_RESTORED;
    throw new CloudError(
      `В папке «${target}» нет ни описи, ни архива значков — выгрузите их с другого устройства`,
    );
  }
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

/** Сколько картинок и документов ждёт выгрузки */
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

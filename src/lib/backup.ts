/** Экспорт и импорт: Excel, JSON-резервная копия, файл настроек, отчёт PDF. */

import { dbSync } from '../db';
import { allSettings, insertRow, nowIso, setSetting, updateRow } from '../db/repo';
import { saveBinaryFile } from '../db/storage';
import { DEFAULT_SETTINGS, TABLES, type AppSettings, type TableName } from '../types';
import { fmtDate, fmtMoney, fmtNumber, monthLabel } from './format';
import { sameWaybill, summarizeFinance, summarizeTrip, summarizeWaybill } from './calc';
import { normalizeName, SAME_BY_NAME } from './names';
import { financeRepo, refs, refuelRepo, tripRepo, waybillRepo } from '../db/repo';
import { loadTypeLabel } from '../types';

export const TABLE_TITLES: Record<TableName, string> = {
  vehicles: 'Автомобили',
  vehicle_periods: 'Периоды автомобилей',
  vehicle_links: 'Связки тягач-прицеп',
  companies: 'Фирмы',
  cargo_types: 'Грузы',
  fuel_stations: 'АЗС',
  places: 'Места',
  waybills: 'Путевые листы',
  trips: 'Перевозки',
  trip_points: 'Точки маршрута',
  refuelings: 'Заправки',
  finance_ops: 'Финансы',
  attachments: 'Документы',
};

function dumpTable(table: TableName): Record<string, unknown>[] {
  return dbSync().all<Record<string, unknown>>(`SELECT * FROM ${table}`);
}

export function dumpAll(): Record<string, Record<string, unknown>[]> {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const t of TABLES) out[t] = dumpTable(t);
  return out;
}

function stamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Настройки отдельным файлом                                          */
/* ------------------------------------------------------------------ */

/** Ключи настроек, которые можно переносить файлом (включая ключ ИИ и вход в Яндекс Диск) */
function settingKeys(): string[] {
  return Object.keys(DEFAULT_SETTINGS).filter((key) => !LOCAL_SETTINGS.has(key));
}

/**
 * Файл настроек: ставки, тема, адрес и ключ ИИ, адрес и ключ облака, вход в облако.
 * Нужен, чтобы после переустановки или на новом телефоне не настраивать всё заново.
 */
export function buildSettingsFile(): string {
  const allowed = new Set(settingKeys());
  const settings = allSettings()
    .filter((s) => allowed.has(s.key))
    .map((s) => ({ key: s.key, value: String(s.value ?? '') }));
  return JSON.stringify(
    {
      app: 'avtobaza',
      version: 1,
      kind: 'settings',
      exported_at: nowIso(),
      settings,
    },
    null,
    1,
  );
}

/** Прочитать файл настроек и применить его. Возвращает, сколько значений применили. */
export function applySettingsFile(text: string): number {
  const payload = JSON.parse(text) as { kind?: string; settings?: { key?: unknown; value?: unknown }[] };
  if (!Array.isArray(payload.settings)) {
    throw new Error('Файл не похож на настройки АвтоБазы');
  }
  const allowed = new Set(settingKeys());
  let applied = 0;
  for (const item of payload.settings) {
    const key = String(item?.key ?? '');
    if (!allowed.has(key)) continue;
    setSetting(key as keyof AppSettings, item?.value === null || item?.value === undefined ? '' : String(item.value));
    applied++;
  }
  if (applied === 0) throw new Error('В файле нет настроек АвтоБазы');
  return applied;
}

/** Сохранить настройки в файл (на телефоне — через «Поделиться», в браузере — скачиванием) */
export async function exportSettingsFile(): Promise<void> {
  await saveBinaryFile(
    `avtobaza-nastroyki-${stamp()}.json`,
    buildSettingsFile(),
    'application/json',
  );
}

/** Один файл Excel: лист на каждую таблицу */
export async function exportXlsx(): Promise<void> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const data = dumpAll();
  for (const t of TABLES) {
    const rows = data[t].map((r) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) out[k] = v;
      return out;
    });
    const ws = XLSX.utils.json_to_sheet(rows.length > 0 ? rows : [{ '': 'нет данных' }]);
    XLSX.utils.book_append_sheet(wb, ws, TABLE_TITLES[t].slice(0, 31));
  }
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  await saveBinaryFile(
    `avtobaza-${stamp()}.xlsx`,
    new Uint8Array(out),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
}

/** Полная резервная копия в JSON */
export async function exportJson(): Promise<void> {
  const payload = {
    app: 'avtobaza',
    version: 1,
    exported_at: nowIso(),
    settings: allSettings().map((s) => ({ key: s.key, value: s.value })),
    tables: dumpAll(),
  };
  await saveBinaryFile(
    `avtobaza-backup-${stamp()}.json`,
    JSON.stringify(payload, null, 1),
    'application/json',
  );
}

/* ------------------------------------------------------------------ */
/* Облачный файл данных: без картинок                                  */
/* ------------------------------------------------------------------ */

/** Поля, в которых лежат логотипы и значки справочников */
export const PICTURE_COLUMNS: { table: TableName; column: string; title: string }[] = [
  { table: 'companies', column: 'logo', title: 'Фирма' },
  { table: 'cargo_types', column: 'icon', title: 'Груз' },
  { table: 'fuel_stations', column: 'logo', title: 'АЗС' },
  { table: 'vehicles', column: 'logo', title: 'Автомобиль' },
];

/** Картинка хранится прямо в базе, а не ссылкой на чужой сайт */
export function isEmbeddedPicture(value: unknown): boolean {
  return String(value ?? '').startsWith('data:');
}

/**
 * Настройки, которые у каждого устройства свои: в облако их не выгружаем.
 * Иначе одно устройство затирало бы отметки об обмене у другого — и оно
 * решило бы, что выгружать уже нечего.
 */
const LOCAL_SETTINGS = new Set([
  'yadisk_dirty',
  'yadisk_last_at',
  'yadisk_last_data',
  'yadisk_last_icons',
  'yadisk_last_error',
  'yadisk_icons_meta',
  // Когда последний раз проверяли обновления — своё у каждого устройства
  'update_last_at',
]);

/**
 * Файл данных для облака: то же, что полная копия, но картинки из него убраны —
 * они уходят отдельно, по одному файлу. Так файл данных остаётся лёгким и уходит
 * быстро, а ссылки на чужие сайты (они короткие) сохраняются.
 */
export function buildCloudData(): string {
  const tables = dumpAll();
  // Картинки в облачный файл не кладём: они лежат отдельно, в папке files.
  // Поле не пишем вовсе: пустое поле значило бы «картинки нет», и при обмене
  // своя картинка затиралась бы, а потом её пришлось бы качать обратно
  for (const { table, column } of PICTURE_COLUMNS) {
    for (const row of tables[table] ?? []) {
      if (isEmbeddedPicture(row[column])) delete row[column];
    }
  }
  const payload = {
    app: 'avtobaza',
    kind: 'cloud-data',
    version: 1,
    exported_at: nowIso(),
    settings: allSettings()
      .filter((s) => !LOCAL_SETTINGS.has(s.key))
      .map((s) => ({ key: s.key, value: s.value })),
    tables,
  };
  return JSON.stringify(payload);
}

/**
 * Замена данных из облачной копии: на устройстве остаётся ровно то, что в файле.
 * Файлы документов при этом не трогаем — они лежат отдельно и совпадают по путям.
 */
export function replaceFromJson(text: string): ImportResult {
  const payload = JSON.parse(text) as { tables?: Record<string, unknown> };
  if (!payload.tables) throw new Error('Файл не похож на резервную копию АвтоБазы');
  const db = dbSync();
  db.tx(() => {
    for (const t of TABLES) db.run(`DELETE FROM ${t}`);
  });
  return importJson(text, true);
}

export interface ImportResult {
  inserted: number;
  updated: number;
  skipped: number;
  /** Сколько путевых листов из файла слилось с уже заведёнными на устройстве */
  merged: number;
  /** Сколько записей справочников (грузы, АЗС) слилось со своими */
  mergedRefs: number;
  /** Сколько начислений слилось со своими по той же перевозке */
  mergedOps: number;
  /** Сколько файлов архива удалось распознать */
  files: number;
  message: string;
}

function isTable(name: string): name is TableName {
  return (TABLES as readonly string[]).includes(name);
}

/**
 * Текст из байтов. Сначала UTF-8; если он «не сложился», пробуем windows-1251 —
 * так выгружает Excel и многие старые программы.
 */
export function decodeText(bytes: Uint8Array): string {
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    const legacy = new TextDecoder('windows-1251').decode(bytes);
    const letters = (legacy.match(/[\u0400-\u04FF]/g) ?? []).length;
    const broken = (legacy.match(/\uFFFD/g) ?? []).length;
    if (letters > 0 && broken === 0) return legacy;
  } catch {
    /* в этой сборке нет такой кодировки — остаётся UTF-8 */
  }
  return utf8;
}

/** Итог импорта словами — чтобы «ничего не добавилось» не выглядело как поломка */
function describeImport(
  inserted: number,
  updated: number,
  skipped: number,
  merged: number,
  mergedRefs: number,
  mergedOps: number,
  files: number,
): string {
  const parts: string[] = [];
  if (inserted > 0) parts.push(`добавлено ${inserted}`);
  if (updated > 0) parts.push(`обновлено ${updated}`);
  if (merged > 0) parts.push(`слито листов ${merged}`);
  if (mergedRefs > 0) parts.push(`слито записей справочников ${mergedRefs}`);
  if (mergedOps > 0) parts.push(`слито начислений ${mergedOps}`);
  if (skipped > 0) parts.push(`уже было ${skipped}`);
  if (files === 0) return 'В архиве не нашлось ни одной таблицы АвтоБазы';
  if (parts.length === 0) return `Файлов распознано: ${files}, новых записей нет`;
  return parts.join(', ');
}

/** Поля-ссылки на путевой лист: при слиянии листов ссылки переводим на свой лист */
const WAYBILL_LINKS: Partial<Record<TableName, string>> = {
  trips: 'waybill_id',
  refuelings: 'waybill_id',
  finance_ops: 'waybill_id',
};

/**
 * Справочники, у которых название и есть лицо записи.
 *
 * Список грузов и АЗС новое устройство заполняет само, и такой же список приходит
 * из облака — с другими номерами, но теми же названиями. Раньше в справочнике
 * оказывалось по две записи «Щебень», «Лукойл» и так далее. Такую запись не
 * удваиваем, а дополняем свою.
 */
/** Поля-ссылки на такие справочники: переводим их на свою запись */
const REF_LINKS: Partial<Record<TableName, Record<string, TableName>>> = {
  companies: { cargo_type_id: 'cargo_types' },
  places: { cargo_type_id: 'cargo_types' },
  trips: { cargo_type_id: 'cargo_types' },
  trip_points: { cargo_type_id: 'cargo_types' },
  refuelings: { station_id: 'fuel_stations' },
};

/** Поля, которые при слиянии не трогаем: они свои у каждой записи */
const OWN_FIELDS = new Set(['id', 'created_at', 'updated_at', 'deleted']);

/** Что дописать в свою запись из облачной копии: только пустые поля */
function fillEmpty(
  mine: Record<string, unknown>,
  theirs: Record<string, unknown>,
): Record<string, unknown> {
  const fill: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(theirs)) {
    if (OWN_FIELDS.has(key)) continue;
    if (textOf(mine[key]) === '' && textOf(value) !== '') fill[key] = value;
  }
  return fill;
}

/** Поля шапки листа, которые дополняем из облачной копии, если у себя они пусты */
const WAYBILL_FILL = [
  'number',
  'name',
  'odometer_out',
  'fuel_out',
  'date_in',
  'odometer_in',
  'fuel_in',
  'vehicle_id',
  'trailer_id',
  'note',
] as const;

function textOf(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Переводит ссылки записи на свои записи, если те слились с уже заведёнными:
 * на свой путевой лист, на свой груз или АЗС.
 */
function redirected(
  table: TableName,
  row: Record<string, unknown>,
  waybillOf: Map<string, string>,
  refs: Map<TableName, Map<string, string>>,
): Record<string, unknown> {
  let out = row;
  const link = WAYBILL_LINKS[table];
  if (link) {
    const moved = waybillOf.get(textOf(row[link]));
    if (moved) out = { ...out, [link]: moved };
  }
  const links = REF_LINKS[table];
  if (links) {
    for (const [column, refTable] of Object.entries(links)) {
      const moved = refs.get(refTable)?.get(textOf(out[column]));
      if (moved) out = { ...out, [column]: moved };
    }
  }
  if (table === 'attachments' && textOf(out.owner_table) === 'waybills') {
    const moved = waybillOf.get(textOf(out.owner_id));
    if (moved) out = { ...out, owner_id: moved };
  }
  return out;
}

/**
 * Импорт JSON-копии. Совпадающие записи (по id) остаются без изменений.
 *
 * Записи сверяем не только по id: одно и то же могли завести на двух устройствах,
 * и тогда из облака приходит близнец под чужим id.
 *
 *  - путевые листы: «тот же лист» — та же дата, статус и автомобиль. Раньше из-за
 *    этого в базе оказывались две шапки на один день — «новый путевой с пустой
 *    поездкой», после которого путались смена на главной и итоги;
 *  - грузы и АЗС: «та же запись» — то же название (список грузов заполняется на
 *    новом устройстве само, поэтому дубли появлялись сразу после подключения облака);
 *  - начисление за перевозку: по перевозке начисление одно, в том числе если её
 *    закрыли на двух устройствах.
 *
 * При слиянии записи из файла переводятся на свою запись, а пустые поля своей
 * дополняются из облачной копии: ничего из того, что уже введено, не затирается.
 */
export function importJson(text: string, overwrite = false): ImportResult {
  const payload = JSON.parse(text) as {
    app?: string;
    tables?: Record<string, Record<string, unknown>[]>;
    settings?: { key: string; value: string }[];
  };
  // Файл только с настройками (см. exportSettingsFile): данные не трогаем
  if (!payload.tables && Array.isArray(payload.settings)) {
    const applied = applySettingsFile(text);
    return {
      inserted: 0,
      updated: 0,
      skipped: 0,
      merged: 0,
      mergedRefs: 0,
      mergedOps: 0,
      files: 0,
      message: `настроек восстановлено: ${applied}`,
    };
  }
  if (!payload.tables) throw new Error('Файл не похож на резервную копию АвтоБазы');

  const db = dbSync();
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let merged = 0;
  let mergedRefs = 0;
  let mergedOps = 0;
  /** id листа из файла → id того же листа на устройстве */
  const waybillOf = new Map<string, string>();
  /** id записи справочника из файла → id своей записи: отдельно по каждой таблице */
  const refs = new Map<TableName, Map<string, string>>();
  /** id начисления из файла → id своего начисления по той же перевозке */
  const chargeOf = new Map<string, string>();

  db.tx(() => {
    // Сначала путевые листы: свой лист не удваиваем, а ссылки из файла переводим на него
    for (const row of payload.tables?.waybills ?? []) {
      const id = textOf(row.id);
      if (!id) continue;
      if (dbSync().one<{ id: string }>('SELECT id FROM waybills WHERE id = ?', [id])) continue;
      const twin = sameWaybill({
        date_out: textOf(row.date_out),
        status: textOf(row.status) === 'closed' ? 'closed' : 'open',
        vehicle_id: textOf(row.vehicle_id) || null,
        date_in: textOf(row.date_in) || null,
      });
      if (!twin) continue;
      waybillOf.set(id, twin.id);
      merged++;
      const fill: Record<string, unknown> = {};
      for (const key of WAYBILL_FILL) {
        if (textOf(twin[key]) === '' && textOf(row[key]) !== '') fill[key] = row[key];
      }
      if (Object.keys(fill).length > 0) updateRow('waybills', twin.id, fill);
    }

    // Грузы и АЗС: своя запись с тем же названием уже есть — не удваиваем её
    for (const table of SAME_BY_NAME) {
      const map = new Map<string, string>();
      const mine = dbSync().all<Record<string, unknown>>(
        `SELECT * FROM ${table} WHERE deleted = 0`,
      );
      for (const row of payload.tables?.[table] ?? []) {
        const id = textOf(row.id);
        if (!id) continue;
        // Запись с таким id уже есть на устройстве: её судьбу решает основной цикл
        if (mine.some((r) => textOf(r.id) === id)) continue;
        const key = normalizeName(textOf(row.name));
        if (!key) continue;
        const twin = mine.find((r) => normalizeName(textOf(r.name)) === key);
        if (!twin) continue;
        map.set(id, textOf(twin.id));
        mergedRefs++;
        const fill = fillEmpty(twin, redirected(table, row, waybillOf, refs));
        if (Object.keys(fill).length > 0) updateRow(table, textOf(twin.id), fill);
      }
      if (map.size > 0) refs.set(table, map);
    }

    // Начисление за перевозку: по перевозке оно одно, даже если её закрыли дважды
    const myCharges = new Map<string, string>();
    for (const row of dbSync().all<Record<string, unknown>>(
      "SELECT id, trip_id FROM finance_ops WHERE deleted = 0 AND kind = 'charge'",
    )) {
      const trip = textOf(row.trip_id);
      if (trip) myCharges.set(trip, textOf(row.id));
    }
    for (const row of payload.tables?.finance_ops ?? []) {
      const id = textOf(row.id);
      if (!id || textOf(row.kind) !== 'charge') continue;
      const mine = myCharges.get(textOf(row.trip_id));
      if (!mine || mine === id) continue;
      chargeOf.set(id, mine);
      mergedOps++;
      const own = dbSync().one<Record<string, unknown>>('SELECT * FROM finance_ops WHERE id = ?', [
        mine,
      ]);
      if (!own) continue;
      const fill = fillEmpty(own, redirected('finance_ops', row, waybillOf, refs));
      if (Object.keys(fill).length > 0) updateRow('finance_ops', mine, fill);
    }

    for (const [table, rows] of Object.entries(payload.tables ?? {})) {
      if (!isTable(table)) continue;
      for (const row of rows) {
        const id = textOf(row.id);
        if (!id) {
          skipped++;
          continue;
        }
        // Лист или запись справочника уже есть на устройстве под своим id:
        // запись не заводим, ссылки из файла и так ушли на неё
        if (table === 'waybills' && waybillOf.has(id)) continue;
        if (refs.get(table)?.has(id)) continue;
        if (table === 'finance_ops' && chargeOf.has(id)) continue;

        const clean = redirected(table, row, waybillOf, refs);

        const exists = dbSync().one<{ id: string }>(`SELECT id FROM ${table} WHERE id = ?`, [id]);
        if (exists) {
          if (overwrite) {
            const entries = Object.entries(clean).filter(([k]) => k !== 'id');
            updateRow(table, id, Object.fromEntries(entries));
            updated++;
          } else skipped++;
        } else {
          insertRow(table, clean);
          inserted++;
        }
      }
    }
    for (const s of payload.settings ?? []) {
      setSetting(s.key as keyof AppSettings, s.value);
    }
  });

  const files = Object.keys(payload.tables ?? {}).length;
  return {
    inserted,
    updated,
    skipped,
    merged,
    mergedRefs,
    mergedOps,
    files,
    message: describeImport(inserted, updated, skipped, merged, mergedRefs, mergedOps, files),
  };
}

/** Встроить шрифт с кириллицей, иначе в PDF будут пустые квадраты */
async function embedCyrillicFont(doc: { addFileToVFS: (n: string, b: string) => void; addFont: (f: string, n: string, s: string) => void; setFont: (n: string, s?: string) => void }): Promise<void> {
  const load = async (file: string) => {
    const res = await fetch(new URL(`fonts/${file}`, document.baseURI).href);
    if (!res.ok) throw new Error(`Не удалось загрузить шрифт ${file}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < buf.length; i += chunk) bin += String.fromCharCode(...buf.subarray(i, i + chunk));
    return btoa(bin);
  };
  const [regular, bold] = await Promise.all([load('DejaVuSans.ttf'), load('DejaVuSans-Bold.ttf')]);
  doc.addFileToVFS('DejaVuSans.ttf', regular);
  doc.addFont('DejaVuSans.ttf', 'DejaVu', 'normal');
  doc.addFileToVFS('DejaVuSans-Bold.ttf', bold);
  doc.addFont('DejaVuSans-Bold.ttf', 'DejaVu', 'bold');
  doc.setFont('DejaVu', 'normal');
}

/** Печать одного путевого листа: данные листа, перевозки, точки маршрута, итоги */
export async function exportWaybillPdf(waybillId: string, settings: AppSettings): Promise<void> {
  const waybill = waybillRepo.get(waybillId);
  if (!waybill) throw new Error('Путевой лист не найден');
  const bytes = await buildWaybillPdf(waybillId, settings);
  await saveBinaryFile(
    `putevoy-list-${waybill.date_out}${waybill.date_in ? '-' + waybill.date_in : ''}.pdf`,
    bytes,
    'application/pdf',
  );
}

/** Подготовить PDF путевого листа (без сохранения — удобно для проверок) */
export async function buildWaybillPdf(waybillId: string, settings: AppSettings): Promise<Uint8Array> {
  const waybill = waybillRepo.get(waybillId);
  if (!waybill) throw new Error('Путевой лист не найден');

  const [{ jsPDF }, autoTable] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  await embedCyrillicFont(doc as unknown as Parameters<typeof embedCyrillicFont>[0]);

  const s = summarizeWaybill(waybill);
  const vehicle = refs.vehicle(waybill.vehicle_id);
  const trailer = refs.vehicle(waybill.trailer_id);

  doc.setFontSize(16);
  doc.text('Путевой лист', 14, 18);
  doc.setFontSize(10);
  doc.text(`Сформировано: ${new Date().toLocaleString('ru-RU')}`, 196, 18, { align: 'right' });

  autoTable.default(doc, {
    startY: 24,
    theme: 'plain',
    styles: { fontSize: 9, font: 'DejaVu', cellPadding: 1.2 },
    columnStyles: { 0: { cellWidth: 52, textColor: [110, 110, 110] }, 1: { fontStyle: 'bold' } },
    body: [
      ['Дата выезда', fmtDate(waybill.date_out)],
      ['Дата сдачи', waybill.date_in ? fmtDate(waybill.date_in) : 'лист открыт'],
      ['Номер листа', waybill.number || '—'],
      ['Тягач', vehicle ? `${vehicle.name}${vehicle.plate ? ' · ' + vehicle.plate : ''}` : '—'],
      ['Прицеп', trailer ? `${trailer.name}${trailer.plate ? ' · ' + trailer.plate : ''}` : '—'],
      ['Одометр при выезде', waybill.odometer_out === null ? '—' : `${fmtNumber(waybill.odometer_out)} км`],
      ['Одометр при сдаче', waybill.odometer_in === null ? '—' : `${fmtNumber(waybill.odometer_in)} км`],
      ['Топливо при выезде', waybill.fuel_out === null ? '—' : `${fmtNumber(waybill.fuel_out)} л`],
      ['Топливо при сдаче', waybill.fuel_in === null ? '—' : `${fmtNumber(waybill.fuel_in)} л`],
      ['Заправлено за лист', `${fmtNumber(s.refueled)} л (${s.refuelCount} заправок)`],
      ['Пробег', s.mileage === null ? '—' : `${fmtNumber(s.mileage)} км`],
      ['Израсходовано топлива', s.consumed === null ? '—' : `${fmtNumber(s.consumed)} л`],
      [
        'Средний расход',
        s.avgConsumption === null ? '—' : `${fmtNumber(s.avgConsumption, 1)} л/100 км`,
      ],
      ['Норма расхода', s.normConsumption === null ? '—' : `${fmtNumber(s.normConsumption)} л`],
      ['Начислено по листу', fmtMoney(s.charged, settings.currency)],
    ],
  });

  // В печатном листе перевозки идут по порядку, как их завели за смену,
  // а в списках на экране свежие — сверху
  const tripsAsc = [...s.trips].sort((a, b) =>
    (a.trip.created_at ?? '').localeCompare(b.trip.created_at ?? ''),
  );

  const tripRows: string[][] = [];
  for (const t of tripsAsc) {
    tripRows.push([
      t.title,
      String(t.pointsCount),
      `${fmtDate(t.dateLoad)} — ${fmtDate(t.dateUnload)}`,
      fmtNumber(t.totalWeight),
      fmtMoney(t.amount, settings.currency),
    ]);
  }

  autoTable.default(doc, {
    // @ts-expect-error lastAutoTable добавляется плагином
    startY: (doc as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY + 8 || 60,
    head: [['Перевозка', 'Точек', 'План/факт даты', 'Вес, кг', 'Начислено']],
    body: tripRows.length > 0 ? tripRows : [['Перевозок нет', '', '', '', '']],
    styles: { fontSize: 8, font: 'DejaVu' },
    headStyles: { fillColor: [14, 124, 144], font: 'DejaVu' },
  });

  const pointRows: string[][] = [];
  for (const t of tripsAsc) {
    t.points.forEach((p, idx) => {
      const place = refs.place(p.place_id);
      const company = refs.company(place?.company_id ?? null);
      pointRows.push([
        t.title,
        `${idx + 1}. ${p.kind === 'load' ? 'Погрузка' : 'Выгрузка'}`,
        place?.name ?? '—',
        company?.name ?? '—',
        place?.address ?? '—',
        fmtDate(p.fact_date ?? p.plan_date),
        p.status === 'done' ? 'Выполнено' : 'В плане',
        loadTypeLabel(p.load_type),
      ]);
    });
  }

  autoTable.default(doc, {
    // @ts-expect-error lastAutoTable добавляется плагином
    startY: (doc as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY + 8 || 90,
    head: [['Перевозка', 'Точка', 'Место', 'Фирма', 'Адрес', 'Дата', 'Статус', 'Загрузка']],
    body: pointRows.length > 0 ? pointRows : [['Точек нет', '', '', '', '', '', '', '']],
    styles: { fontSize: 7, font: 'DejaVu' },
    headStyles: { fillColor: [14, 124, 144], font: 'DejaVu' },
    columnStyles: { 0: { cellWidth: 26 }, 2: { cellWidth: 24 }, 3: { cellWidth: 24 }, 4: { cellWidth: 34 } },
  });

  if (s.errors.length > 0 || s.warnings.length > 0) {
    autoTable.default(doc, {
      // @ts-expect-error lastAutoTable добавляется плагином
      startY: (doc as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY + 8 || 130,
      head: [['Замечания']],
      body: [...s.errors.map((e) => [`Ошибка: ${e}`]), ...s.warnings.map((w) => [`Внимание: ${w}`])],
      styles: { fontSize: 8, font: 'DejaVu', textColor: [170, 50, 60] },
      headStyles: { fillColor: [170, 50, 60], font: 'DejaVu' },
    });
  }

  return new Uint8Array(doc.output('arraybuffer') as ArrayBuffer);
}

/** Отчёт PDF: сводка за месяц */
export async function exportPdfReport(month: string, settings: AppSettings): Promise<void> {
  const bytes = await buildMonthReportPdf(month, settings);
  await saveBinaryFile(`avtobaza-report-${month || stamp()}.pdf`, bytes, 'application/pdf');
}

/** Подготовить PDF-отчёт за месяц (без сохранения) */
export async function buildMonthReportPdf(month: string, settings: AppSettings): Promise<Uint8Array> {
  const [{ jsPDF }, autoTable] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  await embedCyrillicFont(doc as unknown as Parameters<typeof embedCyrillicFont>[0]);
  doc.setFont('DejaVu', 'normal');

  doc.setFontSize(16);
  doc.text('АвтоБаза — отчёт', 14, 18);
  doc.setFontSize(11);
  doc.text(month ? monthLabel(month) : 'Все месяцы', 14, 25);
  doc.setFontSize(9);
  doc.text(`Сформировано: ${new Date().toLocaleString('ru-RU')}`, 14, 30);

  const finance = summarizeFinance(month || null);
  const waybills = waybillRepo.list().filter((w) => !month || w.date_out.slice(0, 7) === month);
  const monthTrips = tripRepo.all().filter((t) => {
    if (!month) return true;
    const wb = waybillRepo.get(t.waybill_id);
    return (wb?.date_out ?? t.created_at).slice(0, 7) === month;
  });
  const monthRefuels = refuelRepo.list().filter((r) => !month || r.date.slice(0, 7) === month);

  autoTable.default(doc, {
    startY: 36,
    head: [['Показатель', 'Значение']],
    body: [
      ['Начислено', fmtMoney(finance.charged, settings.currency)],
      ['Оплачено', fmtMoney(finance.paid, settings.currency)],
      ['В семью', fmtMoney(finance.family, settings.currency)],
      ['Остаток', fmtMoney(finance.balance, settings.currency)],
      ['Путевых листов, шт.', String(waybills.length)],
      ['Перевозок, шт.', String(monthTrips.length)],
      ['Заправок, шт.', String(monthRefuels.length)],
    ],
    styles: { fontSize: 9, font: 'DejaVu' },
  });

  const rows = waybills.map((w) => {
    const s = summarizeWaybill(w);
    return [
      `${fmtDate(w.date_out)} — ${w.date_in ? fmtDate(w.date_in) : 'открыт'}`,
      s.vehicleTitle,
      s.trailerTitle || '—',
      s.mileage === null ? '—' : fmtNumber(s.mileage),
      fmtNumber(s.refueled),
      s.avgConsumption === null ? '—' : fmtNumber(s.avgConsumption, 1),
      fmtMoney(s.charged, settings.currency),
    ];
  });
  const mileageSum = waybills.reduce((s, w) => s + (summarizeWaybill(w).mileage ?? 0), 0);
  const refuelSum = waybills.reduce((s, w) => s + summarizeWaybill(w).refueled, 0);
  const chargedSum = waybills.reduce((s, w) => s + summarizeWaybill(w).charged, 0);

  autoTable.default(doc, {
    // @ts-expect-error lastAutoTable добавляется плагином
    startY: (doc as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY + 8 || 60,
    head: [['Период', 'Автомобиль', 'Прицеп', 'Пробег, км', 'Заправлено, л', 'Расход, л/100', 'Начислено']],
    body: rows.length > 0 ? rows : [['Нет данных', '', '', '', '', '', '']],
    foot:
      rows.length > 0
        ? [['Итого, л. ' + String(waybills.length), '', '', fmtNumber(mileageSum), fmtNumber(refuelSum), '', fmtMoney(chargedSum, settings.currency)]]
        : undefined,
    styles: { fontSize: 8, font: 'DejaVu' },
    headStyles: { font: 'DejaVu' },
    footStyles: { font: 'DejaVu', fontStyle: 'bold' },
    columnStyles: { 1: { cellWidth: 38 }, 2: { cellWidth: 34 } },
  });

  const trips = monthTrips;
  const tripRows = trips.map((t) => {
    const s = summarizeTrip(t);
    return [
      fmtDate(s.dateLoad),
      s.title,
      s.pointsCount ? String(s.pointsCount) : '0',
      fmtNumber(s.totalWeight),
      fmtMoney(s.amount, settings.currency),
    ];
  });

  autoTable.default(doc, {
    // @ts-expect-error lastAutoTable добавляется плагином
    startY: (doc as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY + 8 || 120,
    head: [['Дата', 'Маршрут', 'Точек, шт.', 'Вес, кг', 'Начислено']],
    body: tripRows.length > 0 ? tripRows : [['Нет данных', '', '', '', '']],
    foot:
      trips.length > 0
        ? [
            [
              `Итого, перевозок ${trips.length}`,
              '',
              String(trips.reduce((s, t) => s + summarizeTrip(t).pointsCount, 0)),
              fmtNumber(trips.reduce((s, t) => s + summarizeTrip(t).totalWeight, 0)),
              fmtMoney(
                trips.reduce((s, t) => s + summarizeTrip(t).amount, 0),
                settings.currency,
              ),
            ],
          ]
        : undefined,
    styles: { fontSize: 8, font: 'DejaVu' },
    headStyles: { font: 'DejaVu' },
    footStyles: { font: 'DejaVu', fontStyle: 'bold' },
  });

  const refuels = monthRefuels;
  autoTable.default(doc, {
    // @ts-expect-error lastAutoTable добавляется плагином
    startY: (doc as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY + 8 || 160,
    head: [['Дата заправки', 'Объём, л', 'Источник']],
    body:
      refuels.length > 0
        ? refuels.map((r) => [fmtDate(r.date), fmtNumber(r.volume), r.kind === 'barrel' ? 'Бочка' : 'АЗС'])
        : [['Нет данных', '', '']],
    foot:
      refuels.length > 0
        ? [[`Итого, заправок ${refuels.length}`, fmtNumber(refuels.reduce((s, r) => s + r.volume, 0)), '']]
        : undefined,
    styles: { fontSize: 8, font: 'DejaVu' },
    headStyles: { font: 'DejaVu' },
    footStyles: { font: 'DejaVu', fontStyle: 'bold' },
  });

  return new Uint8Array(doc.output('arraybuffer') as ArrayBuffer);
}

/** Список операций за месяц в виде строк для отчётов */
export function monthOperations(month: string) {
  return financeRepo.byMonth(month);
}

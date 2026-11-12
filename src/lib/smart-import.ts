/**
 * Умное распознавание архивов.
 *
 * Чужой архив почти никогда не совпадает с нашей базой: файлы названы иначе,
 * колонки — по-своему, часть полей лишняя, а часть отсутствует. Здесь мы:
 *
 *   1) читаем архив (ZIP с CSV, Excel, одиночный CSV, JSON-копия);
 *   2) угадываем, какому файлу какая таблица соответствует;
 *   3) сопоставляем колонки с полями базы (словарь синонимов + ИИ, если задан ключ);
 *   4) показываем план и подсказки, каких полей не хватает в базе;
 *   5) переносим только то, что поняли, а справочники (места, грузы, фирмы)
 *      создаём по названию.
 */

import { dbSync } from '../db';
import { insertRow } from '../db/repo';
import { TABLES, type TableName } from '../types';
import { cleanCsvRow, columnTypesOf, decodeText, parseCsv, toNumber, TABLE_TITLES } from './backup';
import { askModel, readAiConfig } from './ai';

/* ------------------------------------------------------------------ */
/* Описание полей базы                                                */
/* ------------------------------------------------------------------ */

/** Куда попадает «умное» поле, которого в базе нет как колонки */
export type VirtualKind = 'place' | 'company' | 'cargo' | 'station' | 'vehicle' | 'waybill' | 'date';

export interface FieldDef {
  name: string;
  label: string;
  /** Как это поле может называться в чужом файле */
  hints: string[];
  virtual?: VirtualKind;
}

const f = (name: string, label: string, hints: string[], virtual?: VirtualKind): FieldDef => ({
  name,
  label,
  hints: [name, ...hints],
  virtual,
});

const NOTE: string[] = ['примечание', 'комментарий', 'заметка', 'note', 'comment', 'описание'];
const NAME: string[] = ['название', 'имя', 'name', 'title', 'наименование'];

/** Синонимы колонок по таблицам — основа распознавания без ИИ */
export const FIELDS: Record<TableName, FieldDef[]> = {
  vehicles: [
    f('name', 'Название', NAME),
    f('plate', 'Госномер', ['госномер', 'номерной знак', 'рег знак', 'номер тс', 'plate', 'reg number']),
    f('kind', 'Тип (тягач/прицеп)', ['тип', 'вид', 'категория', 'kind', 'type']),
    f('brand', 'Марка', ['марка', 'производитель', 'brand', 'make']),
    f('model', 'Модель', ['модель', 'model']),
    f('vin', 'VIN', ['vin', 'вин']),
    f('year', 'Год выпуска', ['год выпуска', 'год', 'year']),
    f('fuel_norm', 'Норма расхода', ['норма расхода', 'расход', 'л/100', 'fuel norm']),
    f('note', 'Примечание', NOTE),
    f('archived', 'В архиве', ['архив', 'archived']),
  ],
  vehicle_periods: [
    f('vehicle_id', 'Автомобиль', ['автомобиль', 'машина', 'vehicle']),
    f('start_date', 'Начало', ['начало', 'дата начала', 'start']),
    f('end_date', 'Окончание', ['окончание', 'дата окончания', 'end']),
    f('note', 'Примечание', NOTE),
  ],
  vehicle_links: [
    f('tractor_id', 'Тягач', ['тягач', 'tractor']),
    f('trailer_id', 'Прицеп', ['прицеп', 'trailer']),
    f('start_date', 'Начало', ['начало', 'дата начала', 'start']),
    f('end_date', 'Окончание', ['окончание', 'дата окончания', 'end']),
  ],
  companies: [f('name', 'Название', NAME), f('note', 'Примечание', NOTE)],
  cargo_types: [f('name', 'Название', NAME), f('note', 'Примечание', NOTE)],
  fuel_stations: [f('name', 'Название', NAME), f('note', 'Примечание', NOTE)],
  places: [
    f('name', 'Название', NAME),
    f('address', 'Адрес', ['адрес', 'address', 'местоположение']),
    f('lat', 'Широта', ['широта', 'lat', 'latitude']),
    f('lon', 'Долгота', ['долгота', 'lon', 'lng', 'longitude']),
    f('contact', 'Контакт', ['контакт', 'телефон', 'contact', 'phone', 'тел']),
    f('load_type', 'Тип загрузки', ['тип загрузки', 'загрузка', 'load type']),
    f('note', 'Примечание', NOTE),
    f('company_name', 'Фирма', ['фирма', 'компания', 'организация', 'заказчик', 'company'], 'company'),
  ],
  waybills: [
    f('number', 'Номер листа', ['номер листа', 'номер путевого листа', 'номер', '№', 'number']),
    f('name', 'Название', NAME),
    f('date_out', 'Дата выезда', ['дата выезда', 'выезд', 'дата выхода', 'date out', 'дата начала']),
    f('odometer_out', 'Одометр на выезде', ['одометр выезд', 'одометр на выезде', 'пробег выезд', 'odometer out']),
    f('fuel_out', 'Топливо на выезде', ['топливо выезд', 'дт выезд', 'бак выезд', 'fuel out']),
    f('date_in', 'Дата приезда', ['дата приезда', 'приезд', 'дата возврата', 'date in']),
    f('odometer_in', 'Одометр на приезде', ['одометр приезд', 'одометр на приезде', 'пробег приезд', 'odometer in']),
    f('fuel_in', 'Топливо на приезде', ['топливо приезд', 'дт приезд', 'бак приезд', 'fuel in']),
    f('note', 'Примечание', NOTE),
    f('status', 'Статус', ['статус', 'status']),
    f('vehicle_name', 'Автомобиль', ['автомобиль', 'машина', 'тягач', 'госномер', 'vehicle'], 'vehicle'),
  ],
  trips: [
    f('weight', 'Вес', ['вес', 'масса', 'тоннаж', 'weight', 'масса груза']),
    f('amount', 'Начислено', ['начислено', 'сумма', 'стоимость', 'amount', 'price', 'оплата']),
    f('note', 'Примечание', NOTE),
    f('status', 'Статус', ['статус', 'status']),
    f('date', 'Дата перевозки', ['дата перевозки', 'дата', 'дата рейса', 'date'], 'date'),
    f('waybill_number', 'Номер путевого листа', ['путевой лист', 'номер листа', 'лист', 'waybill'], 'waybill'),
    f('place_from', 'Место загрузки', ['откуда', 'загрузка', 'место загрузки', 'погрузка', 'from'], 'place'),
    f('place_to', 'Место выгрузки', ['куда', 'выгрузка', 'место выгрузки', 'разгрузка', 'to'], 'place'),
    f('cargo_name', 'Груз', ['груз', 'наименование груза', 'номенклатура', 'cargo'], 'cargo'),
  ],
  trip_points: [
    f('seq', 'Порядок', ['порядок', 'номер по порядку', 'seq', '№']),
    f('kind', 'Тип точки', ['тип точки', 'вид', 'операция', 'kind']),
    f('plan_date', 'Плановая дата', ['плановая дата', 'план', 'plan date']),
    f('fact_date', 'Фактическая дата', ['фактическая дата', 'факт', 'fact date']),
    f('load_type', 'Тип загрузки', ['тип загрузки', 'загрузка', 'load type']),
    f('weight', 'Вес', ['вес', 'масса', 'weight']),
    f('status', 'Статус', ['статус', 'status']),
    f('note', 'Примечание', NOTE),
    f('place_name', 'Место', ['место', 'точка', 'адрес', 'place'], 'place'),
    f('cargo_name', 'Груз', ['груз', 'cargo'], 'cargo'),
  ],
  refuelings: [
    f('date', 'Дата', ['дата', 'date']),
    f('volume', 'Количество, л', ['количество', 'литры', 'объем', 'объём', 'л', 'volume', 'liters']),
    f('kind', 'Тип заправки', ['тип', 'способ', 'источник', 'kind']),
    f('note', 'Примечание', NOTE),
    f('station_name', 'АЗС', ['азс', 'заправка', 'станция', 'station'], 'station'),
    f('waybill_number', 'Номер путевого листа', ['путевой лист', 'номер листа', 'лист', 'waybill'], 'waybill'),
  ],
  finance_ops: [
    f('date', 'Дата', ['дата', 'date']),
    f('kind', 'Тип операции', ['тип', 'вид операции', 'операция', 'kind']),
    f('amount', 'Сумма', ['сумма', 'начислено', 'оплата', 'amount', 'money']),
    f('pay_month', 'Месяц оплаты', ['месяц оплаты', 'месяц', 'период', 'pay month']),
    f('note', 'Примечание', NOTE),
  ],
  attachments: [
    f('title', 'Название', NAME),
    f('mime', 'Тип файла', ['тип файла', 'mime']),
    f('size', 'Размер', ['размер', 'size']),
  ],
};

/** Как файл может называться, чтобы попасть в нужную таблицу */
export const TABLE_HINTS: Record<TableName, string[]> = {
  vehicles: ['автомобили', 'машины', 'транспорт', 'автопарк', 'тягачи', 'прицепы', 'vehicles'],
  vehicle_periods: ['периоды автомобилей', 'период', 'periods'],
  vehicle_links: ['связки', 'тягач прицеп', 'links'],
  companies: ['фирмы', 'компании', 'организации', 'заказчики', 'контрагенты', 'companies'],
  cargo_types: ['грузы', 'номенклатура', 'cargo'],
  fuel_stations: ['азс', 'заправки список', 'сети заправок', 'fuel stations'],
  places: ['места', 'адреса', 'точки', 'пункты', 'places', 'locations'],
  waybills: ['путевые листы', 'путевки', 'листы', 'waybills'],
  trips: ['перевозки', 'рейсы', 'поездки', 'заявки', 'trips'],
  trip_points: ['точки маршрута', 'маршрут', 'точки', 'route points'],
  refuelings: ['заправки', 'топливо', 'заливки', 'refuelings'],
  finance_ops: ['финансы', 'оплаты', 'платежи', 'начисления', 'деньги', 'finance', 'payments'],
  attachments: ['документы', 'файлы', 'сканы', 'attachments'],
};

/* ------------------------------------------------------------------ */
/* Чтение архива                                                      */
/* ------------------------------------------------------------------ */

export interface ArchiveSheet {
  /** Имя файла или листа Excel */
  source: string;
  columns: string[];
  rows: Record<string, string>[];
}

function sheetFromRecords(source: string, records: Record<string, string>[]): ArchiveSheet[] {
  if (records.length === 0) return [];
  const columns = Object.keys(records[0]);
  if (columns.length === 0) return [];
  return [{ source, columns, rows: records }];
}

function sheetFromMatrix(source: string, matrix: unknown[][]): ArchiveSheet | null {
  const first = matrix.find((line) => line.some((c) => String(c ?? '').trim() !== ''));
  if (!first) return null;
  const head = first.map((c) => String(c ?? '').trim());
  const columns = head.map((h, i) => (h === '' ? `Колонка ${i + 1}` : h));
  const rows: Record<string, string>[] = [];
  for (const line of matrix.slice(matrix.indexOf(first) + 1)) {
    if (!line || line.every((c) => String(c ?? '').trim() === '')) continue;
    const row: Record<string, string> = {};
    columns.forEach((c, i) => {
      row[c] = String(line[i] ?? '').trim();
    });
    rows.push(row);
  }
  return { source, columns, rows };
}

/** Прочитать архив любого из поддерживаемых видов */
export async function readArchive(bytes: Uint8Array, filename: string): Promise<ArchiveSheet[]> {
  const lower = filename.toLowerCase();
  const base = filename.replace(/\.[^.]+$/, '');

  if (lower.endsWith('.zip')) {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(bytes);
    const sheets: ArchiveSheet[] = [];
    for (const [name, file] of Object.entries(zip.files)) {
      if (file.dir) continue;
      const inner = name.split('/').pop() ?? name;
      if (/\.csv$/i.test(inner)) {
        const text = decodeText(await file.async('uint8array'));
        sheets.push(...sheetFromRecords(inner.replace(/\.csv$/i, ''), parseCsv(text)));
      } else if (/\.(xlsx|xls)$/i.test(inner)) {
        sheets.push(...(await readWorkbook(new Uint8Array(await file.async('uint8array')))));
      } else if (/\.json$/i.test(inner)) {
        sheets.push(...readJsonBackup(decodeText(await file.async('uint8array'))));
      }
    }
    return sheets;
  }

  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    return readWorkbook(bytes);
  }

  if (lower.endsWith('.json')) {
    return readJsonBackup(decodeText(bytes));
  }

  return sheetFromRecords(base, parseCsv(decodeText(bytes)));
}

async function readWorkbook(bytes: Uint8Array): Promise<ArchiveSheet[]> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(bytes, { type: 'array' });
  const sheets: ArchiveSheet[] = [];
  for (const name of wb.SheetNames) {
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], {
      header: 1,
      raw: false,
      defval: '',
      blankrows: false,
    });
    const sheet = sheetFromMatrix(name, matrix);
    if (sheet) sheets.push(sheet);
  }
  return sheets.length > 0 ? sheets : [];
}

/** JSON-копия АвтоБазы: превращаем таблицы в такие же «листы» */
function readJsonBackup(text: string): ArchiveSheet[] {
  let payload: { tables?: Record<string, Record<string, unknown>[]> };
  try {
    payload = JSON.parse(text) as typeof payload;
  } catch {
    return [];
  }
  if (!payload.tables) return [];
  const sheets: ArchiveSheet[] = [];
  for (const [table, rows] of Object.entries(payload.tables)) {
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const records = rows.map((r) => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(r)) out[k] = v === null || v === undefined ? '' : String(v);
      return out;
    });
    sheets.push({ source: table, columns: Object.keys(records[0]), rows: records });
  }
  return sheets;
}

/* ------------------------------------------------------------------ */
/* Распознавание                                                      */
/* ------------------------------------------------------------------ */

export function normalizeHeader(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .trim();
}

/** Насколько заголовок похож на подсказку: 0 — не похож, 1 — совпал */
export function scoreHint(header: string, hint: string): number {
  const h = normalizeHeader(header);
  const k = normalizeHeader(hint);
  if (!h || !k) return 0;
  if (h === k) return 1;
  // короткие заголовки вроде «A» или «№» не должны совпадать по началу слова
  if ((h.startsWith(k) && k.length >= 3) || (k.startsWith(h) && h.length >= 3)) return 0.9;
  const hw = h.split(' ');
  const kw = k.split(' ');
  const common = hw.filter((w) => w.length > 2 && kw.some((x) => x === w || x.startsWith(w) || w.startsWith(x)));
  if (common.length === 0) return 0;
  return Math.min(0.85, 0.5 + common.length * 0.15);
}

/** Лучшее поле таблицы для колонки архива */
export function bestField(table: TableName, column: string): { field: FieldDef; score: number } | null {
  let best: { field: FieldDef; score: number } | null = null;
  for (const field of FIELDS[table]) {
    for (const hint of field.hints) {
      const score = scoreHint(column, hint);
      if (score > 0 && (!best || score > best.score)) best = { field, score };
    }
  }
  return best && best.score >= 0.5 ? best : null;
}

/** Доля колонок, которым нашлось поле в таблице */
export function columnFit(table: TableName, columns: string[]): number {
  if (columns.length === 0) return 0;
  let hit = 0;
  for (const c of columns) if (bestField(table, c)) hit++;
  return hit / columns.length;
}

export interface TableGuess {
  table: TableName | null;
  via: 'имя' | 'колонки';
  confidence: number;
}

export function detectTable(sheet: ArchiveSheet): TableGuess {
  const name = sheet.source.replace(/\.(csv|xlsx?|json|txt)$/i, '');
  let byName: { table: TableName; score: number } | null = null;
  for (const table of TABLES) {
    const score = Math.max(0, ...TABLE_HINTS[table].map((h) => scoreHint(name, h)));
    if (score > 0 && (!byName || score > byName.score)) byName = { table, score };
  }
  let byCols: { table: TableName; score: number } | null = null;
  for (const table of TABLES) {
    const score = columnFit(table, sheet.columns);
    if (!byCols || score > byCols.score) byCols = { table, score };
  }

  const nameScore = byName?.score ?? 0;
  const colScore = byCols?.score ?? 0;
  const table = nameScore >= 0.7 ? byName!.table : colScore >= 0.5 ? byCols!.table : null;
  if (!table) return { table: null, via: 'колонки', confidence: 0 };
  const confidence =
    nameScore >= 0.7 && byName!.table === table
      ? Math.min(1, nameScore * 0.6 + colScore * 0.4)
      : colScore;
  return { table, via: nameScore >= 0.7 && byName!.table === table ? 'имя' : 'колонки', confidence };
}

/* ------------------------------------------------------------------ */
/* План переноса                                                      */
/* ------------------------------------------------------------------ */

export interface ColumnLink {
  from: string;
  to: string;
  label: string;
  via: 'словарь' | 'ИИ';
}

export interface SheetPlan {
  source: string;
  table: TableName | null;
  tableTitle: string;
  confidence: number;
  via: 'имя' | 'колонки' | 'ИИ';
  rows: number;
  links: ColumnLink[];
  /** Колонки архива, которым не нашлось места в базе */
  unknown: string[];
  /** Справочники, которые придётся создать */
  refs: string[];
}

export interface ImportPlan {
  sheets: SheetPlan[];
  advice: string[];
  aiUsed: boolean;
  aiNote: string;
}

const REF_LABELS: Record<VirtualKind, string> = {
  place: 'Места',
  company: 'Фирмы',
  cargo: 'Грузы',
  station: 'АЗС',
  vehicle: 'Автомобили',
  waybill: 'Путевые листы',
  date: '',
};

export function fieldDef(table: TableName, name: string): FieldDef | undefined {
  return FIELDS[table].find((x) => x.name === name);
}

export function buildPlan(sheets: ArchiveSheet[]): ImportPlan {
  const plans: SheetPlan[] = [];
  const advice: string[] = [];

  for (const sheet of sheets) {
    const guess = detectTable(sheet);
    const links: ColumnLink[] = [];
    const unknown: string[] = [];
    const refs = new Set<string>();

    if (guess.table) {
      for (const column of sheet.columns) {
        const match = bestField(guess.table, column);
        if (!match) {
          unknown.push(column);
          continue;
        }
        links.push({ from: column, to: match.field.name, label: match.field.label, via: 'словарь' });
        if (match.field.virtual && REF_LABELS[match.field.virtual]) refs.add(REF_LABELS[match.field.virtual]);
      }
    } else {
      unknown.push(...sheet.columns);
    }

    plans.push({
      source: sheet.source,
      table: guess.table,
      tableTitle: guess.table ? TABLE_TITLES[guess.table] : '',
      confidence: guess.confidence,
      via: guess.via,
      rows: sheet.rows.length,
      links,
      unknown,
      refs: [...refs],
    });

    if (!guess.table) {
      advice.push(
        `Файл «${sheet.source}» не похож ни на одну таблицу АвтоБазы. Колонки: ${sheet.columns
          .slice(0, 12)
          .join(', ')}. Если эти данные нужны — для них стоит завести новую таблицу.`,
      );
    } else {
      for (const column of unknown) {
        advice.push(
          `Файл «${sheet.source}»: колонка «${column}» не нашла места в таблице «${
            TABLE_TITLES[guess.table]
          }». Если она нужна — добавьте такое поле в базу.`,
        );
      }
    }
  }

  return { sheets: plans, advice: dedupe(advice), aiUsed: false, aiNote: '' };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

/* ------------------------------------------------------------------ */
/* Уточнение с помощью ИИ                                             */
/* ------------------------------------------------------------------ */

/** Краткое описание возможностей базы — уходит модели */
export function catalogText(): string {
  return TABLES.map((table) => {
    const fields = FIELDS[table].map((x) => x.name).join(', ');
    return `${table} (${TABLE_TITLES[table]}): ${fields}`;
  }).join('\n');
}

export function buildAiPrompt(sheets: ArchiveSheet[]): string {
  const parts: string[] = [];
  for (const sheet of sheets) {
    parts.push(`Файл «${sheet.source}», колонки: ${sheet.columns.join(' | ')}`);
    for (const row of sheet.rows.slice(0, 2)) {
      parts.push(
        '  пример: ' +
          sheet.columns
            .slice(0, 12)
            .map((c) => `${c}=${(row[c] ?? '').slice(0, 40)}`)
            .join(', '),
      );
    }
  }
  return [
    'Ты помогаешь перенести данные водителя-одиночки в приложение «АвтоБаза».',
    'Ниже — файлы чужого архива. Определи, какой таблице соответствует каждый файл,',
    'и сопоставь колонки архива с полями базы. Лишние колонки просто пропусти.',
    '',
    'Таблицы и поля базы:',
    catalogText(),
    '',
    'Поля вида place_from, place_to, cargo_name, company_name, station_name, vehicle_name,',
    'waybill_number, date — «умные»: по названию найдётся или создастся нужная запись.',
    '',
    'Архив:',
    ...parts,
    '',
    'Ответь ТОЛЬКО JSON, без пояснений и без markdown:',
    '{"sheets":[{"source":"имя файла","table":"trips","confidence":0.9,',
    '"columns":{"Откуда":"place_from","Куда":"place_to","Вес":"weight"}}],',
    '"advice":["какие поля стоит добавить в базу"]}',
    'Если файл не подходит ни одной таблице — "table": null.',
  ].join('\n');
}

function parseJsonAnswer(text: string): unknown {
  const clean = text
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Модель вернула ответ без JSON');
  return JSON.parse(clean.slice(start, end + 1));
}

function allowedField(table: TableName, name: string): boolean {
  if (columnTypesOf(table).has(name)) return true;
  return FIELDS[table].some((x) => x.name === name);
}

/** Попросить модель уточнить план: таблицы, сопоставление колонок и советы */
export async function refineWithAi(sheets: ArchiveSheet[], plan: ImportPlan): Promise<ImportPlan> {
  const cfg = readAiConfig();
  if (!cfg || !cfg.model) {
    return { ...plan, aiUsed: false, aiNote: 'Ключ ИИ не задан — разобрали по словарю.' };
  }

  let answer: string;
  try {
    answer = await askModel(cfg, [
      { role: 'system', content: 'Ты аккуратный помощник по переносу данных. Отвечаешь только JSON.' },
      { role: 'user', content: buildAiPrompt(sheets) },
    ]);
  } catch (e) {
    return { ...plan, aiUsed: false, aiNote: e instanceof Error ? e.message : 'Сервис не ответил' };
  }

  let parsed: {
    sheets?: { source?: string; table?: string | null; confidence?: number; columns?: Record<string, string> }[];
    advice?: unknown;
  };
  try {
    parsed = parseJsonAnswer(answer) as typeof parsed;
  } catch {
    return { ...plan, aiUsed: false, aiNote: 'Не удалось разобрать ответ модели' };
  }

  const sheetsPlan: SheetPlan[] = [];
  for (const sheet of sheets) {
    const base = plan.sheets.find((p) => p.source === sheet.source);
    const hint = (parsed.sheets ?? []).find((s) => s && s.source === sheet.source);
    const table =
      hint && typeof hint.table === 'string' && (TABLES as readonly string[]).includes(hint.table)
        ? (hint.table as TableName)
        : base?.table ?? null;

    const links: ColumnLink[] = [];
    const unknown: string[] = [];
    const refs = new Set<string>();

    for (const column of sheet.columns) {
      const aiField = hint?.columns?.[column];
      const aiOk = table && typeof aiField === 'string' && allowedField(table, aiField);
      if (aiOk && table) {
        const def = fieldDef(table, aiField);
        links.push({
          from: column,
          to: aiField,
          label: def?.label ?? columnTypesOf(table).get(aiField) ?? aiField,
          via: 'ИИ',
        });
        if (def?.virtual && REF_LABELS[def.virtual]) refs.add(REF_LABELS[def.virtual]);
        continue;
      }
      const local = table ? bestField(table, column) : null;
      if (local) {
        links.push({ from: column, to: local.field.name, label: local.field.label, via: 'словарь' });
        if (local.field.virtual && REF_LABELS[local.field.virtual]) refs.add(REF_LABELS[local.field.virtual]);
      } else {
        unknown.push(column);
      }
    }

    sheetsPlan.push({
      source: sheet.source,
      table,
      tableTitle: table ? TABLE_TITLES[table] : '',
      confidence: typeof hint?.confidence === 'number' ? hint.confidence : base?.confidence ?? 0,
      via: table && hint?.table ? 'ИИ' : base?.via ?? 'колонки',
      rows: sheet.rows.length,
      links,
      unknown,
      refs: [...refs],
    });
  }

  const aiAdvice = Array.isArray(parsed.advice)
    ? parsed.advice.filter((a): a is string => typeof a === 'string' && a.trim() !== '')
    : [];

  return {
    sheets: sheetsPlan,
    advice: dedupe([...plan.advice, ...aiAdvice]),
    aiUsed: true,
    aiNote: 'План уточнён моделью.',
  };
}

/* ------------------------------------------------------------------ */
/* Перенос данных                                                     */
/* ------------------------------------------------------------------ */

export interface ApplyResult {
  /** Сколько записей добавлено по таблицам */
  inserted: Record<string, number>;
  /** Сколько справочных записей создано */
  created: Record<string, number>;
  skipped: number;
  total: number;
  message: string;
}

const ENUMS: Record<string, Record<string, string>> = {
  'vehicles.kind': { tractor: 'tractor', тягач: 'tractor', trailer: 'trailer', прицеп: 'trailer' },
  'waybills.status': { open: 'open', открыт: 'open', closed: 'closed', закрыт: 'closed' },
  'trips.status': {
    planned: 'planned',
    план: 'planned',
    запланирован: 'planned',
    done: 'done',
    выполнен: 'done',
    готово: 'done',
    charged: 'charged',
    начислен: 'charged',
  },
  'trip_points.kind': { load: 'load', погрузка: 'load', загрузка: 'load', unload: 'unload', выгрузка: 'unload' },
  'trip_points.status': { planned: 'planned', план: 'planned', done: 'done', выполнен: 'done', готово: 'done' },
  'refuelings.kind': {
    barrel: 'barrel',
    бочка: 'barrel',
    канистра: 'barrel',
    station: 'station',
    азс: 'station',
    заправка: 'station',
  },
  'finance_ops.kind': {
    charge: 'charge',
    начислено: 'charge',
    начисление: 'charge',
    долг: 'charge',
    payment: 'payment',
    поступило: 'payment',
    оплата: 'payment',
    приход: 'payment',
  },
  'places.load_type': { rear: 'rear', зад: 'rear', задняя: 'rear', side: 'side', бок: 'side', боковая: 'side', top: 'top', верх: 'top', верхняя: 'top' },
};

function matchEnum(map: Record<string, string>, raw: string): string | null {
  const key = normalizeHeader(raw);
  if (map[key]) return map[key];
  for (const [k, v] of Object.entries(map)) if (key.startsWith(k) || k.startsWith(key)) return v;
  return null;
}

/** «12.03.2026», «2026-03-12», «12/03/26» и число Excel → 2026-03-12 */
export function parseDateValue(raw: string): string {
  const s = raw.trim();
  if (s === '') return '';
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const dot = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (dot) {
    const year = dot[3].length === 2 ? `20${dot[3]}` : dot[3];
    return `${year}-${dot[2].padStart(2, '0')}-${dot[1].padStart(2, '0')}`;
  }
  const serial = toNumber(s);
  if (serial !== null && serial > 20000 && serial < 80000) {
    return new Date(Date.UTC(1899, 11, 30) + serial * 86400000).toISOString().slice(0, 10);
  }
  return s;
}

const MONTHS = [
  'январ',
  'феврал',
  'март',
  'апрел',
  'май',
  'июн',
  'июл',
  'август',
  'сентябр',
  'октябр',
  'ноябр',
  'декабр',
];

/** «Ноябрь 2026», «11.2026», «2026-11» → 2026-11 */
export function parseMonthValue(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (s === '') return '';
  const iso = s.match(/^(\d{4})-(\d{1,2})$/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}`;
  const dot = s.match(/^(\d{1,2})[./](\d{4})$/);
  if (dot) return `${dot[2]}-${dot[1].padStart(2, '0')}`;
  for (let i = 0; i < MONTHS.length; i++) {
    if (s.includes(MONTHS[i])) {
      const year = s.match(/(\d{4})/);
      if (year) return `${year[1]}-${String(i + 1).padStart(2, '0')}`;
    }
  }
  return s;
}

/** Справочники: находим по названию или создаём */
class RefBook {
  private maps = new Map<string, Map<string, string>>();
  readonly created: Record<string, number> = {};

  constructor() {
    for (const table of ['places', 'companies', 'cargo_types', 'fuel_stations', 'vehicles', 'waybills'] as const) {
      const map = new Map<string, string>();
      for (const row of dbSync().all<{ id: string; name?: string; number?: string }>(
        `SELECT * FROM ${table} WHERE deleted = 0`,
      )) {
        for (const key of [row.name, row.number]) {
          const norm = normalizeHeader(key ?? '');
          if (norm) map.set(norm, row.id);
        }
      }
      this.maps.set(table, map);
      this.created[table] = 0;
    }
  }

  private lookup(table: string, key: string): string | undefined {
    return this.maps.get(table)?.get(key);
  }

  private remember(table: string, key: string, id: string): void {
    this.maps.get(table)?.set(key, id);
  }

  /** Найти или создать запись справочника по названию */
  ref(table: 'places' | 'companies' | 'cargo_types' | 'fuel_stations' | 'vehicles', name: string): string | null {
    const key = normalizeHeader(name);
    if (!key) return null;
    const found = this.lookup(table, key);
    if (found) return found;
    const extra: Record<string, unknown> = {};
    if (table === 'vehicles') extra.kind = 'tractor';
    const id = insertRow(table, { name: name.trim(), ...extra });
    this.remember(table, key, id);
    this.created[table] += 1;
    return id;
  }

  /** Путевой лист по номеру, иначе — открытый лист или новый на эту дату */
  waybill(number: string, date: string): string {
    const key = normalizeHeader(number);
    if (key) {
      const found = this.lookup('waybills', key);
      if (found) return found;
    } else {
      const open = dbSync().one<{ id: string }>(
        "SELECT id FROM waybills WHERE deleted = 0 AND status = 'open' ORDER BY date_out DESC LIMIT 1",
      );
      if (open) return open.id;
    }
    const id = insertRow('waybills', {
      number: number.trim(),
      date_out: date || '',
      status: 'open',
    });
    if (key) this.remember('waybills', key, id);
    this.created.waybills += 1;
    return id;
  }
}

interface PreparedRow {
  row: Record<string, unknown>;
  virtuals: Map<string, string>;
}

/** Собрать строку для базы из строки архива по плану */
function prepareRow(table: TableName, plan: SheetPlan, raw: Record<string, string>): PreparedRow {
  const types = columnTypesOf(table);
  const row: Record<string, unknown> = {};
  const virtuals = new Map<string, string>();

  for (const link of plan.links) {
    const value = (raw[link.from] ?? '').trim();
    if (value === '') continue;
    const def = fieldDef(table, link.to);
    if (def?.virtual) {
      virtuals.set(link.to, value);
      continue;
    }
    if (!types.has(link.to)) continue;
    const enumMap = ENUMS[`${table}.${link.to}`];
    if (enumMap) {
      const mapped = matchEnum(enumMap, value);
      if (mapped) row[link.to] = mapped;
      continue;
    }
    if (link.to === 'pay_month') {
      row[link.to] = parseMonthValue(value);
      continue;
    }
    if (link.to.startsWith('date') || link.to.endsWith('_date')) {
      row[link.to] = parseDateValue(value);
      continue;
    }
    row[link.to] = value;
  }

  return { row: cleanCsvRow(table, stringify(row)), virtuals };
}

function stringify(row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) out[k] = v === null || v === undefined ? '' : String(v);
  return out;
}

/** Перенести данные по готовому плану */
export function applyPlan(sheets: ArchiveSheet[], plan: ImportPlan): ApplyResult {
  const books = new RefBook();
  const inserted: Record<string, number> = {};
  const skipped: number[] = [];
  let total = 0;

  for (const sheetPlan of plan.sheets) {
    if (!sheetPlan.table) continue;
    const table = sheetPlan.table;
    const sheet = sheets.find((s) => s.source === sheetPlan.source);
    if (!sheet) continue;

    for (const raw of sheet.rows) {
      try {
        const { row, virtuals } = prepareRow(table, sheetPlan, raw);
        total++;
        switch (table) {
          case 'trips':
            insertTrip(row, virtuals, books);
            break;
          case 'refuelings': {
            const station = virtuals.get('station_name');
            if (station) row.station_id = books.ref('fuel_stations', station);
            const number = virtuals.get('waybill_number');
            if (number) row.waybill_id = books.waybill(number, '');
            insertRow(table, row);
            break;
          }
          case 'places': {
            const company = virtuals.get('company_name');
            if (company) row.company_id = books.ref('companies', company);
            insertRow(table, row);
            break;
          }
          case 'waybills': {
            const vehicle = virtuals.get('vehicle_name');
            if (vehicle) row.vehicle_id = books.ref('vehicles', vehicle);
            insertRow(table, row);
            break;
          }
          case 'trip_points': {
            const place = virtuals.get('place_name');
            if (place) row.place_id = books.ref('places', place);
            const cargo = virtuals.get('cargo_name');
            if (cargo) row.cargo_type_id = books.ref('cargo_types', cargo);
            insertRow(table, row);
            break;
          }
          default: {
            const cargo = virtuals.get('cargo_name');
            if (cargo) row.cargo_type_id = books.ref('cargo_types', cargo);
            insertRow(table, row);
          }
        }
        inserted[table] = (inserted[table] ?? 0) + 1;
      } catch {
        skipped.push(1);
      }
    }
  }

  const added = Object.values(inserted).reduce((a, b) => a + b, 0);
  const refs = Object.entries(books.created).filter(([, n]) => n > 0);
  const parts = [`перенесено записей: ${added}`];
  if (refs.length > 0) parts.push(refs.map(([t, n]) => `${TABLE_TITLES[t as TableName] ?? t} +${n}`).join(', '));
  if (skipped.length > 0) parts.push(`пропущено строк: ${skipped.length}`);

  return { inserted, created: books.created, skipped: skipped.length, total, message: parts.join(' · ') };
}

/** Перевозка: заводим лист и точки загрузки/выгрузки по названиям */
function insertTrip(row: Record<string, unknown>, virtuals: Map<string, string>, books: RefBook): void {
  const date = virtuals.get('date') ?? '';
  const cargo = virtuals.get('cargo_name');
  if (cargo) row.cargo_type_id = books.ref('cargo_types', cargo);
  row.waybill_id = books.waybill(virtuals.get('waybill_number') ?? '', date ? parseDateValue(date) : '');
  const tripId = insertRow('trips', row);

  const from = virtuals.get('place_from');
  const to = virtuals.get('place_to');
  const day = date ? parseDateValue(date) : '';
  if (from) {
    insertRow('trip_points', {
      trip_id: tripId,
      seq: 1,
      kind: 'load',
      place_id: books.ref('places', from),
      plan_date: day,
      fact_date: day,
      status: 'done',
    });
  }
  if (to) {
    insertRow('trip_points', {
      trip_id: tripId,
      seq: from ? 2 : 1,
      kind: 'unload',
      place_id: books.ref('places', to),
      plan_date: day,
      fact_date: day,
      status: 'done',
    });
  }
}

/* ------------------------------------------------------------------ */
/* Итог для экрана                                                    */
/* ------------------------------------------------------------------ */

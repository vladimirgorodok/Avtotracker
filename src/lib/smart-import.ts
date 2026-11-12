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
import { insertRow, updateRow } from '../db/repo';
import { TABLES, type TableName } from '../types';
import { cleanCsvRow, columnTypesOf, decodeText, parseCsv, toNumber, TABLE_TITLES } from './backup';
import { monthKey, toIsoDate } from './format';
import { refreshTripStatus } from './actions';
import { askModel, readAiConfig } from './ai';

/* ------------------------------------------------------------------ */
/* Описание полей базы                                                */
/* ------------------------------------------------------------------ */

/** Куда попадает «умное» поле, которого в базе нет как колонки */
export type VirtualKind =
  | 'place'
  | 'company'
  | 'cargo'
  | 'station'
  | 'vehicle'
  | 'waybill'
  | 'date'
  | 'coords';

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
  // У полей-посредников (cargo_name, place_name, station_name) своё имя в базу не
  // попадает, и как подсказка оно вредно: из-за него колонка «name» из чужого
  // архива притягивалась к грузу, месту или АЗС.
  hints: virtual ? hints : [name, ...hints],
  virtual,
});

const NOTE: string[] = ['примечание', 'комментарий', 'заметка', 'note', 'comment', 'описание', 'description'];
const NAME: string[] = ['название', 'имя', 'name', 'title', 'наименование'];

/** Синонимы колонок по таблицам — основа распознавания без ИИ */
export const FIELDS: Record<TableName, FieldDef[]> = {
  vehicles: [
    f('name', 'Название', NAME),
    f('plate', 'Госномер', ['госномер', 'номерной знак', 'рег знак', 'номер тс', 'plate', 'reg number']),
    f('kind', 'Тип (тягач/прицеп)', ['тип', 'вид', 'категория', 'kind', 'type', 'vehicle type']),
    f('brand', 'Марка', ['марка', 'производитель', 'brand', 'make']),
    f('model', 'Модель', ['модель', 'model']),
    f('vin', 'VIN', ['vin', 'вин']),
    f('year', 'Год выпуска', ['год выпуска', 'год', 'year']),
    f('fuel_norm', 'Норма расхода', ['норма расхода', 'расход', 'л/100', 'fuel norm', 'fuel consumption']),
    f('note', 'Примечание', NOTE),
    f('archived', 'В архиве', ['архив', 'archived']),
  ],
  vehicle_periods: [
    f('vehicle_id', 'Автомобиль', ['автомобиль', 'машина', 'vehicle']),
    f('start_date', 'Начало', ['начало', 'дата начала', 'start', 'start date', 'from date', 'period start']),
    f('end_date', 'Окончание', ['окончание', 'дата окончания', 'end', 'end date', 'to date', 'period end']),
    f('note', 'Примечание', NOTE),
  ],
  vehicle_links: [
    f('tractor_id', 'Тягач', ['тягач', 'tractor']),
    f('trailer_id', 'Прицеп', ['прицеп', 'trailer']),
    f('start_date', 'Начало', ['начало', 'дата начала', 'start', 'start date']),
    f('end_date', 'Окончание', ['окончание', 'дата окончания', 'end', 'end date']),
  ],
  companies: [f('name', 'Название', NAME), f('note', 'Примечание', NOTE)],
  cargo_types: [f('name', 'Название', NAME), f('note', 'Примечание', NOTE)],
  fuel_stations: [f('name', 'Название', NAME), f('note', 'Примечание', NOTE)],
  places: [
    f('name', 'Название', NAME),
    f('address', 'Адрес', ['адрес', 'address', 'местоположение', 'location']),
    f('coordinates', 'Координаты', ['координаты', 'coordinates', 'coords', 'геопозиция', 'geo'], 'coords'),
    f('lat', 'Широта', ['широта', 'lat', 'latitude']),
    f('lon', 'Долгота', ['долгота', 'lon', 'lng', 'longitude']),
    f('contact', 'Контакт', ['контакт', 'телефон', 'contact', 'phone', 'тел']),
    f('load_type', 'Тип загрузки', ['тип загрузки', 'загрузка', 'load type', 'loading type']),
    f('note', 'Примечание', NOTE),
    f('company_name', 'Фирма', ['фирма', 'компания', 'организация', 'заказчик', 'company'], 'company'),
    f('cargo_name', 'Груз', ['груз', 'cargo'], 'cargo'),
  ],
  waybills: [
    f('number', 'Номер листа', ['номер листа', 'номер путевого листа', 'номер', '№', 'number']),
    f('name', 'Название', NAME),
    f('date_out', 'Дата выезда', [
      'дата выезда',
      'выезд',
      'дата выхода',
      'date out',
      'дата начала',
      'departure date',
      'departure',
      'start date',
    ]),
    f('odometer_out', 'Одометр на выезде', ['одометр выезд', 'одометр на выезде', 'пробег выезд', 'odometer out']),
    f('fuel_out', 'Топливо на выезде', ['топливо выезд', 'дт выезд', 'бак выезд', 'fuel out']),
    f('date_in', 'Дата приезда', [
      'дата приезда',
      'приезд',
      'дата возврата',
      'date in',
      'return date',
      'arrival date',
      'return',
    ]),
    f('odometer_in', 'Одометр на приезде', ['одометр приезд', 'одометр на приезде', 'пробег приезд', 'odometer in']),
    f('fuel_in', 'Топливо на приезде', ['топливо приезд', 'дт приезд', 'бак приезд', 'fuel in']),
    f('note', 'Примечание', NOTE),
    f('status', 'Статус', ['статус', 'status']),
    f('vehicle_name', 'Автомобиль', ['автомобиль', 'машина', 'тягач', 'госномер', 'vehicle'], 'vehicle'),
  ],
  trips: [
    f('weight', 'Вес', ['вес', 'масса', 'тоннаж', 'weight', 'масса груза']),
    f('amount', 'Начислено', ['начислено', 'сумма', 'стоимость', 'amount', 'price', 'оплата', 'accrual', 'charge']),
    f('note', 'Примечание', NOTE),
    f('status', 'Статус', ['статус', 'status']),
    f('date', 'Дата перевозки', ['дата перевозки', 'дата', 'дата рейса', 'date'], 'date'),
    f('waybill_number', 'Номер путевого листа', ['путевой лист', 'номер листа', 'лист', 'waybill'], 'waybill'),
    f('place_from', 'Место загрузки', ['откуда', 'загрузка', 'место загрузки', 'погрузка', 'from'], 'place'),
    f('place_to', 'Место выгрузки', ['куда', 'выгрузка', 'место выгрузки', 'разгрузка', 'to'], 'place'),
    f('cargo_name', 'Груз', ['груз', 'наименование груза', 'номенклатура', 'cargo'], 'cargo'),
  ],
  trip_points: [
    f('seq', 'Порядок', ['порядок', 'номер по порядку', 'seq', '№', 'order', 'index', 'номер']),
    f('kind', 'Тип точки', ['тип точки', 'вид', 'операция', 'kind', 'direction', 'направление']),
    f('plan_date', 'Плановая дата', ['плановая дата', 'план', 'plan date', 'planned date', 'дата']),
    f('fact_date', 'Фактическая дата', [
      'фактическая дата',
      'факт',
      'fact date',
      'arrived',
      'actual',
      'arrived at',
      'фактическая',
    ]),
    f('load_type', 'Тип загрузки', ['тип загрузки', 'загрузка', 'load type', 'loading type']),
    f('weight', 'Вес', ['вес', 'масса', 'weight']),
    f('status', 'Статус', ['статус', 'status']),
    f('note', 'Примечание', NOTE),
    f('place_name', 'Место', ['место', 'точка', 'адрес', 'place'], 'place'),
    f('cargo_name', 'Груз', ['груз', 'cargo'], 'cargo'),
  ],
  refuelings: [
    f('date', 'Дата', ['дата', 'date', 'date time', 'datetime']),
    f('volume', 'Количество, л', [
      'количество',
      'литры',
      'объем',
      'объём',
      'л',
      'volume',
      'liters',
      'количество литров',
    ]),
    f('kind', 'Тип заправки', ['тип', 'способ', 'источник', 'kind', 'source', 'type']),
    f('note', 'Примечание', NOTE),
    f('station_name', 'АЗС', ['азс', 'заправка', 'станция', 'station'], 'station'),
    f('waybill_number', 'Номер путевого листа', ['путевой лист', 'номер листа', 'лист', 'waybill'], 'waybill'),
  ],
  finance_ops: [
    f('date', 'Дата', ['дата', 'date']),
    f('kind', 'Тип операции', ['тип', 'вид операции', 'операция', 'kind', 'type']),
    f('amount', 'Сумма', ['сумма', 'начислено', 'оплата', 'amount', 'money', 'accrual']),
    f('pay_month', 'Месяц оплаты', ['месяц оплаты', 'месяц', 'период', 'pay month', 'month']),
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
  vehicles: ['автомобили', 'машины', 'транспорт', 'автопарк', 'тягачи', 'прицепы', 'vehicles', 'vehicle'],
  vehicle_periods: ['периоды автомобилей', 'периоды', 'период', 'periods', 'vehicle periods'],
  vehicle_links: ['связки', 'тягач прицеп', 'links', 'vehicle links'],
  companies: ['фирмы', 'компании', 'организации', 'заказчики', 'контрагенты', 'companies', 'company'],
  cargo_types: ['грузы', 'номенклатура', 'cargo', 'cargos', 'cargo types'],
  fuel_stations: ['азс', 'заправки список', 'сети заправок', 'fuel stations', 'gas stations', 'станции'],
  places: ['места', 'адреса', 'точки', 'пункты', 'places', 'place', 'locations'],
  waybills: ['путевые листы', 'путевки', 'листы', 'waybills', 'waybill'],
  trips: ['перевозки', 'рейсы', 'поездки', 'заявки', 'trips', 'trip'],
  trip_points: ['точки маршрута', 'маршрут', 'точки', 'route points', 'stops', 'stop', 'остановки'],
  refuelings: ['заправки', 'топливо', 'заливки', 'refuelings', 'fuels', 'fuel'],
  finance_ops: ['финансы', 'оплаты', 'платежи', 'начисления', 'деньги', 'finance', 'finances', 'payments'],
  attachments: ['документы', 'файлы', 'сканы', 'attachments'],
};

/**
 * Колонки-ссылки: «waybillId», «vehicleId», «placeId» и подобные ведут на другую
 * таблицу. В чужом архиве это старый идентификатор, поэтому переносим его в новый.
 */
const ID_LINK_TABLES: Record<string, TableName> = {
  vehicle: 'vehicles',
  tractor: 'vehicles',
  trailer: 'vehicles',
  period: 'vehicle_periods',
  company: 'companies',
  cargo: 'cargo_types',
  station: 'fuel_stations',
  'gas station': 'fuel_stations',
  place: 'places',
  waybill: 'waybills',
  trip: 'trips',
};

/** Какая колонка базы принимает ссылку в каждой таблице */
const ID_LINK_COLUMNS: Partial<Record<TableName, Record<string, string>>> = {
  vehicle_periods: { vehicle: 'vehicle_id' },
  vehicle_links: { tractor: 'tractor_id', vehicle: 'tractor_id', trailer: 'trailer_id' },
  companies: { cargo: 'cargo_type_id' },
  places: { company: 'company_id', cargo: 'cargo_type_id' },
  waybills: { vehicle: 'vehicle_id', tractor: 'vehicle_id', trailer: 'trailer_id' },
  trips: { waybill: 'waybill_id', cargo: 'cargo_type_id' },
  trip_points: { trip: 'trip_id', place: 'place_id', cargo: 'cargo_type_id' },
  refuelings: { waybill: 'waybill_id', station: 'station_id', 'gas station': 'station_id' },
  finance_ops: { trip: 'trip_id', waybill: 'waybill_id' },
};

/** Без этих ссылок запись не вставится — NOT NULL без значения по умолчанию */
const REQUIRED_LINKS = new Set([
  'vehicle_periods.vehicle_id',
  'vehicle_links.tractor_id',
  'vehicle_links.trailer_id',
  'trips.waybill_id',
]);

/** Порядок переноса: сначала справочники, потом документы, которые на них ссылаются */
const IMPORT_ORDER: TableName[] = [
  'vehicles',
  'cargo_types',
  'companies',
  'fuel_stations',
  'places',
  'vehicle_periods',
  'vehicle_links',
  'waybills',
  'trips',
  'trip_points',
  'refuelings',
  'finance_ops',
  'attachments',
];

/** Колонка со своим идентификатором записи */
export function ownIdColumn(column: string): boolean {
  const n = normalizeHeader(column);
  return n === 'id' || n === 'guid' || n === 'uuid' || n === 'ключ';
}

/** Колонка ведёт на другую таблицу? Возвращает таблицу и колонку базы */
export function idLinkOf(table: TableName, column: string): { target: TableName; column: string } | null {
  const n = normalizeHeader(column);
  if (ownIdColumn(column)) return null;
  if (!n.endsWith(' id')) return null;
  const prefix = n.slice(0, -3).trim();
  const key = linkKey(prefix);
  if (!key) return null;
  const target = ID_LINK_TABLES[key];
  if (!target || target === table) return null;
  const local = ID_LINK_COLUMNS[table]?.[key];
  if (!local) return null;
  return { target, column: local };
}

/** «typical cargo» → «cargo»: в чужих архивах бывают уточняющие приставки */
function linkKey(prefix: string): string | null {
  if (ID_LINK_TABLES[prefix]) return prefix;
  for (const key of Object.keys(ID_LINK_TABLES)) {
    if (prefix.endsWith(` ${key}`)) return key;
  }
  return null;
}

/** Колонка — чужой идентификатор: «waybillId», «guid», «user_id» */
export function isIdColumn(column: string): boolean {
  return ownIdColumn(column) || normalizeHeader(column).endsWith(' id');
}

/** Служебные колонки чужого архива: ссылки на логотипы, служебные даты и т. п. */
export function isServiceColumn(column: string): boolean {
  const n = normalizeHeader(column);
  if (ownIdColumn(column)) return true;
  return /(^| )(logo|created|updated|deleted|uuid|guid|sort|order id|external id|old id|hash|version|unknown)( |$)/.test(
    n,
  );
}

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
    // camelCase и PascalCase разбиваем на слова: departureDate → departure date
    .replace(/([a-zа-я0-9])([A-ZА-Я])/g, '$1 $2')
    .replace(/([A-ZА-Я]+)([A-ZА-Я][a-zа-я])/g, '$1 $2')
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

/**
 * Насколько колонка характерна именно для этой таблицы.
 * «Дата», «Название», «Тип» есть почти везде — такие колонки почти не считаем,
 * иначе перевозки легко принять за автомобили.
 */
function columnScore(table: TableName, column: string): number {
  const mine = bestField(table, column)?.score ?? 0;
  if (mine === 0) return 0;
  let other = 0;
  for (const t of TABLES) {
    if (t === table) continue;
    other = Math.max(other, bestField(t, column)?.score ?? 0);
  }
  if (mine > other + 0.001) return mine;
  if (mine >= other - 0.001) return mine * 0.5;
  return 0;
}

/** Доля «своих» колонок у таблицы */
export function columnFit(table: TableName, columns: string[]): number {
  if (columns.length === 0) return 0;
  let sum = 0;
  for (const c of columns) sum += columnScore(table, c);
  return sum / columns.length;
}

export interface TableGuess {
  table: TableName | null;
  via: 'имя' | 'колонки';
  confidence: number;
}

/** Имя файла без расширения, без служебного номера в начале: «07-trips» → «trips» */
export function sourceBaseName(source: string): string {
  return source
    .replace(/\.(csv|xlsx?|json|txt)$/i, '')
    .replace(/^\s*\d+\s*[-_. )]*/, '')
    .trim();
}

export function detectTable(sheet: ArchiveSheet): TableGuess {
  const name = sourceBaseName(sheet.source);
  let byName: { table: TableName; score: number } | null = null;
  for (const table of TABLES) {
    const score = Math.max(0, ...TABLE_HINTS[table].map((h) => scoreHint(name, h)));
    if (score > 0 && (!byName || score > byName.score)) byName = { table, score };
  }

  const ranked = TABLES.map((table) => ({ table, score: columnFit(table, sheet.columns) })).sort(
    (a, b) => b.score - a.score,
  );
  const top = ranked[0] ?? { table: null as unknown as TableName, score: 0 };
  const runnerUp = ranked[1]?.score ?? 0;

  // Имя файла надёжнее колонок
  if (byName && byName.score >= 0.7) {
    return {
      table: byName.table,
      via: 'имя',
      confidence: Math.min(1, byName.score * 0.7 + top.score * 0.3),
    };
  }
  // По колонкам — только если таблица явно впереди остальных
  if (top.score >= 0.5 && (top.score >= 0.8 || top.score - runnerUp >= 0.15)) {
    return { table: top.table, via: 'колонки', confidence: Math.min(1, top.score) };
  }
  return { table: null, via: 'колонки', confidence: 0 };
}

/* ------------------------------------------------------------------ */
/* План переноса                                                      */
/* ------------------------------------------------------------------ */

export interface ColumnLink {
  from: string;
  to: string;
  label: string;
  via: 'словарь' | 'ИИ';
  /** Колонка ведёт на другую таблицу по старому идентификатору */
  fk?: { target: TableName; column: string };
}

export interface SheetPlan {
  source: string;
  table: TableName | null;
  tableTitle: string;
  confidence: number;
  via: 'имя' | 'колонки' | 'ИИ';
  rows: number;
  links: ColumnLink[];
  /** Колонка со старым идентификатором записи */
  idColumn: string | null;
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
  coords: '',
};

export function fieldDef(table: TableName, name: string): FieldDef | undefined {
  return FIELDS[table].find((x) => x.name === name);
}

interface LinksResult {
  links: ColumnLink[];
  unknown: string[];
  refs: string[];
  idColumn: string | null;
}

/** Разобрать колонки листа: поля базы, ссылки по id и то, что не пригодилось */
function buildLinks(
  table: TableName | null,
  columns: string[],
  aiFields: Record<string, string> = {},
): LinksResult {
  const links: ColumnLink[] = [];
  const unknown: string[] = [];
  const refs = new Set<string>();
  let idColumn: string | null = null;

  for (const column of columns) {
    if (ownIdColumn(column)) {
      if (!idColumn) idColumn = column;
      continue;
    }
    if (isServiceColumn(column)) continue;
    if (isIdColumn(column)) {
      // Чужой идентификатор: переносим только как ссылку на другую таблицу
      const fk = table ? idLinkOf(table, column) : null;
      if (fk) {
        links.push({
          from: column,
          to: fk.column,
          label: `${TABLE_TITLES[fk.target]} (по старому id)`,
          via: 'словарь',
          fk,
        });
      }
      continue;
    }
    if (!table) {
      unknown.push(column);
      continue;
    }
    const aiName = aiFields[column];
    if (aiName && allowedField(table, aiName)) {
      const def = fieldDef(table, aiName);
      links.push({
        from: column,
        to: aiName,
        label: def?.label ?? columnTypesOf(table).get(aiName) ?? aiName,
        via: 'ИИ',
      });
      if (def?.virtual && REF_LABELS[def.virtual]) refs.add(REF_LABELS[def.virtual]);
      continue;
    }
    const match = bestField(table, column);
    if (match) {
      links.push({ from: column, to: match.field.name, label: match.field.label, via: 'словарь' });
      if (match.field.virtual && REF_LABELS[match.field.virtual]) refs.add(REF_LABELS[match.field.virtual]);
      continue;
    }
    unknown.push(column);
  }

  return { links, unknown, refs: [...refs], idColumn };
}

export function buildPlan(sheets: ArchiveSheet[]): ImportPlan {
  const plans: SheetPlan[] = [];
  const advice: string[] = [];

  for (const sheet of sheets) {
    const guess = detectTable(sheet);
    const built = buildLinks(guess.table, sheet.columns);

    plans.push({
      source: sheet.source,
      table: guess.table,
      tableTitle: guess.table ? TABLE_TITLES[guess.table] : '',
      confidence: guess.confidence,
      via: guess.via,
      rows: sheet.rows.length,
      links: built.links,
      idColumn: built.idColumn,
      unknown: built.unknown,
      refs: built.refs,
    });

    if (!guess.table) {
      advice.push(
        `Файл «${sheet.source}» не похож ни на одну таблицу АвтоБазы. Колонки: ${sheet.columns
          .slice(0, 12)
          .join(', ')}. Если эти данные нужны — для них стоит завести новую таблицу.`,
      );
    } else if (built.unknown.length > 0) {
      advice.push(
        `Файл «${sheet.source}» (${TABLE_TITLES[guess.table]}): не нашлось места для колонок ${built.unknown
          .map((c) => `«${c}»`)
          .join(', ')}. Если они нужны — добавьте такие поля в базу.`,
      );
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

    const columnHints: Record<string, string> = {};
    for (const [column, field] of Object.entries(hint?.columns ?? {})) {
      if (typeof field === 'string') columnHints[column] = field;
    }
    const built = buildLinks(table, sheet.columns, columnHints);

    sheetsPlan.push({
      source: sheet.source,
      table,
      tableTitle: table ? TABLE_TITLES[table] : '',
      confidence: typeof hint?.confidence === 'number' ? hint.confidence : base?.confidence ?? 0,
      via: table && hint?.table ? 'ИИ' : base?.via ?? 'колонки',
      rows: sheet.rows.length,
      links: built.links,
      idColumn: built.idColumn,
      unknown: built.unknown,
      refs: built.refs,
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
  /** Идентификаторы добавленных записей — чтобы перенос можно было отменить */
  ids: Record<string, string[]>;
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
    оплачено: 'payment',
    заплачено: 'payment',
    поступление: 'payment',
    зачислено: 'payment',
    приход: 'payment',
    paid: 'payment',
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
  // Момент времени с зоной («2026-11-10T21:00:00.000Z») — это местная полночь,
  // записанная в UTC. Переводим в местную дату устройства, иначе день уезжает назад.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s) && /(z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return toIsoDate(d);
  }
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
  if (/^\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}/.test(s) && /(z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return monthKey(toIsoDate(d));
  }
  const iso = s.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
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
  /** Идентификаторы созданных справочных записей */
  readonly createdIds: Record<string, string[]> = {};

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
      this.createdIds[table] = [];
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
    this.createdIds[table].push(id);
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
    this.createdIds.waybills.push(id);
    return id;
  }

  /** Запомнить перенесённую запись справочника, чтобы искать её по названию */
  keep(table: string, row: Record<string, unknown>, id: string): void {
    if (!this.maps.has(table)) return;
    const key = normalizeHeader(String(row.name ?? ''));
    if (key) this.remember(table, key, id);
  }
}

/** Справочники не должны дублироваться: помним уже занятые названия */
class RefGuard {
  private seen = new Map<string, Map<string, string>>();

  constructor() {
    this.scan('vehicles', 'id, name, plate');
    this.scan('companies', 'id, name');
    this.scan('cargo_types', 'id, name');
    this.scan('fuel_stations', 'id, name');
    this.scan('places', 'id, name, address');
  }

  private scan(table: string, columns: string): void {
    const keys = columns.split(',').map((c) => c.trim());
    const rows = dbSync().all<Record<string, unknown>>(`SELECT ${columns} FROM ${table} WHERE deleted = 0`);
    const map = new Map<string, string>();
    for (const row of rows) {
      const key = keys
        .filter((c) => c !== 'id')
        .map((c) => normalizeHeader(String(row[c] ?? '')))
        .join('|');
      if (key.replace(/\|/g, '') !== '') map.set(key, String(row.id));
    }
    this.seen.set(table, map);
  }

  /** Ключ записи: у мест — название с адресом, у машин — ещё и госномер */
  private key(table: TableName, row: Record<string, unknown>): string | null {
    if (!['vehicles', 'companies', 'cargo_types', 'fuel_stations', 'places'].includes(table)) return null;
    const name = normalizeHeader(String(row.name ?? ''));
    if (!name) return null;
    if (table === 'vehicles') return `${name}|${normalizeHeader(String(row.plate ?? ''))}`;
    if (table === 'places') return `${name}|${normalizeHeader(String(row.address ?? ''))}`;
    return name;
  }

  /** Запись с таким же названием уже есть — вернём её id */
  find(table: TableName, row: Record<string, unknown>): string | null {
    const key = this.key(table, row);
    if (key === null) return null;
    return this.seen.get(table)?.get(key) ?? null;
  }

  remember(table: TableName, row: Record<string, unknown>, id: string): void {
    const key = this.key(table, row);
    if (key === null) return;
    if (!this.seen.has(table)) this.seen.set(table, new Map());
    this.seen.get(table)?.set(key, id);
  }
}

interface PreparedRow {
  row: Record<string, unknown>;
  virtuals: Map<string, string>;
  /** Ссылки на другие таблицы — разрешаются при переносе, когда известны новые id */
  fks: { column: string; target: TableName; oldId: string }[];
}

/** Собрать строку для базы из строки архива по плану */
function prepareRow(table: TableName, plan: SheetPlan, raw: Record<string, string>): PreparedRow {
  const types = columnTypesOf(table);
  const row: Record<string, unknown> = {};
  const virtuals = new Map<string, string>();
  const fks: PreparedRow['fks'] = [];

  for (const link of plan.links) {
    const value = (raw[link.from] ?? '').trim();
    if (value === '') continue;
    if (link.fk) {
      fks.push({ column: link.fk.column, target: link.fk.target, oldId: value });
      continue;
    }
    const def = fieldDef(table, link.to);
    if (def?.virtual === 'coords') {
      // «55.7558, 37.6173» → широта и долгота
      if (!types.has('lat') || !types.has('lon')) continue;
      const nums = value
        .split(/[;\s]+/)
        .join(' ')
        .split(/[,\s]+/)
        .map((x) => toNumber(x))
        .filter((x): x is number => x !== null);
      if (nums.length >= 1) row.lat = nums[0];
      if (nums.length >= 2) row.lon = nums[1];
      continue;
    }
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

  return { row: cleanCsvRow(table, stringify(row)), virtuals, fks };
}

function stringify(row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) out[k] = v === null || v === undefined ? '' : String(v);
  return out;
}

/** Перенести данные по готовому плану */
export function applyPlan(sheets: ArchiveSheet[], plan: ImportPlan): ApplyResult {
  const books = new RefBook();
  const guard = new RefGuard();
  const inserted: Record<string, number> = {};
  const ids: Record<string, string[]> = {};
  const track = (table: string, id: string) => {
    (ids[table] ??= []).push(id);
  };
  const skipped: number[] = [];
  let total = 0;
  /** Записи справочников, которые уже были в базе — не дублируем их */
  let repeats = 0;
  /** Сколько ссылок между таблицами удалось восстановить */
  let linked = 0;

  /** Старый идентификатор из архива → новый идентификатор в базе */
  const idMaps = new Map<TableName, Map<string, string>>();
  const mapOldId = (target: TableName, oldId: string): string | null =>
    idMaps.get(target)?.get(oldId) ?? null;
  /** Ссылки, которые пока не нашли адресата — поправим вторым проходом */
  const pending: { table: TableName; id: string; column: string; target: TableName; oldId: string }[] = [];

  // Сначала справочники, потом записи, которые на них ссылаются
  const order = new Map(IMPORT_ORDER.map((t, i) => [t, i]));
  const ordered = [...plan.sheets].sort(
    (a, b) => (a.table ? order.get(a.table) ?? 99 : 99) - (b.table ? order.get(b.table) ?? 99 : 99),
  );

  for (const sheetPlan of ordered) {
    if (!sheetPlan.table) continue;
    const table = sheetPlan.table;
    const sheet = sheets.find((s) => s.source === sheetPlan.source);
    if (!sheet) continue;

    for (const raw of sheet.rows) {
      try {
        const { row, virtuals, fks } = prepareRow(table, sheetPlan, raw);
        total++;
        // Ссылки по старым id: ищем запись, которую уже перенесли
        for (const fk of fks) {
          const mapped = mapOldId(fk.target, fk.oldId);
          if (mapped) {
            row[fk.column] = mapped;
            linked++;
          } else if (REQUIRED_LINKS.has(`${table}.${fk.column}`)) {
            row[fk.column] = '';
          }
        }

        let newId: string;

        /** Такая запись справочника уже есть: связываем старый id с найденной */
        const alreadyThere = (): boolean => {
          const existing = guard.find(table, row);
          if (existing === null) return false;
          repeats++;
          const oldId = sheetPlan.idColumn ? (raw[sheetPlan.idColumn] ?? '').trim() : '';
          if (oldId) {
            if (!idMaps.has(table)) idMaps.set(table, new Map());
            idMaps.get(table)?.set(oldId, existing);
          }
          return true;
        };

        switch (table) {
          case 'trips':
            newId = insertTrip(row, virtuals, books);
            break;
          case 'refuelings': {
            if (!row.station_id) {
              const station = virtuals.get('station_name');
              if (station) row.station_id = books.ref('fuel_stations', station);
            }
            if (!row.waybill_id) {
              const number = virtuals.get('waybill_number');
              if (number) row.waybill_id = books.waybill(number, '');
            }
            newId = insertRow(table, row);
            break;
          }
          case 'places': {
            if (!row.company_id) {
              const company = virtuals.get('company_name');
              if (company) row.company_id = books.ref('companies', company);
            }
            if (!row.cargo_type_id) {
              const cargo = virtuals.get('cargo_name');
              if (cargo) row.cargo_type_id = books.ref('cargo_types', cargo);
            }
            if (alreadyThere()) continue;
            newId = insertRow(table, row);
            guard.remember('places', row, newId);
            books.keep('places', row, newId);
            break;
          }
          case 'waybills': {
            if (!row.vehicle_id) {
              const vehicle = virtuals.get('vehicle_name');
              if (vehicle) row.vehicle_id = books.ref('vehicles', vehicle);
            }
            // В чужом архиве статуса нет: лист с датой приезда уже закрыт
            if (!row.status) row.status = row.date_in ? 'closed' : 'open';
            newId = insertRow(table, row);
            break;
          }
          case 'trip_points': {
            if (!row.place_id) {
              const place = virtuals.get('place_name');
              if (place) row.place_id = books.ref('places', place);
            }
            if (!row.cargo_type_id) {
              const cargo = virtuals.get('cargo_name');
              if (cargo) row.cargo_type_id = books.ref('cargo_types', cargo);
            }
            // Точка с фактической датой уже выполнена
            if (!row.status) row.status = row.fact_date ? 'done' : 'planned';
            newId = insertRow(table, row);
            break;
          }
          default: {
            if (!row.cargo_type_id) {
              const cargo = virtuals.get('cargo_name');
              if (cargo) row.cargo_type_id = books.ref('cargo_types', cargo);
            }
            // Справочники не дублируем: то же название уже есть — оставляем как есть
            if (alreadyThere()) continue;
            newId = insertRow(table, row);
            guard.remember(table, row, newId);
            books.keep(table, row, newId);
          }
        }
        track(table, newId);

        if (sheetPlan.idColumn) {
          const oldId = (raw[sheetPlan.idColumn] ?? '').trim();
          if (oldId) {
            if (!idMaps.has(table)) idMaps.set(table, new Map());
            idMaps.get(table)?.set(oldId, newId);
          }
        }
        for (const fk of fks) {
          if (!mapOldId(fk.target, fk.oldId)) {
            pending.push({ table, id: newId, column: fk.column, target: fk.target, oldId: fk.oldId });
          }
        }
        inserted[table] = (inserted[table] ?? 0) + 1;
      } catch {
        skipped.push(1);
      }
    }
  }

  // Второй проход: адресат ссылки мог появиться позже
  for (const p of pending) {
    const mapped = mapOldId(p.target, p.oldId);
    if (!mapped) continue;
    updateRow(p.table, p.id, { [p.column]: mapped });
    linked++;
  }

  // Статусы перевозок: считаем по точкам архива, затем отмечаем уже начисленные
  const chargedTrips = new Set(
    dbSync()
      .all<{ trip_id: string }>(
        "SELECT DISTINCT trip_id FROM finance_ops WHERE deleted = 0 AND kind = 'charge' AND trip_id <> ''",
      )
      .map((r) => r.trip_id),
  );
  for (const tripId of ids.trips ?? []) {
    refreshTripStatus(tripId);
    if (chargedTrips.has(tripId)) updateRow('trips', tripId, { status: 'charged' });
  }

  const added = Object.values(inserted).reduce((a, b) => a + b, 0);
  const refs = Object.entries(books.created).filter(([, n]) => n > 0);
  const parts = [`перенесено записей: ${added}`];
  if (refs.length > 0) parts.push(refs.map(([t, n]) => `${TABLE_TITLES[t as TableName] ?? t} +${n}`).join(', '));
  if (linked > 0) parts.push(`связей между таблицами: ${linked}`);
  if (repeats > 0) parts.push(`уже были в базе: ${repeats}`);
  if (skipped.length > 0) parts.push(`пропущено строк: ${skipped.length}`);

  // Записи, созданные справочником, тоже должны отменяться
  for (const [table, created] of Object.entries(books.createdIds)) {
    if (created.length === 0) continue;
    const list = (ids[table] ??= []);
    for (const id of created) if (!list.includes(id)) list.push(id);
  }

  return { inserted, created: books.created, ids, skipped: skipped.length, total, message: parts.join(' · ') };
}

/** Перевозка: заводим лист и точки загрузки/выгрузки по названиям */
function insertTrip(row: Record<string, unknown>, virtuals: Map<string, string>, books: RefBook): string {
  const date = virtuals.get('date') ?? '';
  if (!row.cargo_type_id) {
    const cargo = virtuals.get('cargo_name');
    if (cargo) row.cargo_type_id = books.ref('cargo_types', cargo);
  }
  if (!row.waybill_id) {
    row.waybill_id = books.waybill(virtuals.get('waybill_number') ?? '', date ? parseDateValue(date) : '');
  }
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
  return tripId;
}

/* ------------------------------------------------------------------ */
/* Итог для экрана                                                    */
/* ------------------------------------------------------------------ */

/** Экспорт и импорт: ZIP с CSV, Excel, JSON-резервная копия, отчёт PDF. */

import { dbSync } from '../db';
import { allSettings, insertRow, nowIso, setSetting, updateRow } from '../db/repo';
import { saveBinaryFile } from '../db/storage';
import { TABLES, type AppSettings, type TableName } from '../types';
import { fmtDate, fmtMoney, fmtNumber, monthLabel } from './format';
import { summarizeFinance, summarizeTrip, summarizeWaybill } from './calc';
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

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[";\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0]);
  const head = cols.join(';');
  const body = rows.map((r) => cols.map((c) => csvEscape(r[c])).join(';')).join('\n');
  return `\uFEFF${head}\n${body}\n`;
}

/** Считаем разделители в строке, не заглядывая внутрь кавычек */
function countDelimiters(line: string, delim: string): number {
  let n = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === delim && !inQuotes) n++;
  }
  return n;
}

/**
 * Подобрать разделитель CSV. Свои выгрузки идут через «;», но чужой архив
 * часто с запятыми или табуляцией — иначе вся строка станет одной колонкой.
 */
export function sniffDelimiter(text: string): string {
  const sample = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .slice(0, 20);
  if (sample.length === 0) return ';';
  let best = ';';
  let bestScore = 0;
  for (const delim of [';', '\t', ',', '|']) {
    const counts = sample.map((l) => countDelimiters(l, delim));
    const first = counts[0];
    if (first === 0) continue;
    const stable = counts.filter((c) => c === first).length / counts.length;
    const score = first * (0.5 + stable);
    if (score > bestScore) {
      bestScore = score;
      best = delim;
    }
  }
  return best;
}

/** Разобрать CSV. Разделитель определяется по самому тексту, если не задан явно. */
export function parseCsv(text: string, delim?: string): Record<string, string>[] {
  const separator = delim ?? sniffDelimiter(text);
  const clean = text.replace(/^\uFEFF/, '');
  const lines: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === separator) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      lines.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    lines.push(row);
  }
  if (lines.length === 0) return [];
  // Одинаковые заголовки не должны затирать друг друга
  const seen = new Map<string, number>();
  const header = lines[0].map((h) => {
    const name = h === '' ? 'Колонка' : h;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name} ${n}`;
  });
  return lines
    .slice(1)
    .filter((l) => l.some((x) => x !== ''))
    .map((l) => Object.fromEntries(header.map((h, i) => [h, l[i] ?? ''])));
}

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

/** ZIP с CSV: по одному файлу на таблицу */
export async function exportCsvZip(): Promise<void> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  const data = dumpAll();
  for (const t of TABLES) {
    zip.file(`${t}.csv`, toCsv(data[t]));
  }
  zip.file(
    'README.txt',
    [
      'АвтоБаза — выгрузка данных',
      `Дата: ${new Date().toLocaleString('ru-RU')}`,
      '',
      'Каждый файл CSV соответствует таблице базы данных.',
      'Разделитель — точка с запятой, кодировка UTF-8.',
      '',
      ...TABLES.map((t) => `${t}.csv — ${TABLE_TITLES[t]}`),
    ].join('\n'),
  );
  const blob = await zip.generateAsync({ type: 'uint8array' });
  await saveBinaryFile(`avtobaza-csv-${stamp()}.zip`, blob, 'application/zip');
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

export interface ImportResult {
  inserted: number;
  updated: number;
  skipped: number;
  /** Сколько файлов архива удалось распознать */
  files: number;
  message: string;
}

function isTable(name: string): name is TableName {
  return (TABLES as readonly string[]).includes(name);
}

/** Колонки таблицы — чтобы лишние поля из чужого файла не ломали вставку */
const columnCache = new Map<string, Map<string, string>>();

/** Имя колонки → объявленный тип (TEXT / REAL / INTEGER) */
export function columnTypesOf(table: string): Map<string, string> {
  let cols = columnCache.get(table);
  if (!cols) {
    cols = new Map(
      dbSync()
        .all<{ name: string; type: string }>(`PRAGMA table_info(${table})`)
        .map((c) => [c.name, String(c.type || '').toUpperCase()]),
    );
    columnCache.set(table, cols);
  }
  return cols;
}

export function columnsOf(table: string): Set<string> {
  return new Set(columnTypesOf(table).keys());
}

/** «10 500,50» → 10500.5; не число — null */
export function toNumber(raw: string): number | null {
  const s = raw.replace(/\s|\u00a0/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
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
function describeImport(inserted: number, updated: number, skipped: number, files: number): string {
  const parts: string[] = [];
  if (inserted > 0) parts.push(`добавлено ${inserted}`);
  if (updated > 0) parts.push(`обновлено ${updated}`);
  if (skipped > 0) parts.push(`уже было ${skipped}`);
  if (files === 0) return 'В архиве не нашлось ни одной таблицы АвтоБазы';
  if (parts.length === 0) return `Файлов распознано: ${files}, новых записей нет`;
  return parts.join(', ');
}

/**
 * Строка из CSV → значения для базы.
 * Пустые клетки пропускаем совсем: тогда подставится значение по умолчанию
 * из схемы (в таблицах много полей вида NOT NULL DEFAULT ''), а не null,
 * из-за которого вставка падала целиком.
 */
export function cleanCsvRow(table: string, row: Record<string, string>): Record<string, unknown> {
  const types = columnTypesOf(table);
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    const type = types.get(k);
    if (type === undefined) continue;
    if (v === '') continue;
    if (k === 'id' || type === 'TEXT') {
      clean[k] = v;
      continue;
    }
    const num = toNumber(v);
    clean[k] = num === null ? v : num;
  }
  return clean;
}

/** Импорт JSON-копии. Совпадающие записи (по id) остаются без изменений. */
export function importJson(text: string, overwrite = false): ImportResult {
  const payload = JSON.parse(text) as {
    app?: string;
    tables?: Record<string, Record<string, unknown>[]>;
    settings?: { key: string; value: string }[];
  };
  if (!payload.tables) throw new Error('Файл не похож на резервную копию АвтоБазы');

  const db = dbSync();
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  db.tx(() => {
    for (const [table, rows] of Object.entries(payload.tables ?? {})) {
      if (!isTable(table)) continue;
      for (const row of rows) {
        const id = String(row.id ?? '');
        if (!id) {
          skipped++;
          continue;
        }
        const exists = dbSync().one<{ id: string }>(`SELECT id FROM ${table} WHERE id = ?`, [id]);
        if (exists) {
          if (overwrite) {
            const entries = Object.entries(row).filter(([k]) => k !== 'id');
            updateRow(table, id, Object.fromEntries(entries));
            updated++;
          } else skipped++;
        } else {
          insertRow(table, row);
          inserted++;
        }
      }
    }
    for (const s of payload.settings ?? []) {
      setSetting(s.key as keyof AppSettings, s.value);
    }
  });

  return {
    inserted,
    updated,
    skipped,
    files: Object.keys(payload.tables ?? {}).length,
    message: describeImport(inserted, updated, skipped, Object.keys(payload.tables ?? {}).length),
  };
}

/** Импорт ZIP с CSV: строки добавляются, совпадающие id пропускаются. */
export async function importCsvZip(bytes: Uint8Array): Promise<ImportResult> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(bytes);
  const db = dbSync();
  let inserted = 0;
  let skipped = 0;
  let files = 0;

  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const table = name.replace(/\.csv$/i, '').trim();
    if (!isTable(table)) continue;
    files++;
    const text = decodeText(await file.async('uint8array'));
    const rows = parseCsv(text);
    db.tx(() => {
      for (const row of rows) {
        const id = String(row.id ?? '');
        if (!id) {
          skipped++;
          continue;
        }
        const exists = dbSync().one<{ id: string }>(`SELECT id FROM ${table} WHERE id = ?`, [id]);
        if (exists) {
          skipped++;
          continue;
        }
        insertRow(table, cleanCsvRow(table, row));
        inserted++;
      }
    });
  }

  return { inserted, updated: 0, skipped, files, message: describeImport(inserted, 0, skipped, files) };
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

  const tripRows: string[][] = [];
  for (const t of s.trips) {
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
  for (const t of s.trips) {
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

  autoTable.default(doc, {
    startY: 36,
    head: [['Показатель', 'Значение']],
    body: [
      ['Начислено', fmtMoney(finance.charged, settings.currency)],
      ['Оплачено', fmtMoney(finance.paid, settings.currency)],
      ['Остаток', fmtMoney(finance.balance, settings.currency)],
      ['Путевых листов', String(waybills.length)],
    ],
    styles: { fontSize: 9, font: 'DejaVu' },
  });

  const rows = waybills.map((w) => {
    const s = summarizeWaybill(w);
    return [
      `${fmtDate(w.date_out)} — ${w.date_in ? fmtDate(w.date_in) : 'открыт'}`,
      s.vehicleTitle,
      s.mileage === null ? '—' : fmtNumber(s.mileage),
      fmtNumber(s.refueled),
      s.avgConsumption === null ? '—' : fmtNumber(s.avgConsumption, 1),
      fmtMoney(s.charged, settings.currency),
    ];
  });

  autoTable.default(doc, {
    // @ts-expect-error lastAutoTable добавляется плагином
    startY: (doc as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY + 8 || 60,
    head: [['Период', 'Автомобиль', 'Пробег, км', 'Заправлено, л', 'Расход, л/100', 'Начислено']],
    body: rows.length > 0 ? rows : [['Нет данных', '', '', '', '', '']],
    styles: { fontSize: 8, font: 'DejaVu' },
    columnStyles: { 1: { cellWidth: 45 } },
  });

  const trips = tripRepo.all().filter((t) => {
    if (!month) return true;
    const wb = waybillRepo.get(t.waybill_id);
    return (wb?.date_out ?? t.created_at).slice(0, 7) === month;
  });
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
    head: [['Дата', 'Маршрут', 'Точек', 'Вес, кг', 'Начислено']],
    body: tripRows.length > 0 ? tripRows : [['Нет данных', '', '', '', '']],
    styles: { fontSize: 8, font: 'DejaVu' },
  });

  const refuels = refuelRepo.list().filter((r) => !month || r.date.slice(0, 7) === month);
  autoTable.default(doc, {
    // @ts-expect-error lastAutoTable добавляется плагином
    startY: (doc as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY + 8 || 160,
    head: [['Дата заправки', 'Объём, л', 'Источник']],
    body:
      refuels.length > 0
        ? refuels.map((r) => [fmtDate(r.date), fmtNumber(r.volume), r.kind === 'barrel' ? 'Бочка' : 'АЗС'])
        : [['Нет данных', '', '']],
    styles: { fontSize: 8, font: 'DejaVu' },
  });

  return new Uint8Array(doc.output('arraybuffer') as ArrayBuffer);
}

/** Список операций за месяц в виде строк для отчётов */
export function monthOperations(month: string) {
  return financeRepo.byMonth(month);
}

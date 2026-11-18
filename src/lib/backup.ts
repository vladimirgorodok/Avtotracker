/** Экспорт и импорт: Excel, JSON-резервная копия, файл настроек, отчёт PDF. */

import { dbSync } from '../db';
import { allSettings, insertRow, nowIso, setSetting, updateRow } from '../db/repo';
import { saveBinaryFile } from '../db/storage';
import { DEFAULT_SETTINGS, TABLES, type AppSettings, type TableName } from '../types';
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
  return Object.keys(DEFAULT_SETTINGS);
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
 * Файл данных для облака: то же, что полная копия, но картинки из него убраны —
 * они уходят отдельным архивом. Так файл данных остаётся лёгким и уходит быстро,
 * а ссылки на чужие сайты (они короткие) сохраняются.
 */
export function buildCloudData(): string {
  const tables = dumpAll();
  for (const { table, column } of PICTURE_COLUMNS) {
    for (const row of tables[table] ?? []) {
      if (isEmbeddedPicture(row[column])) row[column] = '';
    }
  }
  const payload = {
    app: 'avtobaza',
    kind: 'cloud-data',
    version: 1,
    exported_at: nowIso(),
    settings: allSettings().map((s) => ({ key: s.key, value: s.value })),
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
function describeImport(inserted: number, updated: number, skipped: number, files: number): string {
  const parts: string[] = [];
  if (inserted > 0) parts.push(`добавлено ${inserted}`);
  if (updated > 0) parts.push(`обновлено ${updated}`);
  if (skipped > 0) parts.push(`уже было ${skipped}`);
  if (files === 0) return 'В архиве не нашлось ни одной таблицы АвтоБазы';
  if (parts.length === 0) return `Файлов распознано: ${files}, новых записей нет`;
  return parts.join(', ');
}
/** Импорт JSON-копии. Совпадающие записи (по id) остаются без изменений. */
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
      files: 0,
      message: `настроек восстановлено: ${applied}`,
    };
  }
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

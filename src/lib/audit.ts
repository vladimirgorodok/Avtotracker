/**
 * Проверка данных: поиск артефактов и предложения по их устранению.
 *
 * Проверка сама ничего не меняет. Она собирает находки — дубли в финансах,
 * двойные начисления за перевозку, одинаковые названия в справочниках, ссылки в
 * никуда, пустые записи и замечания по листам, — к каждой показывает связи
 * записи (перевозку, лист, примечание) и предлагает действие. Действие
 * выполняется на экране «Проверка данных» только после подтверждения человеком.
 */

import { dbSync } from '../db';
import {
  countRows,
  financeRepo,
  getSettings,
  nowIso,
  refs,
  refuelRepo,
  softDelete,
  tripRepo,
  updateRow,
  waybillRepo,
} from '../db/repo';
import { summarizeTrip, summarizeWaybill, type TripSummary, type WaybillTotals } from './calc';
import { deleteDocument } from './documents';
import { deleteBlob, getBlob, putBlob } from './files';
import { fmtDate, fmtDateTime, fmtMoney, fmtNumber, plural } from './format';
import { normalizeName, plainName } from './names';
import type { FinanceOp, Trip, TripPoint, Waybill } from '../types';

/* ------------------------------------------------------------------ */
/* Что такое находка                                                  */
/* ------------------------------------------------------------------ */

/** Вид находки: по нему на экране собираются разделы */
export type FindingKind =
  | 'finance-duplicate'
  | 'charge-duplicate'
  | 'ref-duplicate'
  | 'orphan'
  | 'empty'
  | 'waybill-note';

/** Насколько находка важна: ошибка, внимание, просто к сведению */
export type FindingLevel = 'err' | 'warn' | 'info';

export interface FindingFix {
  /** Надпись на кнопке */
  label: string;
  /** Что изменится — показывается до подтверждения */
  what: string;
  /** Связи: к чему относится запись и что с этим станет */
  links: string[];
  /** Правку нельзя вернуть: например, файлы удаляются с устройства совсем */
  permanent?: boolean;
  /** Выполнить правку; работа с файлами бывает неспешной */
  apply: () => void | Promise<void>;
}

export interface Finding {
  /** Постоянный ключ: по нему находку можно скрыть */
  id: string;
  kind: FindingKind;
  level: FindingLevel;
  /** Что нашлось */
  title: string;
  /** Почему так решили и о каких записях речь */
  details: string[];
  /** Совет, когда одной кнопкой не исправить */
  advice?: string;
  /** Куда открыть запись */
  openTo?: string;
  /** Предложение; null — только посмотреть */
  fix: FindingFix | null;
}

export const KIND_LABELS: Record<FindingKind, string> = {
  'finance-duplicate': 'Дубли в финансах',
  'charge-duplicate': 'Двойные начисления',
  'ref-duplicate': 'Дубли в справочниках',
  orphan: 'Ссылки в никуда',
  empty: 'Пустые записи',
  'waybill-note': 'Замечания по листам',
};

export const LEVEL_LABELS: Record<FindingLevel, string> = {
  err: 'ошибка',
  warn: 'внимание',
  info: 'к сведению',
};

const LEVEL_ORDER: FindingLevel[] = ['err', 'warn', 'info'];
/** Сколько последних листов разбираем на замечания */
const NOTE_LIMIT = 15;
/** Сколько записей показываем в описании связей */
const SAMPLE_LIMIT = 4;

/* ------------------------------------------------------------------ */
/* Подписи и связи записей                                            */
/* ------------------------------------------------------------------ */

let currency: string | null = null;

/** Сумма с валютой из настроек; валюта читается один раз за проверку */
function money(v: number | null | undefined): string {
  if (currency === null) currency = getSettings().currency;
  return fmtMoney(v, currency);
}

const str = (row: Record<string, unknown>, key: string): string =>
  row[key] === null || row[key] === undefined ? '' : String(row[key]);
const num = (row: Record<string, unknown>, key: string): number => Number(row[key] ?? 0);

/** Короткая подпись операции финансов */
function opNote(op: FinanceOp): string {
  const kind = op.kind === 'payment' ? 'оплата' : 'начисление';
  const note = String(op.note ?? '').trim();
  const tail: string[] = [];
  if (op.pay_month) tail.push(`месяц ${op.pay_month}`);
  if (note) tail.push(`примечание «${note}»`);
  const created = (op.created_at || '').slice(0, 10);
  return (
    `${fmtDate(op.date)} · ${kind} ${money(op.amount)}` +
    (tail.length > 0 ? ', ' + tail.join(', ') : '') +
    (created ? `, заведена ${fmtDate(created)}` : '')
  );
}

/** Короткая подпись записи — чтобы в находке было видно, о чём речь */
function rowNote(table: string, row: Record<string, unknown>): string {
  switch (table) {
    case 'trips': {
      const cargo = refs.cargoType(str(row, 'cargo_type_id') || null)?.name ?? '';
      const wb = waybillRepo.get(str(row, 'waybill_id'));
      return (
        `перевозка ${cargo || 'без груза'}, ${money(num(row, 'amount'))}` +
        (wb ? `, лист от ${fmtDate(wb.date_out)}` : '')
      );
    }
    case 'trip_points': {
      const place = refs.place(str(row, 'place_id') || null)?.name ?? '';
      const date = str(row, 'fact_date') || str(row, 'plan_date');
      return (
        `точка ${str(row, 'kind') === 'unload' ? 'выгрузки' : 'загрузки'}` +
        (place ? ` «${place}»` : '') +
        (date ? `, ${fmtDate(date)}` : '')
      );
    }
    case 'refuelings': {
      const note = str(row, 'note').trim();
      return (
        `заправка ${fmtDate(str(row, 'date'))}, ${fmtNumber(num(row, 'volume'))} л` +
        (note ? `, примечание «${note}»` : '')
      );
    }
    case 'finance_ops':
      return opNote(row as unknown as FinanceOp);
    case 'waybills':
      return `лист от ${fmtDate(str(row, 'date_out'))}`;
    case 'attachments':
      return `файл «${str(row, 'title') || str(row, 'path')}»`;
    default:
      return str(row, 'name');
  }
}

/** Подпись записи, на которую ссылается поле */
function linkedText(table: string, id: string | null): string {
  if (!id) return '';
  switch (table) {
    case 'trips': {
      const trip = tripRepo.get(id);
      if (!trip) return 'перевозка (удалена)';
      const s = summarizeTrip(trip);
      return `перевозка «${s.title}», ${money(s.amount)}`;
    }
    case 'waybills': {
      const wb = waybillRepo.get(id);
      return wb ? `лист от ${fmtDate(wb.date_out)}` : 'лист (удалён)';
    }
    case 'places': {
      const place = refs.place(id);
      return place ? `место «${place.name}»` : 'место (удалено)';
    }
    case 'cargo_types': {
      const cargo = refs.cargoType(id);
      return cargo ? `груз «${cargo.name}»` : 'груз (удалён)';
    }
    case 'fuel_stations': {
      const station = refs.station(id);
      return station ? `АЗС «${station.name}»` : 'АЗС (удалена)';
    }
    case 'companies': {
      const company = refs.company(id);
      return company ? `фирма «${company.name}»` : 'фирма (удалена)';
    }
    case 'vehicles': {
      const vehicle = refs.vehicle(id);
      return vehicle ? `машина «${vehicle.name}»` : 'машина (удалена)';
    }
    default:
      return '';
  }
}

/** Куда ведут связи операции финансов */
function opLinks(op: FinanceOp): string[] {
  const out: string[] = [];
  const trip = linkedText('trips', op.trip_id || null);
  const wb = linkedText('waybills', op.waybill_id || null);
  if (trip) out.push(trip);
  if (wb) out.push(wb);
  if (out.length === 0) out.push('ни с перевозкой, ни с листом не связана');
  return out;
}

/**
 * Где искать ссылки на запись справочника или листа.
 *
 * Один список на всю проверку: по нему и находки «ссылка в никуда» собираются, и
 * описание связей, и перевод ссылок при слиянии двух записей.
 */
interface RefSpec {
  /** Таблица, в которой лежит ссылка */
  table: string;
  /** Поле со ссылкой */
  column: string;
  /** Таблица, на которую ссылаются */
  target: string;
  /** Как называть ссылки в описании: «перевозок», «точек» */
  usage: string;
  /** Что случилось — для находки */
  problem: string;
  /** Слова для счётчика: одна запись, две записи, много записей */
  unit: [string, string, string];
  /**
   * Что делаем в правке:
   * 'blank' — поле обязательное, ставим пустое значение (перевозка без листа);
   * 'clear' — поле обнуляем; 'remove' — записи без хозяина удаляем.
   */
  repair: 'blank' | 'clear' | 'remove';
}

const REFERENCES: RefSpec[] = [
  { table: 'trips', column: 'waybill_id', target: 'waybills', usage: 'перевозок', problem: 'Перевозки ссылаются на удалённый лист', unit: ['перевозка', 'перевозки', 'перевозок'], repair: 'blank' },
  { table: 'trips', column: 'cargo_type_id', target: 'cargo_types', usage: 'перевозок', problem: 'У перевозок удалён груз', unit: ['перевозка', 'перевозки', 'перевозок'], repair: 'clear' },
  { table: 'trip_points', column: 'trip_id', target: 'trips', usage: 'точек', problem: 'Точки остались без перевозки', unit: ['точка', 'точки', 'точек'], repair: 'remove' },
  { table: 'trip_points', column: 'place_id', target: 'places', usage: 'точек', problem: 'У точек удалено место', unit: ['точка', 'точки', 'точек'], repair: 'clear' },
  { table: 'trip_points', column: 'cargo_type_id', target: 'cargo_types', usage: 'точек', problem: 'У точек удалён груз', unit: ['точка', 'точки', 'точек'], repair: 'clear' },
  { table: 'refuelings', column: 'waybill_id', target: 'waybills', usage: 'заправок', problem: 'Заправки ссылаются на удалённый лист', unit: ['заправка', 'заправки', 'заправок'], repair: 'clear' },
  { table: 'refuelings', column: 'station_id', target: 'fuel_stations', usage: 'заправок', problem: 'У заправок удалена АЗС', unit: ['заправка', 'заправки', 'заправок'], repair: 'clear' },
  { table: 'finance_ops', column: 'waybill_id', target: 'waybills', usage: 'начислений', problem: 'Записи финансов ссылаются на удалённый лист', unit: ['запись', 'записи', 'записей'], repair: 'clear' },
  { table: 'finance_ops', column: 'trip_id', target: 'trips', usage: 'начислений', problem: 'Записи финансов ссылаются на удалённую перевозку', unit: ['запись', 'записи', 'записей'], repair: 'clear' },
  { table: 'places', column: 'company_id', target: 'companies', usage: 'мест', problem: 'У мест удалена фирма', unit: ['место', 'места', 'мест'], repair: 'clear' },
  { table: 'places', column: 'cargo_type_id', target: 'cargo_types', usage: 'мест', problem: 'У мест удалён груз', unit: ['место', 'места', 'мест'], repair: 'clear' },
  { table: 'companies', column: 'cargo_type_id', target: 'cargo_types', usage: 'фирм', problem: 'У фирм удалён груз', unit: ['фирма', 'фирмы', 'фирм'], repair: 'clear' },
  { table: 'waybills', column: 'vehicle_id', target: 'vehicles', usage: 'листов', problem: 'У листов удалён автомобиль', unit: ['лист', 'листа', 'листов'], repair: 'clear' },
  { table: 'waybills', column: 'trailer_id', target: 'vehicles', usage: 'листов', problem: 'У листов удалён прицеп', unit: ['лист', 'листа', 'листов'], repair: 'clear' },
  { table: 'vehicle_periods', column: 'vehicle_id', target: 'vehicles', usage: 'периодов', problem: 'Периоды ссылаются на удалённую машину', unit: ['период', 'периода', 'периодов'], repair: 'remove' },
  { table: 'vehicle_links', column: 'tractor_id', target: 'vehicles', usage: 'связок', problem: 'Связки ссылаются на удалённую машину', unit: ['связка', 'связки', 'связок'], repair: 'remove' },
  { table: 'vehicle_links', column: 'trailer_id', target: 'vehicles', usage: 'связок', problem: 'Связки ссылаются на удалённую машину', unit: ['связка', 'связки', 'связок'], repair: 'remove' },
];

/** Сколько и куда ссылается запись: для описания последствий слияния */
interface Usage {
  label: string;
  count: number;
  samples: string[];
}

function usageOf(target: string, id: string): Usage[] {
  const out: Usage[] = [];
  for (const ref of REFERENCES) {
    if (ref.target !== target) continue;
    const rows = dbSync().all<Record<string, unknown>>(
      `SELECT * FROM ${ref.table} WHERE ${ref.column} = ? AND deleted = 0 ORDER BY created_at DESC LIMIT ${SAMPLE_LIMIT}`,
      [id],
    );
    if (rows.length === 0) continue;
    out.push({
      label: ref.usage,
      count: countRows(ref.table, `${ref.column} = ?`, [id]),
      samples: rows.map((row) => rowNote(ref.table, row)).filter((t) => t !== ''),
    });
  }
  return out;
}

function usageTotal(usage: Usage[]): number {
  return usage.reduce((sum, u) => sum + u.count, 0);
}

/** «перевозок 3, точек 2» или «связей нет» */
function usageText(usage: Usage[]): string {
  if (usage.length === 0) return 'связей нет';
  return usage.map((u) => `${u.label} ${u.count}`).join(', ');
}

/** Перевести ссылки с одной записи на другую: записи не разъезжаются */
function moveLinks(target: string, from: string, to: string): void {
  const ts = nowIso();
  for (const ref of REFERENCES) {
    if (ref.target !== target) continue;
    dbSync().run(
      `UPDATE ${ref.table} SET ${ref.column} = ?, updated_at = ? WHERE ${ref.column} = ? AND deleted = 0`,
      [to, ts, from],
    );
  }
  // Документы и фото тоже переезжают на оставленную запись
  dbSync().run(
    `UPDATE attachments SET owner_id = ?, updated_at = ? WHERE owner_table = ? AND owner_id = ? AND deleted = 0`,
    [to, ts, target, from],
  );
}

/* ------------------------------------------------------------------ */
/* 1. Дубли в финансах                                                */
/* ------------------------------------------------------------------ */

function financeDuplicates(): Finding[] {
  const out: Finding[] = [];
  const groups = new Map<string, FinanceOp[]>();
  for (const op of financeRepo.list()) {
    if (!op.date || !op.amount) continue;
    const key = `${op.kind}|${op.date}|${op.amount.toFixed(2)}`;
    const list = groups.get(key) ?? [];
    list.push(op);
    groups.set(key, list);
  }

  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    // Две суммы за одну перевозку разбирает отдельная проверка
    const trips = new Set(rows.map((r) => r.trip_id || ''));
    if (trips.size === 1 && !trips.has('')) continue;

    const ordered = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const keep = ordered.find((r) => r.trip_id) ?? ordered[0]!;
    const drop = ordered.filter((r) => r.id !== keep.id);
    const kindWord = keep.kind === 'payment' ? 'оплата' : 'начисление';
    const differentTrips = new Set(rows.map((r) => r.trip_id || '')).size > 1;

    out.push({
      id: `finance-duplicate:${rows.map((r) => r.id).sort().join(',')}`,
      kind: 'finance-duplicate',
      level: differentTrips ? 'info' : 'warn',
      title: `${rows.length} ${plural(rows.length, 'запись', 'записи', 'записей')} на ${fmtDate(keep.date)}: ${kindWord} ${money(keep.amount)}`,
      details: [
        `Совпадают дата, вид и сумма — всего ${rows.length} ${plural(rows.length, 'запись', 'записи', 'записей')}.`,
        ...rows.map((r) => `- ${opNote(r)}`),
        ...rows.map((r) => `  связи: ${opLinks(r).join('; ')}`),
      ],
      advice: differentTrips
        ? 'Записи связаны с разными перевозками. Если это две разные работы, удалять ничего не нужно.'
        : undefined,
      openTo: `/finance/${keep.id}`,
      fix: {
        label: drop.length === 1 ? 'Удалить лишнюю' : `Удалить лишние (${drop.length})`,
        what:
          `Остаётся запись ${opNote(keep)}. ` +
          `${plural(drop.length, 'Вторая будет удалена', 'Ещё две будут удалены', `Ещё ${drop.length} будут удалены`)} — ` +
          'пометка об удалении уйдёт в облако. Вернуть можно кнопкой «Вернуть».',
        links: drop.flatMap((r) => [`${opNote(r)} → ${opLinks(r).join('; ')}`]),
        apply: () => {
          for (const r of drop) softDelete('finance_ops', r.id);
        },
      },
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 2. Двойное начисление за перевозку                                 */
/* ------------------------------------------------------------------ */

function chargeDuplicates(): Finding[] {
  const out: Finding[] = [];
  const groups = new Map<string, FinanceOp[]>();
  for (const op of financeRepo.list()) {
    if (op.kind !== 'charge' || !op.trip_id) continue;
    const list = groups.get(op.trip_id) ?? [];
    list.push(op);
    groups.set(op.trip_id, list);
  }

  for (const [tripId, rows] of groups) {
    if (rows.length < 2) continue;
    const ordered = [...rows].sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    const keep = ordered[ordered.length - 1]!;
    const drop = ordered.filter((r) => r.id !== keep.id);
    const trip = linkedText('trips', tripId);
    const wb = linkedText('waybills', keep.waybill_id || null);

    out.push({
      id: `charge-duplicate:${rows.map((r) => r.id).sort().join(',')}`,
      kind: 'charge-duplicate',
      level: 'err',
      title: `За перевозку начислено ${rows.length} раза`,
      details: [
        `Перевозка: ${trip}${wb ? `, ${wb}` : ''}.`,
        `Начислений по ней ${rows.length}, а должно быть одно — суммы складываются в финансах.`,
        ...rows.map((r) => `- ${opNote(r)}`),
      ],
      openTo: `/trips/${tripId}`,
      fix: {
        label: drop.length === 1 ? 'Удалить лишнее начисление' : `Удалить лишние (${drop.length})`,
        what:
          `Остаётся начисление ${money(keep.amount)} — последняя правка по перевозке. ` +
          `${plural(drop.length, 'Второе начисление', 'Ещё два начисления', `Ещё ${drop.length} начислений`)} ` +
          'будет удалено. Вернуть можно кнопкой «Вернуть».',
        links: drop.flatMap((r) => [`${opNote(r)} → ${opLinks(r).join('; ')}`]),
        apply: () => {
          for (const r of drop) softDelete('finance_ops', r.id);
        },
      },
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 3. Одинаковые записи в справочниках                                */
/* ------------------------------------------------------------------ */

interface RefDupeSpec {
  table: 'cargo_types' | 'fuel_stations' | 'companies';
  /** Как называть запись: «груз», «АЗС», «фирма» */
  word: string;
  /** Поле с картинкой */
  picture: string;
  /** По чему считаем записи одинаковыми */
  key: (name: string) => string;
}

const REF_DUPES: RefDupeSpec[] = [
  { table: 'cargo_types', word: 'груз', picture: 'icon', key: normalizeName },
  { table: 'fuel_stations', word: 'АЗС', picture: 'logo', key: normalizeName },
  // У фирм форма «ООО»/«ИП» важна: «ИП Иванов» и «ООО Иванов» — разные записи
  { table: 'companies', word: 'фирма', picture: 'logo', key: plainName },
];

function refDuplicates(): Finding[] {
  const out: Finding[] = [];

  for (const spec of REF_DUPES) {
    const rows = dbSync().all<Record<string, unknown>>(
      `SELECT * FROM ${spec.table} WHERE deleted = 0`,
    );
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const row of rows) {
      const key = spec.key(str(row, 'name'));
      if (!key) continue;
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }

    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const scored = list.map((row) => ({
        row,
        id: str(row, 'id'),
        picture: str(row, spec.picture) !== '',
        usage: usageOf(spec.table, str(row, 'id')),
      }));
      // Оставляем ту запись, где уже есть картинка и больше связей
      const keep =
        scored.find((s) => s.picture && usageTotal(s.usage) > 0) ??
        scored.find((s) => s.picture) ??
        [...scored].sort((a, b) => usageTotal(b.usage) - usageTotal(a.usage))[0]!;
      const drop = scored.filter((s) => s.id !== keep.id);
      const name = str(keep.row, 'name');
      const links = drop.flatMap((s) => [
        `${spec.word} «${str(s.row, 'name')}» (${spec.picture === 'icon' ? 'значок' : 'логотип'}: ${s.picture ? 'есть' : 'нет'}, ${usageText(s.usage)})`,
      ]);

      out.push({
        id: `ref-duplicate:${spec.table}:${list.map((r) => str(r, 'id')).sort().join(',')}`,
        kind: 'ref-duplicate',
        level: 'warn',
        title: `${list.length} записи с одним названием: «${name}»`,
        details: [
          `В справочнике ${list.length} ${spec.word} с одинаковым названием — так выходит, когда устройство и облако заполняли справочник по отдельности.`,
          ...scored.map(
            (s) =>
              `- «${str(s.row, 'name')}», заведена ${fmtDateTime(str(s.row, 'created_at'))}, ${usageText(s.usage)}` +
              (str(s.row, 'note') ? `, примечание «${str(s.row, 'note')}»` : ''),
          ),
        ],
        openTo: '/refs',
        fix: {
          label: drop.length === 1 ? 'Слить записи' : `Слить записи (${drop.length})`,
          what:
            `Останется ${spec.word} «${name}»${str(keep.row, spec.picture) ? ' с её картинкой' : ''}. ` +
            'Ссылки с остальных переедут на неё, пустые поля заполнятся из них, а сами записи будут удалены. Вернуть можно кнопкой «Вернуть».',
          links: [
            `Остаётся: «${str(keep.row, 'name')}» (${spec.picture === 'icon' ? 'значок' : 'логотип'}: ${keep.picture ? 'есть' : 'нет'}, ${usageText(keep.usage)})`,
            ...links,
            ...drop.flatMap((s) => s.usage.flatMap((u) => u.samples)),
          ],
          apply: () => {
            for (const s of drop) {
              moveLinks(spec.table, s.id, keep.id);
              const fill: Record<string, unknown> = {};
              for (const field of [spec.picture, 'note']) {
                if (str(keep.row, field) === '' && str(s.row, field) !== '') fill[field] = s.row[field];
              }
              if (Object.keys(fill).length > 0) updateRow(spec.table, keep.id, fill);
              softDelete(spec.table, s.id);
            }
          },
        },
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 4. Ссылки в никуда                                                 */
/* ------------------------------------------------------------------ */

function orphans(): Finding[] {
  const out: Finding[] = [];

  for (const ref of REFERENCES) {
    const rows = dbSync().all<Record<string, unknown>>(
      `SELECT r.* FROM ${ref.table} r
        LEFT JOIN ${ref.target} t ON t.id = r.${ref.column}
       WHERE r.deleted = 0 AND r.${ref.column} IS NOT NULL AND r.${ref.column} <> ''
         AND (t.id IS NULL OR t.deleted = 1)
       ORDER BY r.created_at DESC`,
      [],
    );
    if (rows.length === 0) continue;

    const remove = ref.repair === 'remove';
    const count = rows.length;
    const unit = ref.unit;
    const many = `${count} ${plural(count, unit[0], unit[1], unit[2])}`;
    out.push({
      id: `orphan:${ref.table}.${ref.column}`,
      kind: 'orphan',
      level: remove ? 'err' : 'warn',
      title: `${ref.problem} — ${count} ${plural(count, unit[0], unit[1], unit[2])}`,
      details: [
        'Ссылка ведёт на удалённую запись — вернуть её нельзя, а сама запись из-за этого не видна там, где нужна.',
        ...rows.slice(0, SAMPLE_LIMIT).map((row) => `- ${rowNote(ref.table, row)}`),
        ...(count > SAMPLE_LIMIT ? [`- и ещё ${count - SAMPLE_LIMIT}`] : []),
      ],
      fix: {
        label: remove ? `Удалить ${plural(count, unit[0], unit[1], unit[2])}` : 'Очистить ссылку',
        what: remove
          ? `Будут удалены ${many}: они остались от записи, которой больше нет. Вернуть можно кнопкой «Вернуть».`
          : ref.repair === 'blank'
            ? `У ${many} лист станет не выбран — сама перевозка останется на месте. Вернуть можно кнопкой «Вернуть».`
            : `У ${many} ${ref.column === 'station_id' ? 'АЗС' : 'ссылка'} станет пустой — сами записи останутся на месте. Вернуть можно кнопкой «Вернуть».`,
        links: rows.slice(0, SAMPLE_LIMIT).map((row) => `${rowNote(ref.table, row)} → ссылка на удалённую запись`),
        apply: () => {
          for (const row of rows) {
            const id = str(row, 'id');
            if (remove) softDelete(ref.table, id);
            else updateRow(ref.table, id, { [ref.column]: ref.repair === 'blank' ? '' : null });
          }
        },
      },
    });
  }

  // Файлы, чьи записи удалены
  const files = dbSync().all<Record<string, unknown>>(
    `SELECT a.* FROM attachments a
       LEFT JOIN waybills w ON a.owner_table = 'waybills' AND w.id = a.owner_id
       LEFT JOIN refuelings r ON a.owner_table = 'refuelings' AND r.id = a.owner_id
      WHERE a.deleted = 0
        AND ((a.owner_table = 'waybills' AND (w.id IS NULL OR w.deleted = 1))
          OR (a.owner_table = 'refuelings' AND (r.id IS NULL OR r.deleted = 1)))`,
    [],
  );
  if (files.length > 0) {
    out.push({
      id: `orphan:attachments:${files.map((f) => str(f, 'id')).sort().join(',')}`,
      kind: 'orphan',
      level: 'warn',
      title: `Фотографии без записи — ${files.length}`,
      details: [
        'Файлы остались от удалённых листов и заправок: в приложении их уже не открыть.',
        ...files.slice(0, SAMPLE_LIMIT).map((f) => `- ${rowNote('attachments', f)} (${fmtDate(str(f, 'created_at'))})`),
      ],
      fix: {
        label: 'Убрать файлы',
        what:
          `Файлы будут удалены с устройства и из базы (${files.length}). ` +
          'Вернуть их будет нельзя — они удаляются окончательно.',
        permanent: true,
        links: files.slice(0, SAMPLE_LIMIT).map((f) => `- ${rowNote('attachments', f)}`),
        apply: async () => {
          for (const f of files) await deleteDocument(str(f, 'id'));
        },
      },
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* 5. Пустые записи                                                   */
/* ------------------------------------------------------------------ */

/** Запись заведена не сегодня: сегодняшние только заполняются, их не трогаем */
function older(today: string, iso: string): boolean {
  const day = (iso || '').slice(0, 10);
  return day !== '' && day < today;
}

/**
 * Пустые записи.
 *
 * Пустой лист и брошенную перевозку ищем не перебором с запросом на каждую
 * запись, а одним запросом: в базе бывают сотни листов, и поштучные запросы
 * заметно замедляли проверку.
 */
function empties(): Finding[] {
  const out: Finding[] = [];
  const today = new Date().toISOString().slice(0, 10);

  const emptyWaybills = dbSync().all<Record<string, unknown>>(
    `SELECT w.* FROM waybills w
      WHERE w.deleted = 0
        AND (w.status = 'closed' OR substr(COALESCE(NULLIF(w.date_out, ''), w.created_at), 1, 10) < ?)
        AND NOT EXISTS (SELECT 1 FROM trips t WHERE t.deleted = 0 AND t.waybill_id = w.id)
        AND NOT EXISTS (SELECT 1 FROM refuelings r WHERE r.deleted = 0 AND r.waybill_id = w.id)`,
    [today],
  );
  for (const row of emptyWaybills) {
    const wb = row as unknown as Waybill;
    out.push({
      id: `empty-waybill:${wb.id}`,
      kind: 'empty',
      level: 'warn',
      title: `Пустой путевой лист от ${fmtDate(wb.date_out)}`,
      details: [
        'В листе нет ни перевозок, ни заправок.',
        wb.status === 'closed' ? 'Лист закрыт.' : 'Лист так и остался открытым.',
        `Заведён ${fmtDateTime(wb.created_at)}${wb.vehicle_id ? `, ${linkedText('vehicles', wb.vehicle_id)}` : ''}.`,
      ],
      openTo: `/waybills/${wb.id}`,
      fix: {
        label: 'Удалить лист',
        what: 'Лист будет удалён. Пометка об удалении уйдёт в облако. Вернуть можно кнопкой «Вернуть».',
        links: ['перевозок: 0', 'заправок: 0'],
        apply: () => softDelete('waybills', wb.id),
      },
    });
  }

  const emptyTrips = dbSync().all<Record<string, unknown>>(
    `SELECT t.* FROM trips t
      WHERE t.deleted = 0 AND t.status = 'planned'
        AND substr(t.created_at, 1, 10) < ?
        AND t.cargo_type_id IS NULL AND t.weight IS NULL
        AND NOT EXISTS (SELECT 1 FROM trip_points p WHERE p.deleted = 0 AND p.trip_id = t.id)
        AND NOT EXISTS (SELECT 1 FROM finance_ops f WHERE f.deleted = 0 AND f.trip_id = t.id)`,
    [today],
  );
  for (const row of emptyTrips) {
    const trip = row as unknown as Trip;
    const s = summarizeTrip(trip);
    out.push({
      id: `empty-trip:${trip.id}`,
      kind: 'empty',
      level: 'warn',
      title: `Перевозка заведена и не заполнена: ${money(s.amount)}`,
      details: [
        'Ни точек маршрута, ни груза, ни веса — перевозка так и осталась пустой.',
        `Заведена ${fmtDateTime(trip.created_at)}${trip.waybill_id ? `, ${linkedText('waybills', trip.waybill_id)}` : ''}.`,
      ],
      openTo: `/trips/${trip.id}`,
      fix: {
        label: 'Удалить перевозку',
        what: 'Перевозка будет удалена. Пометка об удалении уйдёт в облако. Вернуть можно кнопкой «Вернуть».',
        links: [trip.waybill_id ? `лист: ${linkedText('waybills', trip.waybill_id)}` : 'лист не выбран', 'точек: 0, груз не выбран, вес не указан'],
        apply: () => softDelete('trips', trip.id),
      },
    });
  }

  for (const refuel of refuelRepo.list()) {
    if (Number(refuel.volume) > 0) continue;
    if (!older(today, refuel.created_at)) continue;
    out.push({
      id: `empty-refuel:${refuel.id}`,
      kind: 'empty',
      level: 'warn',
      title: `Заправка без объёма: ${fmtDate(refuel.date)}`,
      details: [
        'Объём нулевой — такая заправка не влияет на расход и только мешает.',
        `Заведена ${fmtDateTime(refuel.created_at)}${refuel.waybill_id ? `, ${linkedText('waybills', refuel.waybill_id)}` : ''}.`,
        ...(refuel.station_id ? [`АЗС: ${linkedText('fuel_stations', refuel.station_id)}`] : []),
      ],
      openTo: `/refuelings/${refuel.id}`,
      fix: {
        label: 'Удалить заправку',
        what: 'Заправка будет удалена. Пометка об удалении уйдёт в облако. Вернуть можно кнопкой «Вернуть».',
        links: ['объём: 0 л'],
        apply: () => softDelete('refuelings', refuel.id),
      },
    });
  }

  for (const op of financeRepo.list()) {
    if (Number(op.amount) !== 0 || String(op.note ?? '').trim() !== '') continue;
    if (!older(today, op.created_at)) continue;
    out.push({
      id: `empty-finance:${op.id}`,
      kind: 'empty',
      level: 'warn',
      title: `Запись финансов с нулевой суммой: ${fmtDate(op.date)}`,
      details: [
        'Сумма нулевая и примечания нет — в итогах такая запись ничего не значит.',
        opNote(op),
        `связи: ${opLinks(op).join('; ')}`,
      ],
      openTo: `/finance/${op.id}`,
      fix: {
        label: 'Удалить запись',
        what: 'Запись будет удалена. Пометка об удалении уйдёт в облако. Вернуть можно кнопкой «Вернуть».',
        links: opLinks(op),
        apply: () => softDelete('finance_ops', op.id),
      },
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* 6. Замечания по листам                                             */
/* ------------------------------------------------------------------ */

function noteFinding(wb: Waybill, totals: WaybillTotals, text: string, level: FindingLevel): Finding {
  const base = {
    id: `waybill-note:${wb.id}:${normalizeName(text)}`,
    kind: 'waybill-note' as const,
    level,
    title: `${text} — лист от ${fmtDate(wb.date_out)}`,
    details: [
      `${totals.vehicleTitle}, ${totals.periodLabel}.`,
      `Пробег ${fmtNumber(totals.mileage)} км, израсходовано ${fmtNumber(totals.consumed)} л` +
        (totals.avgConsumption === null ? '' : `, средний расход ${fmtNumber(totals.avgConsumption, 1)} л/100 км`) +
        (totals.normConsumption === null ? '' : `, норма ${fmtNumber(totals.normConsumption, 1)} л`) +
        '.',
      `Перевозок ${totals.tripsCount}, начислено ${money(totals.charged)}.`,
    ],
    openTo: `/waybills/${wb.id}`,
  };

  if (text.startsWith('Одометр при сдаче меньше')) {
    return {
      ...base,
      fix: {
        label: 'Убрать одометр сдачи',
        what:
          `Одометр при сдаче (${fmtNumber(wb.odometer_in)} км) меньше, чем при выезде (${fmtNumber(wb.odometer_out)} км). ` +
          'Значение станет пустым — впишите верное и закройте лист.',
        links: [`лист от ${fmtDate(wb.date_out)}`, 'одометр при выезде останется на месте'],
        apply: () => updateRow('waybills', wb.id, { odometer_in: null }),
      },
    };
  }

  if (text.startsWith('Дата сдачи раньше')) {
    return {
      ...base,
      fix: {
        label: 'Убрать дату сдачи',
        what:
          `Дата сдачи (${fmtDate(wb.date_in)}) раньше даты выезда (${fmtDate(wb.date_out)}). ` +
          'Дата сдачи станет пустой — впишите верную и закройте лист.',
        links: [`дата выезда ${fmtDate(wb.date_out)} останется на месте`],
        apply: () => updateRow('waybills', wb.id, { date_in: null }),
      },
    };
  }

  if (text.startsWith('Лист закрыт без')) {
    return {
      ...base,
      fix: {
        label: 'Открыть лист',
        what: 'Лист снова станет открытым: дозаполните одометр и топливо при сдаче и закройте его заново.',
        links: [`одометр при сдаче: ${wb.odometer_in === null ? 'не указан' : fmtNumber(wb.odometer_in)} км`, `топливо при сдаче: ${wb.fuel_in === null ? 'не указано' : `${fmtNumber(wb.fuel_in)} л`}`],
        apply: () => updateRow('waybills', wb.id, { status: 'open' }),
      },
    };
  }

  const tripMatch = /^Перевозка «(.+)»: дата выгрузки/.exec(text);
  const trip: TripSummary | undefined = tripMatch
    ? totals.trips.find((s) => s.title === tripMatch[1])
    : undefined;
  const unload: TripPoint | null = trip?.lastUnload ?? null;
  if (trip && unload) {
    return {
      ...base,
      openTo: `/trips/${trip.trip.id}`,
      fix: {
        label: 'Убрать дату выгрузки',
        what: 'У последней точки выгрузки будут очищены даты. Впишите их заново на экране перевозки.',
        links: [rowNote('trip_points', unload as unknown as Record<string, unknown>), `перевозка «${trip.title}»`],
        apply: () => updateRow('trip_points', unload.id, { fact_date: null, plan_date: null }),
      },
    };
  }

  return {
    ...base,
    advice:
      'Проверьте одометр, объёмы заправок и даты точек: если всё верно, оставьте как есть — это просто отклонение от нормы.',
    fix: null,
  };
}

function waybillNotes(): Finding[] {
  const out: Finding[] = [];
  for (const wb of waybillRepo.list().slice(0, NOTE_LIMIT)) {
    const totals = summarizeWaybill(wb);
    for (const text of totals.errors) out.push(noteFinding(wb, totals, text, 'err'));
    for (const text of totals.warnings) out.push(noteFinding(wb, totals, text, 'warn'));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Проверка целиком                                                   */
/* ------------------------------------------------------------------ */

/** Все находки: сначала важные */
export function audit(): Finding[] {
  currency = null;
  const found: Finding[] = [
    ...financeDuplicates(),
    ...chargeDuplicates(),
    ...refDuplicates(),
    ...orphans(),
    ...empties(),
    ...waybillNotes(),
  ];
  return found.sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));
}

/** Счётчики по важности — для заголовка экрана */
export function auditCounts(list: Finding[]): Record<FindingLevel, number> {
  const out: Record<FindingLevel, number> = { err: 0, warn: 0, info: 0 };
  for (const f of list) out[f.level]++;
  return out;
}

/** Разбор находок по видам — для разделов на экране */
export function auditGroups(list: Finding[]): { kind: FindingKind; items: Finding[] }[] {
  const out: { kind: FindingKind; items: Finding[] }[] = [];
  for (const kind of Object.keys(KIND_LABELS) as FindingKind[]) {
    const items = list.filter((f) => f.kind === kind);
    if (items.length > 0) out.push({ kind, items });
  }
  return out;
}

/** Короткая подпись для пункта меню: сколько находок ждёт решения */
export function auditSummary(): string {
  const counts = auditCounts(audit());
  const parts: string[] = [];
  if (counts.err > 0) parts.push(`${counts.err} ${plural(counts.err, 'ошибка', 'ошибки', 'ошибок')}`);
  if (counts.warn > 0) parts.push(`${counts.warn} требуют внимания`);
  if (parts.length === 0) return 'Находок нет';
  return parts.join(', ');
}

/** Короткий рассказ о находках — его видит помощник */
export function auditText(limit = 8): string {
  const list = audit();
  if (list.length === 0) return 'Проверка данных: артефактов не нашлось.';
  const rows: string[] = [
    `Проверка данных нашла ${list.length} ${plural(list.length, 'находку', 'находки', 'находок')}:`,
  ];
  for (const f of list.slice(0, limit)) rows.push(`- ${f.title}`);
  if (list.length > limit) rows.push(`- и ещё ${list.length - limit}`);
  rows.push(
    'Исправить можно на экране «Проверка данных» (раздел «Ещё»): по каждой находке там кнопка с подтверждением.',
  );
  return rows.join('\n');
}

/* ------------------------------------------------------------------ */
/* Скрытые находки: запоминаются на устройстве                        */
/* ------------------------------------------------------------------ */

const HIDDEN_KEY = 'audit-hidden.json';
const HIDDEN_LIMIT = 200;

export async function loadHidden(): Promise<string[]> {
  const bytes = await getBlob(HIDDEN_KEY);
  if (!bytes) return [];
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export async function saveHidden(ids: string[]): Promise<void> {
  if (ids.length === 0) {
    await deleteBlob(HIDDEN_KEY);
    return;
  }
  await putBlob(HIDDEN_KEY, new TextEncoder().encode(JSON.stringify(ids.slice(-HIDDEN_LIMIT))));
}

/* ------------------------------------------------------------------ */
/* Применение правки и отмена                                          */
/* ------------------------------------------------------------------ */

/** Таблицы, которых касаются правки: по ним готовится снимок для отмены */
const UNDO_TABLES = [
  'companies',
  'cargo_types',
  'fuel_stations',
  'places',
  'vehicles',
  'vehicle_periods',
  'vehicle_links',
  'waybills',
  'trips',
  'trip_points',
  'refuelings',
  'finance_ops',
  'attachments',
];

type SavedValue = string | number | null | Uint8Array;
type SavedTable = { table: string; rows: Record<string, SavedValue>[] };

/**
 * Снимок данных до правки.
 *
 * Правки мягкие: записи получают пометку об удалении, а не исчезают. Поэтому
 * чтобы вернуть всё как было, достаточно запомнить строки целиком и записать их
 * обратно. Снимок делается целиком по таблицам, которых касаются правки: так
 * отмена не зависит от того, какие именно поля и ссылки правила правка.
 */
function snapshotTables(): SavedTable[] {
  return UNDO_TABLES.map((table) => ({
    table,
    rows: dbSync().all<Record<string, SavedValue>>(`SELECT * FROM ${table}`),
  }));
}

function restoreTables(snap: SavedTable[]): void {
  for (const { table, rows } of snap) {
    for (const row of rows) {
      const keys = Object.keys(row);
      const sets = keys.map((k) => `${k} = ?`).join(', ');
      dbSync().run(
        `UPDATE ${table} SET ${sets} WHERE id = ?`,
        [...keys.map((k) => row[k] ?? null), row.id ?? null],
      );
    }
  }
}

/** Что за правка выполнена и как её вернуть */
export interface AppliedFix {
  findingId: string;
  /** Находка, из которой пришла правка */
  title: string;
  /** Надпись на кнопке правки */
  label: string;
  at: string;
  /** Вернуть нельзя: файлы удалены окончательно */
  permanent: boolean;
  undo: () => void;
}

let lastFix: AppliedFix | null = null;

/** Последняя выполненная правка — для кнопки «Вернуть» */
export function lastAppliedFix(): AppliedFix | null {
  return lastFix;
}

/** Выполнить правку находки и запомнить, как её вернуть */
export async function applyFinding(finding: Finding): Promise<AppliedFix | null> {
  if (!finding.fix) return null;
  const snap = snapshotTables();
  await finding.fix.apply();
  lastFix = {
    findingId: finding.id,
    title: finding.title,
    label: finding.fix.label,
    at: nowIso(),
    permanent: finding.fix.permanent === true,
    undo: () => restoreTables(snap),
  };
  return lastFix;
}

/** Вернуть последнюю правку. false — вернуть нельзя (удалены файлы) либо нечего возвращать */
export function undoLastFix(): boolean {
  if (!lastFix || lastFix.permanent) return false;
  lastFix.undo();
  lastFix = null;
  return true;
}

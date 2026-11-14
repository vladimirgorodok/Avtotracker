/**
 * Поиск по всей базе сразу.
 *
 * Одна строка — и видно, что нашлось и где: путевые листы, поездки, заправки,
 * деньги, техника и справочники. По каждой находке известен адрес карточки,
 * чтобы можно было сразу перейти к записи.
 */

import { countRows, financeRepo, refs, refuelRepo, tripRepo, waybillRepo, getSettings } from '../db/repo';
import { summarizeTrip, summarizeWaybill } from './calc';
import { fmtDate, fmtMoney, fmtNumber } from './format';
import { FINANCE_KINDS, refuelKindLabel, type Id } from '../types';

/** Разделы, по которым идёт поиск, — в том порядке, в каком показываем находки */
export type SearchKind =
  | 'waybill'
  | 'trip'
  | 'refueling'
  | 'finance'
  | 'vehicle'
  | 'company'
  | 'place'
  | 'cargo'
  | 'station';

export const SEARCH_KINDS: { kind: SearchKind; label: string }[] = [
  { kind: 'waybill', label: 'Путевые листы' },
  { kind: 'trip', label: 'Поездки' },
  { kind: 'refueling', label: 'Заправки' },
  { kind: 'finance', label: 'Финансы' },
  { kind: 'vehicle', label: 'Техника' },
  { kind: 'company', label: 'Фирмы' },
  { kind: 'place', label: 'Места' },
  { kind: 'cargo', label: 'Грузы' },
  { kind: 'station', label: 'АЗС' },
];

/** Сколько находок показываем в каждом разделе (остальные — по счётчику) */
export const SEARCH_LIMIT = 20;

/** Одна находка: что нашли и куда ведёт */
export interface SearchHit {
  kind: SearchKind;
  id: Id;
  /** Название записи — крупно */
  title: string;
  /** Уточнение: дата, фирма, адрес */
  sub: string;
  /** Логотип или значок записи, если есть */
  logo: string;
  /** Адрес карточки записи */
  to: string;
}

export interface SearchResult {
  /** Находки в порядке разделов (не больше SEARCH_LIMIT на раздел) */
  hits: SearchHit[];
  /** Сколько всего нашлось, включая не поместившиеся в список */
  total: number;
  /** Сколько нашлось в каждом разделе */
  byKind: Record<SearchKind, number>;
}

function emptyCounts(): Record<SearchKind, number> {
  return {
    waybill: 0,
    trip: 0,
    refueling: 0,
    finance: 0,
    vehicle: 0,
    company: 0,
    place: 0,
    cargo: 0,
    station: 0,
  };
}

/** Ищем по всем полям записи: набор букв должен встретиться в любом из них */
function matches(hay: string, needle: string): boolean {
  return hay.toLowerCase().includes(needle);
}

function join(parts: (string | number | null | undefined)[], sep = ' · '): string {
  return parts.filter((p) => p !== null && p !== undefined && String(p).trim() !== '').join(sep);
}

function waybillHits(needle: string): SearchHit[] {
  return waybillRepo
    .list()
    .filter((wb) => {
      const vehicle = refs.vehicle(wb.vehicle_id);
      const trailer = refs.vehicle(wb.trailer_id);
      return matches(
        join([wb.number, wb.name, wb.note, wb.date_out, vehicle?.name, vehicle?.plate, trailer?.plate], ' '),
        needle,
      );
    })
    .map((wb) => {
      const sum = summarizeWaybill(wb);
      return {
        kind: 'waybill' as const,
        id: wb.id,
        title: wb.number ? `Путевой лист № ${wb.number}` : 'Путевой лист',
        sub: join([
          fmtDate(wb.date_out),
          wb.date_in ? `сдан ${fmtDate(wb.date_in)}` : 'открыт',
          sum.vehicleTitle,
        ]),
        logo: refs.vehicle(wb.vehicle_id)?.logo ?? '',
        to: `/waybills/${wb.id}`,
      };
    });
}

function tripHits(needle: string): SearchHit[] {
  return tripRepo
    .all()
    .map(summarizeTrip)
    .filter((t) => {
      const cargo = refs.cargoType(t.trip.cargo_type_id)?.name ?? '';
      const places = t.points
        .map((p) => {
          const place = refs.place(p.place_id);
          return join([place?.name, place?.address, refs.company(place?.company_id ?? null)?.name], ' ');
        })
        .join(' ');
      return matches(join([t.title, cargo, places, t.trip.note], ' '), needle);
    })
    .map((t) => ({
      kind: 'trip' as const,
      id: t.trip.id,
      title: t.title,
      sub: join([
        fmtDate(t.dateLoad),
        refs.cargoType(t.trip.cargo_type_id)?.name,
        t.completed ? 'выполнена' : 'в плане',
        t.amount > 0 ? fmtMoney(t.amount, getSettings().currency) : '',
      ]),
      logo: refs.cargoType(t.trip.cargo_type_id)?.icon ?? '',
      to: `/trips/${t.trip.id}`,
    }));
}

function refuelingHits(needle: string): SearchHit[] {
  return refuelRepo
    .list()
    .filter((r) => {
      const station = refs.station(r.station_id);
      const waybill = r.waybill_id ? waybillRepo.get(r.waybill_id) : null;
      return matches(
        join([r.note, r.date, r.volume, station?.name, refuelKindLabel(r.kind), waybill?.number], ' '),
        needle,
      );
    })
    .map((r) => {
      const station = refs.station(r.station_id);
      return {
        kind: 'refueling' as const,
        id: r.id,
        title: `${fmtNumber(r.volume)} л · ${station?.name ?? refuelKindLabel(r.kind)}`,
        sub: join([fmtDate(r.date), r.note, r.kind === 'barrel' ? 'бочка' : '']),
        logo: station?.logo ?? '',
        to: `/refuelings/${r.id}`,
      };
    });
}

function financeHits(needle: string): SearchHit[] {
  const currency = getSettings().currency;
  return financeRepo
    .list()
    .filter((o) => {
      const label = FINANCE_KINDS.find((k) => k.value === o.kind)?.label ?? '';
      return matches(join([o.note, o.date, o.pay_month, label, o.amount], ' '), needle);
    })
    .map((o) => {
      const label = FINANCE_KINDS.find((k) => k.value === o.kind)?.label ?? '';
      return {
        kind: 'finance' as const,
        id: o.id,
        title: `${label} · ${fmtMoney(o.amount, currency)}`,
        sub: join([fmtDate(o.date), o.note || 'без описания']),
        logo: '',
        to: `/finance/${o.id}`,
      };
    });
}

function vehicleHits(needle: string): SearchHit[] {
  return refs
    .vehicles()
    .filter((v) =>
      matches(join([v.name, v.plate, v.brand, v.model, v.vin, v.year, v.note], ' '), needle),
    )
    .map((v) => ({
      kind: 'vehicle' as const,
      id: v.id,
      title: v.name || v.plate || 'Автомобиль',
      sub: join([
        v.kind === 'tractor' ? 'Тягач' : 'Прицеп',
        join([v.brand, v.model], ' '),
        v.plate,
        v.archived ? 'в архиве' : '',
      ]),
      logo: v.logo,
      to: `/vehicles/${v.id}`,
    }));
}

function companyHits(needle: string): SearchHit[] {
  return refs
    .companies()
    .filter((c) => matches(join([c.name, c.note, refs.cargoType(c.cargo_type_id)?.name], ' '), needle))
    .map((c) => ({
      kind: 'company' as const,
      id: c.id,
      title: c.name,
      sub: join([
        'Фирма',
        refs.cargoType(c.cargo_type_id)?.name,
        `${countRows('places', 'company_id = ?', [c.id])} мест`,
      ]),
      logo: c.logo,
      to: `/refs?tab=companies&id=${c.id}`,
    }));
}

function placeHits(needle: string): SearchHit[] {
  return refs
    .places()
    .filter((p) =>
      matches(join([p.name, p.address, p.contact, p.note, refs.company(p.company_id)?.name], ' '), needle),
    )
    .map((p) => ({
      kind: 'place' as const,
      id: p.id,
      title: p.name,
      sub: join(['Место', refs.company(p.company_id)?.name, p.address]),
      logo: refs.company(p.company_id)?.logo ?? '',
      to: `/refs?tab=places&id=${p.id}`,
    }));
}

function cargoHits(needle: string): SearchHit[] {
  return refs
    .cargoTypes()
    .filter((c) => matches(join([c.name, c.note], ' '), needle))
    .map((c) => ({
      kind: 'cargo' as const,
      id: c.id,
      title: c.name,
      sub: join(['Груз', c.note]),
      logo: c.icon,
      to: `/refs?tab=cargo&id=${c.id}`,
    }));
}

function stationHits(needle: string): SearchHit[] {
  return refs
    .fuelStations()
    .filter((s) => matches(join([s.name, s.note], ' '), needle))
    .map((s) => ({
      kind: 'station' as const,
      id: s.id,
      title: s.name,
      sub: join(['АЗС', s.note]),
      logo: s.logo,
      to: `/refs?tab=stations&id=${s.id}`,
    }));
}

/**
 * Поиск по всей базе. Пустая строка — ничего не ищем (экран показывает подсказку).
 */
export function globalSearch(query: string, perKind = SEARCH_LIMIT): SearchResult {
  const needle = query.trim().toLowerCase();
  const byKind = emptyCounts();
  if (needle === '') return { hits: [], total: 0, byKind };

  const found: Record<SearchKind, SearchHit[]> = {
    waybill: waybillHits(needle),
    trip: tripHits(needle),
    refueling: refuelingHits(needle),
    finance: financeHits(needle),
    vehicle: vehicleHits(needle),
    company: companyHits(needle),
    place: placeHits(needle),
    cargo: cargoHits(needle),
    station: stationHits(needle),
  };

  const hits: SearchHit[] = [];
  let total = 0;
  for (const { kind } of SEARCH_KINDS) {
    const list = found[kind];
    byKind[kind] = list.length;
    total += list.length;
    hits.push(...list.slice(0, perKind));
  }
  return { hits, total, byKind };
}

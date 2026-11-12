/** Расчёты по путевым листам, перевозкам и топливу. */

import { financeRepo, refs, refuelRepo, tripRepo, vehicleRepo, waybillRepo } from '../db/repo';
import type { AppSettings, Id, Trip, TripPoint, Waybill } from '../types';

export interface TripSummary {
  trip: Trip;
  points: TripPoint[];
  loads: TripPoint[];
  unloads: TripPoint[];
  firstLoad: TripPoint | null;
  lastUnload: TripPoint | null;
  dateLoad: string | null;
  dateUnload: string | null;
  placeLoadName: string;
  placeUnloadName: string;
  totalWeight: number;
  pointsCount: number;
  doneCount: number;
  amount: number;
  progress: number;
  title: string;
  status: Trip['status'];
}

export function summarizeTrip(trip: Trip): TripSummary {
  const points = tripRepo.points(trip.id);
  const loads = points.filter((p) => p.kind === 'load');
  const unloads = points.filter((p) => p.kind === 'unload');
  const firstLoad = loads[0] ?? null;
  const lastUnload = unloads[unloads.length - 1] ?? null;
  const placeLoadName = refs.place(firstLoad?.place_id ?? null)?.name ?? '';
  const placeUnloadName = refs.place(lastUnload?.place_id ?? null)?.name ?? '';
  const totalWeight =
    points.reduce((s, p) => s + (p.weight ?? 0), 0) || (trip.weight ?? 0);
  const doneCount = points.filter((p) => p.status === 'done').length;
  const dateLoad = firstLoad?.fact_date ?? firstLoad?.plan_date ?? null;
  const dateUnload = lastUnload?.fact_date ?? lastUnload?.plan_date ?? null;

  return {
    trip,
    points,
    loads,
    unloads,
    firstLoad,
    lastUnload,
    dateLoad,
    dateUnload,
    placeLoadName,
    placeUnloadName,
    totalWeight,
    pointsCount: points.length,
    doneCount,
    amount: trip.amount ?? 0,
    progress: points.length === 0 ? 0 : doneCount / points.length,
    title: `${placeLoadName || '—'} → ${placeUnloadName || '—'}`,
    status: trip.status,
  };
}

/** Начисление за перевозку: базовая сумма плюс доплата за точки сверх базовых */
export function autoTripAmount(settings: AppSettings, pointsCount: number): number {
  const extra = Math.max(0, pointsCount - settings.base_points);
  return settings.base_amount + extra * settings.extra_point_amount;
}

export interface WaybillTotals {
  waybill: Waybill;
  trips: TripSummary[];
  tripsCount: number;
  mileage: number | null;
  refueled: number;
  refuelCount: number;
  consumed: number | null;
  avgConsumption: number | null;
  normConsumption: number | null;
  charged: number;
  paid: number;
  weight: number;
  errors: string[];
  warnings: string[];
  vehicleTitle: string;
  trailerTitle: string;
  periodLabel: string;
}

export function summarizeWaybill(waybill: Waybill): WaybillTotals {
  const trips = tripRepo.byWaybill(waybill.id).map(summarizeTrip);
  const refuelings = refuelRepo.byWaybill(waybill.id);
  const refueled = refuelings.reduce((s, r) => s + (r.volume ?? 0), 0);
  const vehicle = refs.vehicle(waybill.vehicle_id);
  const trailer = refs.vehicle(waybill.trailer_id);

  const mileage =
    waybill.odometer_in !== null && waybill.odometer_out !== null
      ? waybill.odometer_in - waybill.odometer_out
      : null;

  const consumed =
    waybill.fuel_in !== null && waybill.fuel_out !== null
      ? waybill.fuel_out + refueled - waybill.fuel_in
      : null;

  const avgConsumption =
    consumed !== null && mileage !== null && mileage > 0
      ? (consumed / mileage) * 100
      : null;

  const normConsumption =
    vehicle?.fuel_norm && mileage !== null ? (mileage * vehicle.fuel_norm) / 100 : null;

  const charged = trips.reduce((s, t) => s + t.amount, 0);
  const paid = financeRepo
    .byMonth(waybill.date_out.slice(0, 7))
    .filter((o) => o.kind === 'payment')
    .reduce((s, o) => s + o.amount, 0);
  const weight = trips.reduce((s, t) => s + t.totalWeight, 0);

  const errors: string[] = [];
  const warnings: string[] = [];

  if (waybill.odometer_in !== null && waybill.odometer_out !== null && waybill.odometer_in < waybill.odometer_out) {
    errors.push('Одометр при сдаче меньше одометра при выезде');
  }
  if (waybill.date_in && waybill.date_out && waybill.date_in < waybill.date_out) {
    errors.push('Дата сдачи раньше даты выезда');
  }
  if (mileage !== null && mileage > 2000) warnings.push('Пробег за лист больше 2000 км — проверьте одометр');
  if (consumed !== null && consumed < 0) warnings.push('Расход топлива получился отрицательным');
  if (waybill.status === 'closed' && (waybill.odometer_in === null || waybill.fuel_in === null)) {
    warnings.push('Лист закрыт без одометра или топлива при сдаче');
  }
  if (consumed !== null && normConsumption !== null && normConsumption > 0) {
    const diff = ((consumed - normConsumption) / normConsumption) * 100;
    if (diff > 15) warnings.push(`Перерасход топлива ${diff.toFixed(0)}% к норме`);
    if (diff < -15) warnings.push(`Экономия топлива ${Math.abs(diff).toFixed(0)}% к норме`);
  }
  for (const t of trips) {
    if (t.dateLoad && t.dateUnload && t.dateUnload < t.dateLoad) {
      errors.push(`Перевозка «${t.title}»: дата выгрузки раньше даты загрузки`);
    }
  }

  const vehicleTitle = vehicle ? `${vehicle.name}${vehicle.plate ? ' · ' + vehicle.plate : ''}` : 'Автомобиль не выбран';
  const trailerTitle = trailer ? `${trailer.name}${trailer.plate ? ' · ' + trailer.plate : ''}` : '';
  const periodLabel = waybill.date_in
    ? `${waybill.date_out} — ${waybill.date_in}`
    : `${waybill.date_out} — открыт`;

  return {
    waybill,
    trips,
    tripsCount: trips.length,
    mileage,
    refueled,
    refuelCount: refuelings.length,
    consumed,
    avgConsumption,
    normConsumption,
    charged,
    paid,
    weight,
    errors,
    warnings,
    vehicleTitle,
    trailerTitle,
    periodLabel,
  };
}

export interface FinanceSummary {
  charged: number;
  paid: number;
  balance: number;
}

export function summarizeFinance(month: string | null): FinanceSummary {
  const ops = month ? financeRepo.byMonth(month) : financeRepo.list();
  let charged = 0;
  let paid = 0;
  for (const o of ops) {
    if (o.kind === 'charge') charged += o.amount;
    else paid += o.amount;
  }
  return { charged, paid, balance: charged - paid };
}

/** Данные для автоподстановки при открытии нового путевого листа */
export function autoFillForNewWaybill(vehicleId: Id | null): {
  odometer_out: number | null;
  fuel_out: number | null;
  trailer_id: Id | null;
  vehicle_id: Id | null;
} {
  const last = waybillRepo.lastClosed(vehicleId);
  const link = vehicleId ? vehicleRepo.links(vehicleId)[0] : null;
  const openWaybill = waybillRepo.open()[0] ?? null;
  return {
    odometer_out: last?.odometer_in ?? null,
    fuel_out: last?.fuel_in ?? null,
    trailer_id: openWaybill?.trailer_id ?? link?.trailer_id ?? null,
    vehicle_id: vehicleId ?? last?.vehicle_id ?? null,
  };
}

/** Действующий период автомобиля */
export function activePeriodLabel(vehicleId: Id): string {
  const p = vehicleRepo.periods(vehicleId)[0];
  if (!p) return '';
  return p.end_date ? `${p.start_date} — ${p.end_date}` : `${p.start_date} — сейчас`;
}

export function monthFromDate(iso: string | null | undefined): string {
  return (iso ?? '').slice(0, 7);
}

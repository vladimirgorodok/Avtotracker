/** Действия над данными: закрытие листа, начисления, статусы перевозок. */

import { financeRepo, insertRow, nowIso, refuelRepo, refs, softDelete, softDeleteWhere, tripRepo, uid, updateRow, waybillRepo } from '../db/repo';
import { autoTripAmount, chargeNoteText } from './calc';
import { nowLocalIso, prevMonthKey, todayIso } from './format';
import type { AppSettings, Id, Refueling, Trip, Waybill } from '../types';

/** Пересчитать статус перевозки по её точкам. Все точки выполнены → 'done'. */
export function refreshTripStatus(tripId: Id): Trip | null {
  const trip = tripRepo.get(tripId);
  if (!trip) return null;
  const points = tripRepo.points(tripId);
  if (points.length === 0) {
    if (trip.status !== 'planned') updateRow('trips', tripId, { status: 'planned' });
    return tripRepo.get(tripId);
  }
  const allDone = points.every((p) => p.status === 'done');
  const next = allDone ? 'done' : 'planned';
  if (trip.status === 'charged') return trip;
  if (trip.status !== next) {
    updateRow('trips', tripId, { status: next });
    return tripRepo.get(tripId);
  }
  return trip;
}

/** Начислить по перевозке: создать финансовую операцию */
export function chargeTrip(tripId: Id, settings: AppSettings, amountOverride?: number): void {
  const trip = tripRepo.get(tripId);
  if (!trip) return;
  const points = tripRepo.points(tripId);
  const amount = amountOverride ?? trip.amount ?? autoTripAmount(settings, points.length);
  const existing = financeRepo.byTrip(tripId).filter((o) => o.kind === 'charge');

  const lastUnload = points.filter((p) => p.kind === 'unload').slice(-1)[0] ?? null;
  const date = lastUnload?.fact_date ?? todayIso();

  // В примечании сначала наименование поездки: погрузка → выгрузка
  const firstLoad = points.filter((p) => p.kind === 'load')[0] ?? null;
  const note = chargeNoteText(
    refs.place(firstLoad?.place_id ?? null)?.name ?? '',
    refs.place(lastUnload?.place_id ?? null)?.name ?? '',
  );

  if (existing.length > 0) {
    updateRow('finance_ops', existing[0].id, {
      amount,
      date,
      pay_month: date.slice(0, 7),
      // Примечание обновляем, только если его не правили руками
      ...(existing[0].auto ? { note } : {}),
    });
  } else {
    insertRow('finance_ops', {
      date,
      kind: 'charge',
      amount,
      pay_month: date.slice(0, 7),
      trip_id: tripId,
      waybill_id: trip.waybill_id,
      note,
      auto: 1,
    });
  }
  updateRow('trips', tripId, { status: 'charged', amount });
}

/** Снять начисление с перевозки */
export function unchargeTrip(tripId: Id): void {
  softDeleteWhere('finance_ops', 'trip_id = ? AND kind = ?', [tripId, 'charge']);
  updateRow('trips', tripId, { status: 'done' });
}

/** Пересчитать начисление по количеству точек, если сумма не задана вручную */
export function applyAutoAmount(tripId: Id, settings: AppSettings): void {
  const trip = tripRepo.get(tripId);
  if (!trip || trip.status === 'charged') return;
  const points = tripRepo.points(tripId);
  updateRow('trips', tripId, { amount: autoTripAmount(settings, points.length) });
}

export interface CloseResult {
  ok: boolean;
  message: string;
  charged: number;
}

/** Закрыть путевой лист: проставить дату сдачи, начислить по выполненным перевозкам */
export function closeWaybill(waybillId: Id, settings: AppSettings): CloseResult {
  const wb = waybillRepo.get(waybillId);
  if (!wb) return { ok: false, message: 'Путевой лист не найден', charged: 0 };
  if (wb.status === 'closed') return { ok: false, message: 'Лист уже закрыт', charged: 0 };
  if (!wb.date_in) return { ok: false, message: 'Укажите дату сдачи', charged: 0 };
  if (wb.odometer_in === null) return { ok: false, message: 'Укажите одометр при сдаче', charged: 0 };
  if (wb.odometer_out !== null && wb.odometer_in < wb.odometer_out) {
    return { ok: false, message: 'Одометр при сдаче меньше одометра при выезде', charged: 0 };
  }

  const trips = tripRepo.byWaybill(waybillId);
  let charged = 0;
  for (const t of trips) {
    const points = tripRepo.points(t.id);
    const allDone = points.length > 0 && points.every((p) => p.status === 'done');
    if (!allDone) continue;
    const amount = t.amount ?? autoTripAmount(settings, points.length);
    chargeTrip(t.id, settings, amount);
    charged += amount;
  }

  updateRow('waybills', waybillId, { status: 'closed', name: wb.name.includes('открыт') ? `${wb.date_out} — ${wb.date_in}` : wb.name });
  return { ok: true, message: 'Путевой лист закрыт', charged };
}

/** Открыть закрытый лист заново */
export function reopenWaybill(waybillId: Id): void {
  updateRow('waybills', waybillId, { status: 'open', date_in: null, odometer_in: null, fuel_in: null });
  for (const t of tripRepo.byWaybill(waybillId)) {
    if (t.status === 'charged') {
      softDeleteWhere('finance_ops', 'trip_id = ? AND kind = ?', [t.id, 'charge']);
      updateRow('trips', t.id, { status: 'done' });
    }
  }
}

/**
 * Что подставим при закрытии смены: дату сдачи, одометр и топливо. Вынесено
 * отдельно, чтобы вопрос перед закрытием показывал ровно те же цифры.
 */
export function closeShiftPreview(
  waybillId: Id,
): { dateIn: string; odometerIn: number | null; fuelIn: number | null } | null {
  const wb = waybillRepo.get(waybillId);
  if (!wb) return null;
  const prev = waybillRepo.lastClosed(wb.vehicle_id ?? null);
  const tripsCount = tripRepo.byWaybill(waybillId).length;
  let odometerIn = wb.odometer_in;
  if (odometerIn === null) {
    if (tripsCount > 0 && wb.odometer_out !== null) {
      // Пробег за лист считаем по перевозкам: примерно 1000 км на перевозку
      // (чаще две — тогда около 2000 км). Больше перевозок — больше и пробег.
      odometerIn = wb.odometer_out + tripsCount * 1000;
    } else if (prev) {
      // Перевозок ещё нет — опираемся на пробег прошлой смены
      const step =
        prev.odometer_in !== null && prev.odometer_out !== null ? prev.odometer_in - prev.odometer_out : null;
      odometerIn =
        step !== null && step > 0 ? (wb.odometer_out ?? prev.odometer_in ?? 0) + step : prev.odometer_in;
    }
  }
  const fuelIn = wb.fuel_in !== null ? wb.fuel_in : (prev?.fuel_in ?? null);
  return { dateIn: todayIso(), odometerIn, fuelIn };
}

/**
 * Закрыть смену одним движением: дату сдачи ставим сегодняшнюю, одометр при сдаче
 * считаем по числу перевозок (около 1000 км на перевозку), топливо — как в прошлой
 * смене. Если чего-то не хватает или цифры не сходятся — вернём подсказку, и
 * закрытие продолжится уже в карточке листа.
 */
export function closeShiftToday(waybillId: Id, settings: AppSettings): CloseResult {
  const preview = closeShiftPreview(waybillId);
  if (!preview) return { ok: false, message: 'Путевой лист не найден', charged: 0 };
  const patch: Partial<Waybill> = { date_in: preview.dateIn };
  if (preview.odometerIn !== null) patch.odometer_in = preview.odometerIn;
  if (preview.fuelIn !== null) patch.fuel_in = preview.fuelIn;

  updateRow('waybills', waybillId, patch);
  return closeWaybill(waybillId, settings);
}

/**
 * Быстрая заправка из открытой смены: дата — сейчас, источник — как в прошлый раз
 * (обычно бочка), лист — открытый. Водителю остаётся ввести только литры.
 */
export function quickRefuel(waybillId: Id | null, volume: number, kind: Refueling['kind'] = 'barrel'): Id {
  const id = uid();
  insertRow('refuelings', {
    id,
    waybill_id: waybillId,
    // Дата по местным часам: у водителя «сегодня» — это его календарь, а не UTC
    date: nowLocalIso(),
    volume,
    kind,
    station_id: null,
    note: '',
  });
  return id;
}

/** Последний источник топлива: подсказываем его в быстрой заправке */
export function lastRefuelKind(): Refueling['kind'] {
  const list = refuelRepo.list();
  return list[0]?.kind ?? 'barrel';
}

/**
 * Быстрое поступление денег: только сумма и отчисление в семью, дата — сегодня,
 * месяц оплаты — предыдущий (деньги обычно приходят за уже отработанный месяц).
 * Начислять ничего не нужно, это «пришли деньги».
 */
export function quickPayment(amount: number, family = 0, waybillId: Id | null = null): Id {
  const date = todayIso();
  const id = uid();
  insertRow('finance_ops', {
    id,
    date,
    kind: 'payment',
    amount,
    pay_month: prevMonthKey(),
    trip_id: null,
    waybill_id: waybillId,
    note: '',
    auto: 0,
    family,
  });
  return id;
}

/** Удалить перевозку вместе с точками */
export function deleteTrip(tripId: Id): void {
  softDeleteWhere('trip_points', 'trip_id = ?', [tripId]);
  softDeleteWhere('finance_ops', 'trip_id = ?', [tripId]);
  softDelete('trips', tripId);
}

/** Пересчитать номера точек по порядку */
export function renumberPoints(tripId: Id): void {  const points = tripRepo.points(tripId);
  points.forEach((p, i) => {
    if (p.seq !== i + 1) updateRow('trip_points', p.id, { seq: i + 1 });
  });
}

export function nextTripNumber(waybillId: Id): number {
  return tripRepo.byWaybill(waybillId).length + 1;
}

export function vehicleTitle(vehicleId: Id | null): string {
  const v = refs.vehicle(vehicleId);
  if (!v) return '—';
  return v.plate ? `${v.name} · ${v.plate}` : v.name;
}

export function stamp(): string {
  return nowIso();
}

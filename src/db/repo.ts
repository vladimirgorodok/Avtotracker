/**
 * Слой доступа к данным: обобщённые операции над таблицами
 * плюс типизированные выборки для экранов.
 */

import { dbSync } from './index';
import type {
  BaseRow,
  CargoType,
  Company,
  FinanceOp,
  FuelStation,
  Id,
  Place,
  Refueling,
  SettingRow,
  Trip,
  TripPoint,
  Vehicle,
  VehicleLink,
  VehiclePeriod,
  Waybill,
} from '../types';
import { DEFAULT_SETTINGS, type AppSettings } from '../types';

export function uid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && 'randomUUID' in c) return c.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function nowIso(): string {
  return new Date().toISOString();
}

type Row = Record<string, string | number | null>;

/** Преобразовать строку из SQLite в объект приложения */
function hydrate<T extends BaseRow>(raw: Record<string, unknown>): T {
  return raw as unknown as T;
}

export function listAll<T extends BaseRow>(table: string, order = 'created_at'): T[] {
  const rows = dbSync().all<Record<string, unknown>>(
    `SELECT * FROM ${table} WHERE deleted = 0 ORDER BY ${order}`,
  );
  return rows.map((r) => hydrate<T>(r));
}

export function listWhere<T extends BaseRow>(
  table: string,
  where: string,
  params: (string | number | null)[] = [],
  order = 'created_at',
): T[] {
  const rows = dbSync().all<Record<string, unknown>>(
    `SELECT * FROM ${table} WHERE deleted = 0 AND (${where}) ORDER BY ${order}`,
    params,
  );
  return rows.map((r) => hydrate<T>(r));
}

export function findById<T extends BaseRow>(table: string, id: Id): T | null {
  const row = dbSync().one<Record<string, unknown>>(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  return row ? hydrate<T>(row) : null;
}

export function insertRow(table: string, data: Record<string, unknown>): string {
  const id = (data.id as string) || uid();
  const ts = nowIso();
  const row: Row = { ...(data as Row), id, created_at: ts, updated_at: ts, deleted: 0 };
  const keys = Object.keys(row).filter((k) => row[k] !== undefined);
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  dbSync().run(sql, keys.map((k) => normalize(row[k])));
  return id;
}

export function updateRow(table: string, id: Id, data: Record<string, unknown>): void {
  const entries = Object.entries(data).filter(([k, v]) => v !== undefined && k !== 'id');
  if (entries.length === 0) return;
  const row: Row = Object.fromEntries(entries) as Row;
  row.updated_at = nowIso();
  const keys = Object.keys(row);
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  dbSync().run(sql, [...keys.map((k) => normalize(row[k])), id]);
}

export function softDelete(table: string, id: Id): void {
  dbSync().run(`UPDATE ${table} SET deleted = 1, updated_at = ? WHERE id = ?`, [nowIso(), id]);
}

export function softDeleteWhere(table: string, where: string, params: (string | number | null)[] = []): void {
  dbSync().run(`UPDATE ${table} SET deleted = 1, updated_at = ? WHERE ${where}`, [nowIso(), ...params]);
}

function normalize(v: unknown): string | number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v;
  return String(v);
}

export function countRows(table: string, where = '1=1', params: (string | number | null)[] = []): number {
  const row = dbSync().one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE deleted = 0 AND (${where})`,
    params,
  );
  return row ? Number(row.n) : 0;
}

/** Месяцы (ГГГГ-ММ), в которых есть данные — для фильтров по периоду */
export function usedMonths(): string[] {
  const rows = dbSync().all<{ m: string }>(
    `SELECT substr(date_out, 1, 7) AS m FROM waybills WHERE deleted = 0 AND length(date_out) >= 7
     UNION SELECT substr(date_in, 1, 7) FROM waybills WHERE deleted = 0 AND length(date_in) >= 7
     UNION SELECT substr(plan_date, 1, 7) FROM trip_points WHERE deleted = 0 AND length(plan_date) >= 7
     UNION SELECT substr(fact_date, 1, 7) FROM trip_points WHERE deleted = 0 AND length(fact_date) >= 7
     UNION SELECT substr(date, 1, 7) FROM refuelings WHERE deleted = 0 AND length(date) >= 7
     UNION SELECT substr(date, 1, 7) FROM finance_ops WHERE deleted = 0 AND length(date) >= 7`,
  );
  return rows
    .map((r) => r.m)
    .filter((m) => /^\d{4}-\d{2}$/.test(m))
    .sort((a, b) => b.localeCompare(a));
}

/** Сводка о базе для экрана обмена данными */
export function dbStats(): { total: number; schemaVersion: number; storage: string; sizeBytes: number } {
  const db = dbSync();
  const tables = [
    'vehicles',
    'vehicle_periods',
    'vehicle_links',
    'companies',
    'cargo_types',
    'fuel_stations',
    'places',
    'waybills',
    'trips',
    'trip_points',
    'refuelings',
    'finance_ops',
    'settings',
  ];
  let total = 0;
  for (const t of tables) total += countRows(t);
  return {
    total,
    schemaVersion: db.schemaVersion(),
    storage: db.storageDescription(),
    sizeBytes: db.export().length,
  };
}

/* ---------- Настройки ---------- */

export function getSettings(): AppSettings {
  const rows = dbSync().all<{ key: string; value: string }>(
    'SELECT key, value FROM settings WHERE deleted = 0',
  );
  const out: AppSettings = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    if (r.key in out) {
      const def = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[r.key];
      if (typeof def === 'number') (out as unknown as Record<string, unknown>)[r.key] = Number(r.value);
      else (out as unknown as Record<string, unknown>)[r.key] = r.value;
    }
  }
  return out;
}

export function setSetting(key: keyof AppSettings, value: string | number): void {
  const ts = nowIso();
  const str = String(value);
  dbSync().run(
    `INSERT INTO settings (key, value, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, deleted = 0`,
    [key, str, ts, ts],
  );
}

export function allSettings(): SettingRow[] {
  return dbSync().all<SettingRow>('SELECT * FROM settings WHERE deleted = 0');
}

/** Служебное значение в настройках (журнал переноса и т. п.), не входит в AppSettings */
export function putMeta(key: string, value: string): void {
  const ts = nowIso();
  dbSync().run(
    `INSERT INTO settings (key, value, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, deleted = 0`,
    [key, value, ts, ts],
  );
}

export function getMeta(key: string): string | null {
  const row = dbSync().one<{ value: string }>(
    'SELECT value FROM settings WHERE key = ? AND deleted = 0',
    [key],
  );
  return row ? row.value : null;
}

export function deleteMeta(key: string): void {
  dbSync().run(`UPDATE settings SET deleted = 1, updated_at = ? WHERE key = ?`, [nowIso(), key]);
}

/** Удалить пачку записей по списку идентификаторов (мягкое удаление) */
export function softDeleteMany(table: string, ids: Id[]): number {
  let n = 0;
  const ts = nowIso();
  const db = dbSync();
  db.tx(() => {
    for (const id of ids) {
      db.run(`UPDATE ${table} SET deleted = 1, updated_at = ? WHERE id = ? AND deleted = 0`, [ts, id]);
      n++;
    }
  });
  return n;
}

/** Очистить таблицу целиком */
export function clearTable(table: string): void {
  softDeleteWhere(table, '1=1');
}

/* ---------- Типизированные выборки ---------- */

export const refs = {
  vehicles: (kind?: 'tractor' | 'trailer') =>
    kind
      ? listWhere<Vehicle>('vehicles', 'kind = ?', [kind], 'name')
      : listAll<Vehicle>('vehicles', 'name'),
  companies: () => listAll<Company>('companies', 'name'),
  cargoTypes: () => listAll<CargoType>('cargo_types', 'name'),
  fuelStations: () => listAll<FuelStation>('fuel_stations', 'name'),
  places: () => listAll<Place>('places', 'name'),
  place: (id: Id | null) => (id ? findById<Place>('places', id) : null),
  company: (id: Id | null) => (id ? findById<Company>('companies', id) : null),
  cargoType: (id: Id | null) => (id ? findById<CargoType>('cargo_types', id) : null),
  station: (id: Id | null) => (id ? findById<FuelStation>('fuel_stations', id) : null),
  vehicle: (id: Id | null) => (id ? findById<Vehicle>('vehicles', id) : null),
};

export const waybillRepo = {
  list: () => listAll<Waybill>('waybills', 'date_out DESC'),
  get: (id: Id) => findById<Waybill>('waybills', id),
  open: () => listWhere<Waybill>('waybills', "status = 'open'", [], 'date_out DESC'),
  lastClosed: (vehicleId?: Id | null) => {
    const rows = vehicleId
      ? listWhere<Waybill>(
          'waybills',
          "status = 'closed' AND vehicle_id = ?",
          [vehicleId],
          'date_out DESC',
        )
      : listWhere<Waybill>('waybills', "status = 'closed'", [], 'date_out DESC');
    return rows[0] ?? null;
  },
};

export const tripRepo = {
  byWaybill: (waybillId: Id) => listWhere<Trip>('trips', 'waybill_id = ?', [waybillId], 'created_at'),
  get: (id: Id) => findById<Trip>('trips', id),
  all: () => listAll<Trip>('trips', 'created_at DESC'),
  points: (tripId: Id) =>
    listWhere<TripPoint>('trip_points', 'trip_id = ?', [tripId], 'seq, created_at'),
  point: (id: Id) => findById<TripPoint>('trip_points', id),
  pointsByWaybill: (waybillId: Id) =>
    dbSync()
      .all<Record<string, unknown>>(
        `SELECT p.* FROM trip_points p JOIN trips t ON t.id = p.trip_id
         WHERE p.deleted = 0 AND t.deleted = 0 AND t.waybill_id = ?
         ORDER BY p.seq`,
        [waybillId],
      )
      .map((r) => r as unknown as TripPoint),
};

export const refuelRepo = {
  list: () => listAll<Refueling>('refuelings', 'date DESC'),
  byWaybill: (waybillId: Id) =>
    listWhere<Refueling>('refuelings', 'waybill_id = ?', [waybillId], 'date'),
  get: (id: Id) => findById<Refueling>('refuelings', id),
};

export const financeRepo = {
  list: () => listAll<FinanceOp>('finance_ops', 'date DESC'),
  byMonth: (month: string) =>
    listWhere<FinanceOp>('finance_ops', 'pay_month = ?', [month], 'date'),
  get: (id: Id) => findById<FinanceOp>('finance_ops', id),
  byTrip: (tripId: Id) => listWhere<FinanceOp>('finance_ops', 'trip_id = ?', [tripId], 'date'),
};

export const vehicleRepo = {
  find: (id: Id) => findById<Vehicle>('vehicles', id),
  periods: (vehicleId: Id) =>
    listWhere<VehiclePeriod>('vehicle_periods', 'vehicle_id = ?', [vehicleId], 'start_date DESC'),
  links: (tractorId: Id) =>
    listWhere<VehicleLink>('vehicle_links', 'tractor_id = ?', [tractorId], 'start_date DESC'),
};

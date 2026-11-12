/**
 * Схема базы данных и миграции.
 * Версия хранится в PRAGMA user_version.
 */

export const SCHEMA_VERSION = 2;

const V1 = `
CREATE TABLE IF NOT EXISTS vehicles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  plate TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'tractor',
  brand TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  vin TEXT NOT NULL DEFAULT '',
  year TEXT NOT NULL DEFAULT '',
  fuel_norm REAL,
  note TEXT NOT NULL DEFAULT '',
  logo TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS vehicle_periods (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL,
  start_date TEXT NOT NULL DEFAULT '',
  end_date TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_vehicle_periods_vehicle ON vehicle_periods (vehicle_id);

CREATE TABLE IF NOT EXISTS vehicle_links (
  id TEXT PRIMARY KEY,
  tractor_id TEXT NOT NULL,
  trailer_id TEXT NOT NULL,
  start_date TEXT NOT NULL DEFAULT '',
  end_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_vehicle_links_tractor ON vehicle_links (tractor_id);

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  cargo_type_id TEXT,
  logo TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cargo_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS fuel_stations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  logo TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS places (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  company_id TEXT,
  address TEXT NOT NULL DEFAULT '',
  lat REAL,
  lon REAL,
  contact TEXT NOT NULL DEFAULT '',
  load_type TEXT,
  cargo_type_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_places_company ON places (company_id);

CREATE TABLE IF NOT EXISTS waybills (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  date_out TEXT NOT NULL DEFAULT '',
  odometer_out REAL,
  fuel_out REAL,
  date_in TEXT,
  odometer_in REAL,
  fuel_in REAL,
  vehicle_id TEXT,
  trailer_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_waybills_vehicle ON waybills (vehicle_id);
CREATE INDEX IF NOT EXISTS idx_waybills_date_out ON waybills (date_out);

CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY,
  waybill_id TEXT NOT NULL,
  cargo_type_id TEXT,
  weight REAL,
  amount REAL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_trips_waybill ON trips (waybill_id);

CREATE TABLE IF NOT EXISTS trip_points (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL DEFAULT 'load',
  place_id TEXT,
  plan_date TEXT,
  fact_date TEXT,
  load_type TEXT,
  cargo_type_id TEXT,
  weight REAL,
  status TEXT NOT NULL DEFAULT 'planned',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_trip_points_trip ON trip_points (trip_id);

CREATE TABLE IF NOT EXISTS refuelings (
  id TEXT PRIMARY KEY,
  waybill_id TEXT,
  date TEXT NOT NULL DEFAULT '',
  volume REAL NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'barrel',
  station_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_refuelings_waybill ON refuelings (waybill_id);

CREATE TABLE IF NOT EXISTS finance_ops (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'charge',
  amount REAL NOT NULL DEFAULT 0,
  pay_month TEXT,
  trip_id TEXT,
  waybill_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  auto INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_finance_ops_month ON finance_ops (pay_month);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  owner_table TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_attachments_owner ON attachments (owner_table, owner_id);

CREATE TABLE IF NOT EXISTS sync_log (
  id TEXT PRIMARY KEY,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  op TEXT NOT NULL DEFAULT 'upsert',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
`;

/** v2: миниатюры документов, чтобы списки открывались быстро */
const V2 = `
ALTER TABLE attachments ADD COLUMN thumb_path TEXT NOT NULL DEFAULT '';
`;

export const MIGRATIONS: string[] = [V1, V2];

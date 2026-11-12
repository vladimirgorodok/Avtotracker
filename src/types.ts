/**
 * Модель данных приложения «Автотрекер».
 * Все таблицы имеют общие поля: id, created_at, updated_at, deleted (мягкое удаление).
 * Мягкое удаление нужно, чтобы синхронизация с облаком могла передать факт удаления.
 */

export type Id = string;
export type Flag = 0 | 1;

export interface BaseRow {
  id: Id;
  created_at: string;
  updated_at: string;
  deleted: Flag;
}

/** Автомобиль: тягач или прицеп */
export type VehicleKind = 'tractor' | 'trailer';

export interface Vehicle extends BaseRow {
  name: string;
  plate: string;
  kind: VehicleKind;
  brand: string;
  model: string;
  vin: string;
  year: string;
  /** Норма расхода, л/100 км */
  fuel_norm: number | null;
  note: string;
  /** Логотип: data URL или ссылка */
  logo: string;
  archived: Flag;
}

/** Период использования автомобиля */
export interface VehiclePeriod extends BaseRow {
  vehicle_id: Id;
  start_date: string;
  /** Пусто — период активен */
  end_date: string | null;
  note: string;
}

/** Связка тягача и прицепа */
export interface VehicleLink extends BaseRow {
  tractor_id: Id;
  trailer_id: Id;
  start_date: string;
  end_date: string | null;
}

/** Фирма */
export interface Company extends BaseRow {
  name: string;
  cargo_type_id: Id | null;
  logo: string;
  note: string;
}

/** Тип загрузки */
export type LoadType = 'rear' | 'side' | 'top';

/** Место погрузки или выгрузки */
export interface Place extends BaseRow {
  name: string;
  company_id: Id | null;
  address: string;
  lat: number | null;
  lon: number | null;
  contact: string;
  load_type: LoadType | null;
  cargo_type_id: Id | null;
  note: string;
}

/** Тип груза */
export interface CargoType extends BaseRow {
  name: string;
  icon: string;
  note: string;
}

/** АЗС (сеть заправок) */
export interface FuelStation extends BaseRow {
  name: string;
  logo: string;
  note: string;
}

/** Путевой лист */
export type WaybillStatus = 'open' | 'closed';

export interface Waybill extends BaseRow {
  number: string;
  name: string;
  date_out: string;
  odometer_out: number | null;
  fuel_out: number | null;
  date_in: string | null;
  odometer_in: number | null;
  fuel_in: number | null;
  vehicle_id: Id | null;
  trailer_id: Id | null;
  note: string;
  status: WaybillStatus;
}

/** Точка маршрута: погрузка или выгрузка */
export type TripPointKind = 'load' | 'unload';
export type TripPointStatus = 'planned' | 'done';

export interface TripPoint extends BaseRow {
  trip_id: Id;
  /** Порядковый номер точки в маршруте, с 1 */
  seq: number;
  kind: TripPointKind;
  place_id: Id | null;
  plan_date: string | null;
  fact_date: string | null;
  load_type: LoadType | null;
  cargo_type_id: Id | null;
  weight: number | null;
  status: TripPointStatus;
  note: string;
}

/** Перевозка (поездка) */
export type TripStatus = 'planned' | 'done' | 'charged';

export interface Trip extends BaseRow {
  waybill_id: Id;
  cargo_type_id: Id | null;
  weight: number | null;
  /** Начислено за перевозку */
  amount: number | null;
  note: string;
  status: TripStatus;
}

/** Заправка */
export type RefuelKind = 'barrel' | 'station';

export interface Refueling extends BaseRow {
  waybill_id: Id | null;
  date: string;
  volume: number;
  kind: RefuelKind;
  station_id: Id | null;
  note: string;
}

/** Финансовая операция */
export type FinanceKind = 'charge' | 'payment';

export interface FinanceOp extends BaseRow {
  date: string;
  kind: FinanceKind;
  amount: number;
  /** Месяц оплаты в формате ГГГГ-ММ */
  pay_month: string | null;
  trip_id: Id | null;
  waybill_id: Id | null;
  note: string;
  /** 1 — создано автоматически при завершении перевозки */
  auto: Flag;
}

/** Настройки: ключ — значение. Отдельная таблица без id: первичный ключ — сам ключ. */
export interface SettingRow {
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
  deleted: Flag;
}

export interface AppSettings {
  base_amount: number;
  extra_point_amount: number;
  base_points: number;
  currency: string;
  theme: 'light' | 'dark';
  ai_base_url: string;
  ai_api_key: string;
  ai_model: string;
  supabase_url: string;
  supabase_key: string;
  supabase_email: string;
  supabase_user_id: string;
  supabase_access_token: string;
  supabase_refresh_token: string;
  /** Момент истечения токена доступа, ISO */
  supabase_expires_at: string;
  /** До какого момента локальные записи уже отправлены в облако */
  sync_pushed_at: string;
  /** До какого момента записи уже забраны из облака */
  sync_pulled_at: string;
  /** Время последней успешной синхронизации, ISO */
  sync_last_at: string;
  /** Текст последней ошибки синхронизации */
  sync_last_error: string;
  last_vehicle_id: string;
  last_trailer_id: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  base_amount: 10500,
  extra_point_amount: 1000,
  base_points: 2,
  currency: '',
  theme: 'light',
  ai_base_url: 'https://api.aitunnel.ru/v1',
  ai_api_key: '',
  ai_model: '',
  supabase_url: '',
  supabase_key: '',
  supabase_email: '',
  supabase_user_id: '',
  supabase_access_token: '',
  supabase_refresh_token: '',
  supabase_expires_at: '',
  sync_pushed_at: '',
  sync_pulled_at: '',
  sync_last_at: '',
  sync_last_error: '',
  last_vehicle_id: '',
  last_trailer_id: '',
};

export const LOAD_TYPES: { value: LoadType; label: string }[] = [
  { value: 'rear', label: 'Задняя' },
  { value: 'side', label: 'Боковая' },
  { value: 'top', label: 'Верхняя' },
];

export const REFUEL_KINDS: { value: RefuelKind; label: string }[] = [
  { value: 'barrel', label: 'Бочка' },
  { value: 'station', label: 'АЗС' },
];

export const FINANCE_KINDS: { value: FinanceKind; label: string }[] = [
  { value: 'charge', label: 'Начислено' },
  { value: 'payment', label: 'Поступило' },
];

export function loadTypeLabel(v: LoadType | null | undefined): string {
  return LOAD_TYPES.find((x) => x.value === v)?.label ?? '—';
}

export function refuelKindLabel(v: RefuelKind | null | undefined): string {
  return REFUEL_KINDS.find((x) => x.value === v)?.label ?? '—';
}

/** Список таблиц для экспорта и синхронизации */
export const TABLES = [
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
  'attachments',
] as const;

export type TableName = (typeof TABLES)[number];

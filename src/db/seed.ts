/** Первичное наполнение: настройки по умолчанию и базовые справочники. */

import { dbSync } from './index';
import { countRows, insertRow, setSetting, uid } from './repo';
import { DEFAULT_SETTINGS, type AppSettings } from '../types';

const SEED_CARGO = [
  'Грунт',
  'АБК',
  'Алкоголь',
  'Белок',
  'Бытовая техника',
  'Мебель',
  'Металлоконструкции',
  'Пиломатериалы',
  'Продукты',
  'Стройматериалы',
  'ТНП',
  'Щебень',
];

const SEED_STATIONS = [
  'Лукойл',
  'Газпромнефть',
  'Роснефть',
  'Татнефть',
  'Сургутнефтегаз',
  'Нефтьмагистраль',
  'General Fueller',
  'Two NP',
];

/** Заполнить настройки и справочники, если база пустая. Повторный вызов безопасен. */
export function seedIfEmpty(): void {
  const db = dbSync();

  if (countRows('settings') === 0) {
    db.tx(() => {
      for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        setSetting(key as keyof AppSettings, value);
      }
    });
  }

  if (countRows('cargo_types') === 0) {
    db.tx(() => {
      for (const name of SEED_CARGO) insertRow('cargo_types', { id: uid(), name, icon: '', note: '' });
    });
  }

  if (countRows('fuel_stations') === 0) {
    db.tx(() => {
      for (const name of SEED_STATIONS) insertRow('fuel_stations', { id: uid(), name, logo: '', note: '' });
    });
  }
}

/** Пример данных для знакомства с приложением (вызывается вручную из настроек) */
export function loadDemoData(): void {
  const db = dbSync();
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const daysAgo = (n: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() - n);
    return iso(d);
  };

  db.tx(() => {
    const cargo = dbSync().all<{ id: string; name: string }>(
      'SELECT id, name FROM cargo_types WHERE deleted = 0 ORDER BY name',
    );
    const grep = cargo.find((c) => c.name === 'Грунт')?.id ?? null;

    const company1 = insertRow('companies', { id: uid(), name: 'Пиндструп', cargo_type_id: grep, logo: '', note: '' });
    const company2 = insertRow('companies', { id: uid(), name: 'Маловасилевский ООО', cargo_type_id: grep, logo: '', note: '' });
    const company3 = insertRow('companies', { id: uid(), name: 'СВЯТОЙ ИСТОЧНИК', cargo_type_id: null, logo: '', note: '' });

    const place1 = insertRow('places', {
      id: uid(),
      name: 'Заплюсье',
      company_id: company1,
      address: 'Псковская область, Плюсский район, рабочий посёлок Заплюсье',
      lat: 58.422309,
      lon: 29.756465,
      contact: '',
      load_type: 'rear',
      cargo_type_id: grep,
      note: '',
    });
    const place2 = insertRow('places', {
      id: uid(),
      name: 'Малое Василево',
      company_id: company2,
      address: 'Тверская область, Кимрский район, деревня Малое Василево',
      lat: 57.0135,
      lon: 37.2581,
      contact: '',
      load_type: 'rear',
      cargo_type_id: grep,
      note: '',
    });
    const place3 = insertRow('places', {
      id: uid(),
      name: 'Глазово',
      company_id: company3,
      address: 'Тверская область, Глазово',
      lat: 56.9,
      lon: 35.9,
      contact: '',
      load_type: 'side',
      cargo_type_id: null,
      note: '',
    });

    const tractor = insertRow('vehicles', {
      id: uid(),
      name: 'SITRAK C7H 810',
      plate: 'C810TE198',
      kind: 'tractor',
      brand: 'SITRAK',
      model: 'C7H ZZ4186V391HE',
      vin: 'LZZ7CCWDXPC618033',
      year: '2023',
      fuel_norm: null,
      note: 'Грузовой седельный тягач, дизельный, цвет белый, экологический класс пятый',
      logo: '',
      archived: 0,
    });
    const trailer = insertRow('vehicles', {
      id: uid(),
      name: 'Schmitz Cargobull SCS 24',
      plate: 'BT016978',
      kind: 'trailer',
      brand: 'Schmitz',
      model: 'Cargobull SCS 24',
      vin: '',
      year: '',
      fuel_norm: null,
      note: '',
      logo: '',
      archived: 0,
    });

    insertRow('vehicle_periods', { id: uid(), vehicle_id: tractor, start_date: daysAgo(14), end_date: null, note: '' });
    insertRow('vehicle_periods', { id: uid(), vehicle_id: trailer, start_date: daysAgo(14), end_date: null, note: '' });
    insertRow('vehicle_links', { id: uid(), tractor_id: tractor, trailer_id: trailer, start_date: daysAgo(14), end_date: null });

    const settingsRow = dbSync().one<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'base_amount' AND deleted = 0",
    );
    const base = Number(settingsRow?.value ?? 10500);

    const wb1 = insertRow('waybills', {
      id: uid(),
      name: `${daysAgo(10)} — ${daysAgo(1)}`,
      date_out: daysAgo(10),
      odometer_out: 480216,
      fuel_out: 900,
      date_in: daysAgo(1),
      odometer_in: 481909,
      fuel_in: 1200,
      vehicle_id: tractor,
      trailer_id: trailer,
      status: 'closed',
      note: '',
    });
    insertRow('waybills', {
      id: uid(),
      name: `${daysAgo(1)} — открыт`,
      date_out: daysAgo(1),
      odometer_out: 481909,
      fuel_out: 1200,
      date_in: null,
      odometer_in: null,
      fuel_in: null,
      vehicle_id: tractor,
      trailer_id: trailer,
      status: 'open',
      note: '',
    });

    const trip1 = insertRow('trips', {
      id: uid(),
      waybill_id: wb1,
      cargo_type_id: grep,
      weight: 20000,
      amount: base,
      note: '',
      status: 'done',
    });
    insertRow('trip_points', {
      id: uid(),
      trip_id: trip1,
      seq: 1,
      kind: 'load',
      place_id: place1,
      plan_date: daysAgo(10),
      fact_date: daysAgo(10),
      load_type: 'rear',
      cargo_type_id: grep,
      weight: 20000,
      status: 'done',
      note: '',
    });
    insertRow('trip_points', {
      id: uid(),
      trip_id: trip1,
      seq: 2,
      kind: 'unload',
      place_id: place2,
      plan_date: daysAgo(9),
      fact_date: daysAgo(9),
      load_type: null,
      cargo_type_id: grep,
      weight: 20000,
      status: 'done',
      note: '',
    });

    const trip2 = insertRow('trips', {
      id: uid(),
      waybill_id: wb1,
      cargo_type_id: null,
      weight: 18000,
      amount: base,
      note: '',
      status: 'done',
    });
    insertRow('trip_points', {
      id: uid(),
      trip_id: trip2,
      seq: 1,
      kind: 'load',
      place_id: place3,
      plan_date: daysAgo(6),
      fact_date: daysAgo(6),
      load_type: 'side',
      cargo_type_id: null,
      weight: 18000,
      status: 'done',
      note: '',
    });
    insertRow('trip_points', {
      id: uid(),
      trip_id: trip2,
      seq: 2,
      kind: 'unload',
      place_id: place2,
      plan_date: daysAgo(5),
      fact_date: daysAgo(5),
      load_type: null,
      cargo_type_id: null,
      weight: 18000,
      status: 'done',
      note: '',
    });

    insertRow('refuelings', {
      id: uid(),
      waybill_id: wb1,
      date: `${daysAgo(9)}T14:31:00.000Z`,
      volume: 500,
      kind: 'barrel',
      station_id: null,
      note: '',
    });
    insertRow('refuelings', {
      id: uid(),
      waybill_id: wb1,
      date: `${daysAgo(8)}T04:12:00.000Z`,
      volume: 300,
      kind: 'station',
      station_id: dbSync().one<{ id: string }>(
        "SELECT id FROM fuel_stations WHERE name = 'General Fueller' AND deleted = 0",
      )?.id ?? null,
      note: '',
    });

    insertRow('finance_ops', {
      id: uid(),
      date: daysAgo(6),
      kind: 'charge',
      amount: 10500,
      pay_month: daysAgo(6).slice(0, 7),
      trip_id: trip1,
      waybill_id: wb1,
      note: 'Начислено за перевозку',
      auto: 1,
    });
    insertRow('finance_ops', {
      id: uid(),
      date: daysAgo(3),
      kind: 'charge',
      amount: 10500,
      pay_month: daysAgo(3).slice(0, 7),
      trip_id: trip2,
      waybill_id: wb1,
      note: 'Начислено за перевозку',
      auto: 1,
    });
  });
}

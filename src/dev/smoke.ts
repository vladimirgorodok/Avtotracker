/**
 * Проверка ядра приложения без телефона и браузера.
 * Запуск: npm run smoke
 *
 * Подменяет браузерные API (IndexedDB, document) и прогоняет основной сценарий:
 * справочники → путевой лист → перевозка с точками → автоначисление → экспорт/импорт.
 */

/* ---------- Подмена браузерного окружения ---------- */

class FakeRequest<T = unknown> {
  result: T | undefined;
  error: unknown = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
}

class FakeObjectStore {
  map: Map<string, unknown>;
  constructor(map: Map<string, unknown>) {
    this.map = map;
  }
  get(key: string) {
    const req = new FakeRequest<unknown>();
    req.result = this.map.get(key);
    queueMicrotask(() => req.onsuccess?.());
    return req;
  }
  put(value: unknown, key: string) {
    this.map.set(key, value);
    const req = new FakeRequest<unknown>();
    queueMicrotask(() => req.onsuccess?.());
    return req;
  }
  delete(key: string) {
    this.map.delete(key);
    const req = new FakeRequest<unknown>();
    queueMicrotask(() => req.onsuccess?.());
    return req;
  }
}

class FakeTransaction {
  map: Map<string, unknown>;
  constructor(map: Map<string, unknown>) {
    this.map = map;
  }
  objectStore() {
    return new FakeObjectStore(this.map) as unknown as IDBObjectStore;
  }
}

/** Хранилище общее для всех открытий — как настоящая база в браузере */
const fakeStores = new Map<string, Map<string, unknown>>();

class FakeDb {
  objectStoreNames = { contains: () => true };
  transaction(_name: string, _mode: string) {
    if (!fakeStores.has('files')) fakeStores.set('files', new Map());
    return new FakeTransaction(fakeStores.get('files')!) as unknown as IDBTransaction;
  }
}

const fakeIndexedDb = {
  open() {
    const req = new FakeRequest<IDBDatabase>() as unknown as IDBOpenDBRequest & { result: IDBDatabase };
    const db = new FakeDb() as unknown as IDBDatabase;
    (req as unknown as { result: IDBDatabase }).result = db;
    queueMicrotask(() => {
      (req as unknown as { onupgradeneeded?: () => void }).onupgradeneeded?.();
      (req as unknown as { onsuccess?: () => void }).onsuccess?.();
    });
    return req;
  },
};

const realFetch =
  typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;

/** В Node нет доступа к file://, а шрифты для PDF лежат именно там */
const fileFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('file://')) {
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(decodeURIComponent(url.replace('file://', '')));
    return new Response(buf, { status: 200 });
  }
  if (!realFetch) throw new Error('В этой среде нет сетевого доступа');
  return realFetch(input as RequestInfo, init);
};

const g = globalThis as unknown as Record<string, unknown>;
g.indexedDB = fakeIndexedDb;
g.document = {
  baseURI: `file://${process.cwd()}/public/`,
  documentElement: { dataset: {} as Record<string, string> },
  createElement: () => ({ click: () => {}, remove: () => {}, style: {} }),
  body: { appendChild: () => {} },
  addEventListener: () => {},
  visibilityState: 'visible',
};
g.fetch = fileFetch;
// window и navigator намеренно не подменяем: библиотека PDF в Node
// собирает документ другим способом и на заглушках падает.

/* ---------- Проверки ---------- */

let failed = 0;
let passed = 0;

function check(name: string, condition: boolean, extra = ''): void {
  if (condition) {
    passed++;
    console.log(`  ок   ${name}`);
  } else {
    failed++;
    console.log(`  ОШИБКА  ${name} ${extra}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, actual === expected, `(получено ${String(actual)}, ожидалось ${String(expected)})`);
}

async function main() {
  const { getDb, dbSync } = await import('../db');
  const repo = await import('../db/repo');
  const { seedIfEmpty } = await import('../db/seed');
  const { summarizeWaybill, summarizeTrip, autoTripAmount } = await import('../lib/calc');
  const { closeWaybill, chargeTrip } = await import('../lib/actions');
  const { dumpAll, importJson } = await import('../lib/backup');
  const { buildWaybillPdf, buildMonthReportPdf } = await import('../lib/backup');
  const { todayIso, fmtDate, fmtDateTime, parseCoords, monthLabel } = await import('../lib/format');
  const { documentSummary, listDocuments: listDocs, countDocuments: countDocs, renameDocument, deleteDocument } = await import('../lib/documents');

  const { useApp } = await import('../store');
  const db = await getDb();
  seedIfEmpty();
  useApp.getState().init();

  console.log('\n1. Схема и справочники');
  eq('версия схемы', db.schemaVersion(), 2);
  check('настройки созданы', repo.countRows('settings') > 0);
  check('грузы созданы', repo.countRows('cargo_types') >= 10);
  check('АЗС созданы', repo.countRows('fuel_stations') >= 8);
  eq('базовая сумма по умолчанию', repo.getSettings().base_amount, 10500);

  console.log('\n2. Начисление по точкам');
  const s = repo.getSettings();
  eq('2 точки', autoTripAmount(s, 2), 10500);
  eq('3 точки', autoTripAmount(s, 3), 11500);
  eq('5 точек', autoTripAmount(s, 5), 13500);
  eq('1 точка', autoTripAmount(s, 1), 10500);

  console.log('\n3. Путевой лист, перевозка, точки');
  const cargo = repo.refs.cargoTypes()[0];
  const company = repo.insertRow('companies', { name: 'Тестовая фирма', cargo_type_id: cargo.id, logo: '', note: '' });
  const placeA = repo.insertRow('places', {
    name: 'Склад А',
    company_id: company,
    address: 'Москва, складская 1',
    lat: 55.7,
    lon: 37.6,
    contact: '+79001234567',
    load_type: 'rear',
    cargo_type_id: cargo.id,
    note: '',
  });
  const placeB = repo.insertRow('places', { name: 'Склад Б', company_id: company, address: 'Тверь', lat: 56.8, lon: 35.9, contact: '', load_type: null, cargo_type_id: null, note: '' });

  const vehicleId = repo.insertRow('vehicles', {
    name: 'Тестовый тягач',
    plate: 'А123ВС77',
    kind: 'tractor',
    brand: 'Test',
    model: 'T1',
    vin: '',
    year: '2024',
    fuel_norm: 30,
    note: '',
    logo: '',
    archived: 0,
  });

  const waybillId = repo.insertRow('waybills', {
    number: '',
    name: `${todayIso()} — открыт`,
    date_out: todayIso(),
    odometer_out: 100000,
    fuel_out: 500,
    date_in: null,
    odometer_in: null,
    fuel_in: null,
    vehicle_id: vehicleId,
    trailer_id: null,
    status: 'open',
    note: '',
  });

  const tripId = repo.insertRow('trips', {
    waybill_id: waybillId,
    cargo_type_id: cargo.id,
    weight: 20000,
    amount: autoTripAmount(s, 2),
    note: '',
    status: 'planned',
  });

  const pointLoad = repo.insertRow('trip_points', {
    trip_id: tripId,
    seq: 1,
    kind: 'load',
    place_id: placeA,
    plan_date: todayIso(),
    fact_date: todayIso(),
    load_type: 'rear',
    cargo_type_id: cargo.id,
    weight: 20000,
    status: 'done',
    note: '',
  });
  const pointUnload = repo.insertRow('trip_points', {
    trip_id: tripId,
    seq: 2,
    kind: 'unload',
    place_id: placeB,
    plan_date: todayIso(),
    fact_date: todayIso(),
    load_type: null,
    cargo_type_id: cargo.id,
    weight: 20000,
    status: 'done',
    note: '',
  });

  let summary = summarizeTrip(repo.tripRepo.get(tripId)!);
  eq('точек в перевозке', summary.pointsCount, 2);
  eq('выполнено точек', summary.doneCount, 2);
  eq('маршрут', summary.title, 'Склад А → Склад Б');
  // Вес указывается у поездки; вес точек суммируется только если у поездки пусто.
  eq('вес по поездке', summary.totalWeight, 20000);
  eq('следующая точка', summary.nextPoint, null);
  repo.updateRow('trips', tripId, { weight: null });
  eq('вес по точкам как запасной вариант', summarizeTrip(repo.tripRepo.get(tripId)!).totalWeight, 40000);
  repo.updateRow('trips', tripId, { weight: 20000 });
  check('точки сохранены', Boolean(pointLoad && pointUnload));

  console.log('\n4. Заправки и расчёт топлива');
  repo.insertRow('refuelings', {
    waybill_id: waybillId,
    date: new Date().toISOString(),
    volume: 700,
    kind: 'barrel',
    station_id: null,
    note: '',
  });
  repo.insertRow('refuelings', {
    waybill_id: waybillId,
    date: new Date().toISOString(),
    volume: 300,
    kind: 'station',
    station_id: repo.refs.fuelStations()[0].id,
    note: '',
  });
  repo.updateRow('waybills', waybillId, { date_in: todayIso(), odometer_in: 101500, fuel_in: 600 });

  let totals = summarizeWaybill(repo.waybillRepo.get(waybillId)!);
  eq('пробег', totals.mileage, 1500);
  eq('заправлено всего', totals.refueled, 1000);
  eq('израсходовано', totals.consumed, 900);
  eq('средний расход', Math.round((totals.avgConsumption ?? 0) * 10) / 10, 60);
  eq('норма расхода', totals.normConsumption, 450);
  check('есть предупреждение о перерасходе', totals.warnings.some((w) => w.includes('Перерасход')));

  console.log('\n5. Контроль ошибок');
  repo.updateRow('waybills', waybillId, { odometer_in: 99000 });
  totals = summarizeWaybill(repo.waybillRepo.get(waybillId)!);
  check('одометр меньше предыдущего', totals.errors.some((e) => e.includes('Одометр при сдаче меньше')));
  repo.updateRow('waybills', waybillId, { odometer_in: 101500 });

  repo.updateRow('trip_points', pointUnload, { fact_date: '2000-01-01' });
  totals = summarizeWaybill(repo.waybillRepo.get(waybillId)!);
  check('выгрузка раньше загрузки', totals.errors.some((e) => e.includes('выгрузки раньше')));
  repo.updateRow('trip_points', pointUnload, { fact_date: todayIso() });

  console.log('\n6. Закрытие листа и автоначисление');
  const res = closeWaybill(waybillId, repo.getSettings());
  check('лист закрыт', res.ok, res.message);
  eq('начислено при закрытии', res.charged, 10500);
  eq('статус листа', repo.waybillRepo.get(waybillId)!.status, 'closed');
  eq('статус перевозки', repo.tripRepo.get(tripId)!.status, 'charged');
  const charges = repo.financeRepo.byTrip(tripId);
  eq('создана одна операция начисления', charges.length, 1);
  eq('сумма начисления', charges[0].amount, 10500);
  eq('месяц оплаты', charges[0].pay_month, todayIso().slice(0, 7));
  eq(
    'в примечании сначала наименование поездки',
    charges[0].note,
    'Склад А → Склад Б — начислено за перевозку',
  );

  const res2 = closeWaybill(waybillId, repo.getSettings());
  check('повторное закрытие отклонено', !res2.ok);
  eq('начислений по-прежнему одно', repo.financeRepo.byTrip(tripId).length, 1);

  console.log('\n7. Повторное начисление вручную');
  chargeTrip(tripId, repo.getSettings(), 12000);
  eq('сумма обновлена, а не продублирована', repo.financeRepo.byTrip(tripId)[0].amount, 12000);
  eq('всего операций', repo.financeRepo.byTrip(tripId).length, 1);
  eq(
    'примечание при повторном начислении прежнее',
    repo.financeRepo.byTrip(tripId)[0].note,
    'Склад А → Склад Б — начислено за перевозку',
  );

  // Правленное руками примечание автоматическое начисление не затирает
  repo.updateRow('finance_ops', charges[0].id, { note: 'Моё примечание', auto: 0 });
  chargeTrip(tripId, repo.getSettings(), 13000);
  eq('примечание, правленное руками, не затирается', repo.financeRepo.byTrip(tripId)[0].note, 'Моё примечание');
  repo.updateRow('finance_ops', charges[0].id, { auto: 1 });
  chargeTrip(tripId, repo.getSettings(), 12000);
  eq(
    'автоматическое примечание возвращается',
    repo.financeRepo.byTrip(tripId)[0].note,
    'Склад А → Склад Б — начислено за перевозку',
  );

  console.log('\n8. Финансы за месяц');
  const month = todayIso().slice(0, 7);
  repo.insertRow('finance_ops', { date: todayIso(), kind: 'payment', amount: 5000, pay_month: month, trip_id: null, waybill_id: null, note: 'Зарплата', auto: 0 });
  const { summarizeFinance } = await import('../lib/calc');
  const fin = summarizeFinance(month);
  eq('начислено за месяц', fin.charged, 12000);
  eq('оплачено за месяц', fin.paid, 5000);
  eq('остаток', fin.balance, 7000);

  console.log('\n9. Резервная копия: выгрузка и импорт');
  const dump = dumpAll();
  check('в выгрузке есть все таблицы', Object.keys(dump).length === 13);
  check('перевозка попала в выгрузку', dump.trips.some((t) => t.id === tripId));

  const backup = JSON.stringify({ app: 'avtobaza', version: 1, tables: dump, settings: [] });
  const jsonRes = importJson(backup);
  eq('импорт JSON: без дублей', jsonRes.inserted, 0);
  check('импорт JSON: совпадения пропущены', jsonRes.skipped > 0);

  const newPlace = { ...dump.places[0], id: 'imported-place-1', name: 'Импортированное место' };
  const jsonRes2 = importJson(JSON.stringify({ tables: { places: [newPlace] } }));
  eq('импорт JSON: новая запись добавлена', jsonRes2.inserted, 1);
  eq('импорт JSON: место доступно', repo.refs.place('imported-place-1')?.name, 'Импортированное место');

  const overwriteRes = importJson(
    JSON.stringify({ tables: { places: [{ ...newPlace, name: 'Обновлённое место' }] } }),
    true,
  );
  eq('импорт с обновлением', overwriteRes.updated, 1);
  eq('название обновилось', repo.refs.place('imported-place-1')?.name, 'Обновлённое место');

  console.log('\n10. PDF');
  const wbPdf = await buildWaybillPdf(waybillId, repo.getSettings());
  const wbHead = String.fromCharCode(...wbPdf.subarray(0, 5));
  eq('PDF листа начинается корректно', wbHead, '%PDF-');
  check('PDF листа не пустой', wbPdf.length > 8000, `(${wbPdf.length} байт)`);
  const wbText = new TextDecoder('latin1').decode(wbPdf);
  check('в PDF встроен шрифт с кириллицей', wbText.includes('DejaVu'));
  const monthPdf = await buildMonthReportPdf(month, repo.getSettings());
  eq('PDF отчёта начинается корректно', String.fromCharCode(...monthPdf.subarray(0, 5)), '%PDF-');
  check('PDF отчёта не пустой', monthPdf.length > 8000, `(${monthPdf.length} байт)`);

  console.log('\n11. Документы');
  const docId = repo.insertRow('attachments', {
    owner_table: 'waybills',
    owner_id: waybillId,
    title: 'Накладная №1',
    mime: 'image/jpeg',
    path: 'test-file.jpg',
    thumb_path: 'test-file.thumb.jpg',
    size: 12345,
  });
  const docs = countDocs('waybills', waybillId);
  eq('документов у листа', docs, 1);
  eq('документов у другой записи', countDocs('waybills', 'нет-такой'), 0);
  const docSummary = documentSummary();
  check('сводка по документам', docSummary.count >= 1 && docSummary.bytes >= 12345);
  renameDocument(docId, 'Накладная №1 (исправлено)');
  eq('подпись изменена', listDocs('waybills', waybillId)[0].title, 'Накладная №1 (исправлено)');
  deleteDocument(docId);
  eq('документ удалён', countDocs('waybills', waybillId), 0);

  console.log('\n12. Сохранение базы');
  await db.flush();
  check('база записана', db.export().length > 0);

  console.log('\n13. Утилиты');
  eq('формат даты', fmtDate('2026-11-12'), '12.11.2026');
  eq('координаты', JSON.stringify(parseCoords('56.001765,37.531211')), JSON.stringify({ lat: 56.001765, lon: 37.531211 }));
  eq('координаты с пробелом', JSON.stringify(parseCoords('56.001765 37.531211')), JSON.stringify({ lat: 56.001765, lon: 37.531211 }));
  eq('название месяца', monthLabel('2026-11'), 'Ноябрь 2026 г.');
  eq('дата без времени — без лишних часов', fmtDateTime('2026-11-11'), '11.11.2026');
  eq('дата со временем показывает часы', fmtDateTime('2026-11-11T15:37:00'), '11.11.2026, 15:37');

  console.log('\n14. ИИ-помощник');
  const {
    normalizeBaseUrl,
    buildDataContext,
    systemPrompt,
    localAnswer,
    answer,
    listModels,
    askModel,
    loadChat,
    saveChat,
    clearChat,
    keyShapeProblem,
    keyShape,
  } = await import('../lib/ai');
  const { createElement } = await import('react');
  const { renderToString } = await import('react-dom/server');
  const { MemoryRouter, Route, Routes } = await import('react-router-dom');

  eq('адрес без схемы и пути дополняется', normalizeBaseUrl('api.example.com'), 'https://api.example.com/v1');
  eq('адрес с путём не меняется', normalizeBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
  eq('пустой адрес остаётся пустым', normalizeBaseUrl('   '), '');

  const context = buildDataContext();
  check('сводка содержит ставки', context.includes('Ставки'));
  check('сводка содержит дату листа', context.includes(fmtDate(todayIso())));
  check('сводка содержит названия мест', context.includes('Склад А'));
  check('сводка содержит деньги', context.includes('начислено'));
  check('сводка содержит перевозки', context.includes('Склад А → Склад Б'));

  const sys = systemPrompt();
  check('системная подсказка описывает роль', sys.includes('АвтоБаза'));
  check('системная подсказка включает данные приложения', sys.includes('Склад А'));

  const moneyAnswer = localAnswer('сколько начислено за этот месяц');
  check('вопрос про деньги распознан', moneyAnswer !== null && moneyAnswer.includes('начислено'));
  const fuelAnswer = localAnswer('какой расход топлива');
  check('вопрос про расход распознан', fuelAnswer !== null && fuelAnswer.includes('расход'));
  const helloAnswer = localAnswer('привет');
  check('приветствие распознано', helloAnswer !== null && helloAnswer.includes('Здравствуйте'));
  const errorsAnswer = localAnswer('проверь листы на ошибки');
  check('проверка ошибок распознана', errorsAnswer !== null);
  eq('незнакомый вопрос не распознан', localAnswer('абракадабра зюйдвест'), null);

  await clearChat();
  eq('переписка изначально пуста', (await loadChat()).length, 0);
  await saveChat([{ role: 'user', text: 'привет', at: new Date().toISOString() }]);
  eq('переписка сохраняется', (await loadChat()).length, 1);
  await clearChat();
  eq('переписка очищается', (await loadChat()).length, 0);

  const offlineAnswer = await answer('сколько начислено за этот месяц', []);
  eq('без ключа ответ на устройстве', offlineAnswer.offline, true);
  check('без ключа ответ по делу', offlineAnswer.text.includes('начислено'));
  const unknownAnswer = await answer('абракадабра зюйдвест', []);
  eq('незнакомый вопрос тоже на устройстве', unknownAnswer.offline, true);
  check('подсказка про настройки', unknownAnswer.text.includes('настройках'));

  {
    const mod = await import('../pages/Assistant');
    const html = renderToString(
      createElement(
        MemoryRouter,
        { initialEntries: ['/assistant'] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: '/assistant',
            element: createElement(mod.default as never),
          }),
        ),
      ) as never,
    );
    check('ИИ-помощник собирается без ключа', html.length > 200 && html.includes('без ключа'));
  }

  // Проверяем обращения к сервису на подставных ответах — без настоящего ключа
  useApp.getState().saveSetting('ai_api_key', 'test-key');
  useApp.getState().saveSetting('ai_model', 'test-model');
  useApp.getState().saveSetting('ai_base_url', 'https://api.example.com');

  const originalFetch = globalThis.fetch;
  const netCalls: { url: string; init?: RequestInit }[] = [];
  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    netCalls.push({ url, init });
    if (url.endsWith('/models')) {
      return jsonResponse({ data: [{ id: 'b-model' }, { id: 'a-model' }, { id: 'a-model' }] });
    }
    if (url.endsWith('/chat/completions')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { stream?: boolean };
      if (body.stream) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"При"}}]}\n\n'));
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"вет"}}]}\n\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }
      return jsonResponse({ choices: [{ message: { content: 'Ответ модели' } }] });
    }
    return jsonResponse({ error: { message: 'Нет такого адреса' } }, 404);
  }) as unknown as typeof fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fakeFetch;

  try {
    const cfg = { baseUrl: 'https://api.example.com/v1', key: 'test-key', model: 'test-model' };

    const models = await listModels(cfg);
    eq('список моделей получен без повторов', models.length, 2);
    eq('модели отсортированы', models.join(','), 'a-model,b-model');

    const plain = await askModel(cfg, [{ role: 'user', content: 'вопрос' }]);
    eq('обычный ответ разобран', plain, 'Ответ модели');

    const call = netCalls[netCalls.length - 1];
    eq('адрес запроса', call.url, 'https://api.example.com/v1/chat/completions');
    eq('метод запроса', call.init?.method, 'POST');
    const headers = call.init?.headers as Record<string, string>;
    eq('ключ передан в заголовке', headers.Authorization, 'Bearer test-key');
    const sent = JSON.parse(String(call.init?.body)) as {
      model: string;
      stream: boolean;
      messages: { role: string; content: string }[];
    };
    eq('модель передана', sent.model, 'test-model');
    eq('поток выключен без обработчика', sent.stream, false);

    const seen: string[] = [];
    const streamed = await askModel(cfg, [{ role: 'user', content: 'вопрос' }], (_delta, full) => seen.push(full));
    eq('потоковый ответ собран', streamed, 'Привет');
    eq('куски приходят по мере готовности', seen.join('|'), 'При|Привет');

    const viaModel = await answer('вопрос по данным', [
      { role: 'user', text: 'ранее спрашивал', at: new Date().toISOString() },
    ]);
    eq('с ключом отвечает сервис', viaModel.offline, false);
    eq('текст ответа от модели', viaModel.text, 'Ответ модели');

    const lastSent = JSON.parse(String(netCalls[netCalls.length - 1].init?.body)) as {
      messages: { role: string; content: string }[];
    };
    eq('первое сообщение — системное', lastSent.messages[0].role, 'system');
    check('системное сообщение содержит данные', lastSent.messages[0].content.includes('АвтоБаза'));
    eq('история переписки передана', lastSent.messages[1].content, 'ранее спрашивал');
    eq('текущий вопрос передан последним', lastSent.messages[2].content, 'вопрос по данным');

    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () =>
      jsonResponse({ error: { message: 'bad key' } }, 401)) as unknown as typeof fetch;
    let errorText = '';
    try {
      await askModel(cfg, [{ role: 'user', content: 'x' }]);
    } catch (e) {
      errorText = e instanceof Error ? e.message : String(e);
    }
    check('понятная ошибка при неверном ключе', errorText.includes('Ключ отклонён сервисом') && errorText.includes('bad key'), errorText);
    check('подсказка про копирование ключа', errorText.includes('скопирован целиком'), errorText);

    // Ошибка сети вместо «Failed to fetch»
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    let netText = '';
    try {
      await listModels(cfg);
    } catch (e) {
      netText = e instanceof Error ? e.message : String(e);
    }
    check('понятная ошибка при недоступной сети', netText.includes('Сеть недоступна'), netText);

    eq('ключ без замечаний', keyShapeProblem('sk-aitunnel-1234567890abcdefghijklmnop'), '');
    check('пробел в ключе замечен', keyShapeProblem('sk-ait 123').includes('пробел'));
    check('ключ не того вида замечен', keyShapeProblem('abcdef1234567890').includes('sk-'));
    check('короткий ключ замечен', keyShapeProblem('sk-123').includes('короткий'));
    eq('пустой ключ без замечаний', keyShapeProblem('   '), '');
    eq('описание ключа показывает длину', keyShape('sk-aitunnel-1234'), 'введено 16 симв., начинается на «sk-aitun…»');
    eq('пустой ключ не описывается', keyShape('  '), '');
  } finally {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  }

  console.log('\n15. Экраны приложения');

  const firstId = (table: string): string =>
    dbSync().one<{ id: string }>(`SELECT id FROM ${table} WHERE deleted = 0 ORDER BY created_at LIMIT 1`)?.id ?? '';

  const vehicleRef = vehicleId;
  const refuelRef = firstId('refuelings');
  const financeRef = firstId('finance_ops');

  type Screen = {
    label: string;
    route: string;
    url: string;
    load: () => Promise<{ default: unknown }>;
    props?: Record<string, unknown>;
  };

  const screens: Screen[] = [
    { label: 'Главная', route: '/', url: '/', load: () => import('../pages/Home'), props: { onCreate: () => {} } },
    { label: 'Путевые листы', route: '/waybills', url: '/waybills', load: () => import('../pages/Waybills') },
    {
      label: 'Путевой лист',
      route: '/waybills/:id',
      url: `/waybills/${waybillId}`,
      load: () => import('../pages/WaybillDetail'),
    },
    { label: 'Перевозки', route: '/trips', url: '/trips', load: () => import('../pages/Trips') },
    { label: 'Перевозка', route: '/trips/:id', url: `/trips/${tripId}`, load: () => import('../pages/TripDetail') },
    { label: 'Заправки', route: '/refuelings', url: '/refuelings', load: () => import('../pages/Refuelings') },
    {
      label: 'Заправка',
      route: '/refuelings/:id',
      url: `/refuelings/${refuelRef}`,
      load: () => import('../pages/RefuelDetail'),
    },
    { label: 'Финансы', route: '/finance', url: '/finance', load: () => import('../pages/Finance') },
    {
      label: 'Финансовая операция',
      route: '/finance/:id',
      url: `/finance/${financeRef}`,
      load: () => import('../pages/FinanceDetail'),
    },
    { label: 'Автомобили', route: '/vehicles', url: '/vehicles', load: () => import('../pages/Vehicles') },
    {
      label: 'Автомобиль',
      route: '/vehicles/:id',
      url: `/vehicles/${vehicleRef}`,
      load: () => import('../pages/VehicleDetail'),
    },
    { label: 'Справочники', route: '/refs', url: '/refs', load: () => import('../pages/Refs') },
    { label: 'Обмен данными', route: '/data', url: '/data', load: () => import('../pages/Data') },
    { label: 'Ещё', route: '/more', url: '/more', load: () => import('../pages/More') },
    { label: 'Поиск по всему', route: '/search', url: '/search', load: () => import('../pages/Search') },
    { label: 'Настройки', route: '/settings', url: '/settings', load: () => import('../pages/Settings') },
    { label: 'ИИ-помощник', route: '/assistant', url: '/assistant', load: () => import('../pages/Assistant') },
  ];

  /** Каждый экран должен собираться без ошибок */
  for (const screen of screens) {
    try {
      const mod = await screen.load();
      const Comp = mod.default as unknown as (props: Record<string, unknown>) => unknown;
      const tree = createElement(
        MemoryRouter,
        { initialEntries: [screen.url] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: screen.route,
            element: createElement(Comp as never, (screen.props ?? {}) as never),
          }),
        ),
      );
      const html = renderToString(tree as never);
      check(`${screen.label}: экран собирается`, html.length > 60, `(${html.length} символов)`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      check(`${screen.label}: экран собирается`, false, msg);
    }
  }

  /** Заставка при запуске */
  try {
    const { Splash } = await import('../ui/Splash');
    const html = renderToString(createElement(Splash as never, { onDone: () => {} } as never) as never);
    check('Заставка: собирается', html.length > 400, `(${html.length} символов)`);
    check('Заставка: показывает название', html.includes('АвтоБаза'));
    check('Заставка: рисует фуру', html.includes('splash-truck-svg'));
    check('Заставка: есть полоса загрузки', html.includes('splash-bar'));
  } catch (e) {
    check('Заставка: собирается', false, e instanceof Error ? e.message : String(e));
  }

  /** Отступы системных панелей: приложение рисуется во весь экран (Android 15+) */
  try {
    const css = await (await fetch(`file://${process.cwd()}/src/styles.css`)).text();
    check('CSS читает отступы системных панелей', css.includes('var(--safe-area-inset-top'));
    check('Шапка отступает под строку состояния', css.includes('padding-top: calc(12px + var(--safe-top))'));
    check('Нижнее меню отступает от полосы жестов', css.includes('height: calc(var(--nav-h) + var(--safe-bottom))'));
    check('Подложка не шире экрана', css.includes('overflow-x: clip'));
    check('Подложка под цвет приложения', css.includes('html {\n  background: var(--bg);\n}'));
    check('Плашка не шире карточки', css.includes('max-width: 100%'));
    check('Длинная ссылка-плашка переносится', css.includes('a.badge') && css.includes('overflow-wrap: break-word'));
    check('Гамма по умолчанию — тёмно-синяя', css.includes('--brand: #0f4c81'));
    check('Есть бирюзовая гамма', css.includes("[data-palette='teal']"));
    check('Бирюзовая гамма перекрывает тёмную тему', css.includes("[data-theme='dark'][data-palette='teal']"));
    check(
      'Порядок блоков: бирюзовая идёт после тёмной темы',
      css.indexOf("[data-palette='teal']") > css.indexOf("[data-theme='dark']"),
    );
    check('Свечение берёт цвет из гаммы', css.includes('rgba(var(--brand-rgb)'));
    check('Заставка берёт фон из гаммы', css.includes('background: var(--splash-bg)'));
    check('Поле выбора — своя раскрывашка, а не <select>', css.includes('.select-trigger'));
    check('Раскрытый список выбора со своим фоном', css.includes('.select-menu'));
    check('В списке выбора видно логотип записи', css.includes('.opt-avatar'));
    check('В списке выбора есть поиск по буквам', css.includes('.select-search'));
  } catch (e) {
    check('CSS читает отступы системных панелей', false, e instanceof Error ? e.message : String(e));
  }

  console.log('\n15б. Оформление');
  {
    const { applyTheme } = await import('../store');
    const { DEFAULT_SETTINGS } = await import('../types');
    eq('гамма по умолчанию — тёмно-синяя', DEFAULT_SETTINGS.palette, 'navy');
    applyTheme('dark', 'teal');
    const root = (g.document as { documentElement: { dataset: Record<string, string> } }).documentElement;
    eq('тема попала в документ', root.dataset.theme, 'dark');
    eq('гамма попала в документ', root.dataset.palette, 'teal');
    applyTheme('light');
    eq('без явной гаммы — тёмно-синяя', root.dataset.palette, 'navy');
  }

  console.log('\n16. Текущая поездка: статусы, порядок и навигация');
  {
    const { refreshTripStatus } = await import('../lib/actions');
    const { sortTrips, summarizeTrip: summarize } = await import('../lib/calc');
    const { mapLink, addDays } = await import('../lib/format');

    const wb = repo.waybillRepo.list()[0]!;

    function makeTrip(statusValue: 'planned' | 'done' | 'charged', date: string, done: boolean) {
      const id = repo.insertRow('trips', {
        waybill_id: wb.id,
        cargo_type_id: null,
        weight: 15000,
        amount: 10500,
        note: '',
        status: statusValue,
      });
      repo.insertRow('trip_points', {
        trip_id: id,
        seq: 1,
        kind: 'load',
        place_id: null,
        plan_date: date,
        fact_date: done ? date : null,
        load_type: null,
        cargo_type_id: null,
        weight: null,
        status: done ? 'done' : 'planned',
        note: '',
      });
      return id;
    }

    const oldDone = makeTrip('done', '2026-01-10', true);
    const newPlanned = makeTrip('planned', '2026-11-12', false);
    const charged = makeTrip('charged', '2026-06-05', true);
    repo.insertRow('finance_ops', {
      date: '2026-06-05',
      kind: 'charge',
      amount: 10500,
      pay_month: '2026-06',
      trip_id: charged,
      waybill_id: wb.id,
      note: 'Начислено за перевозку',
      auto: 1,
    });

    const done = summarize(repo.tripRepo.get(oldDone)!);
    eq('законченная поездка считается выполненной', done.completed, true);
    eq('без начисления плашка «начислить»', done.charged, false);
    eq('у выполненной поездки нет следующей точки', done.nextPoint, null);

    const current = summarize(repo.tripRepo.get(newPlanned)!);
    eq('текущая поездка не выполнена', current.completed, false);
    eq('следующая точка найдена', current.nextPoint?.status, 'planned');
    eq('порядковый номер точки', current.nextPoint?.seq, 1);

    const withCharge = summarize(repo.tripRepo.get(charged)!);
    eq('начисленная поездка выполнена', withCharge.completed, true);
    eq('начисление найдено в финансах', withCharge.charged, true);

    const order = sortTrips([
      summarize(repo.tripRepo.get(oldDone)!),
      summarize(repo.tripRepo.get(charged)!),
      summarize(repo.tripRepo.get(newPlanned)!),
    ]);
    eq('текущая поездка выше законченных', order[0]?.trip.id, newPlanned);
    eq('свежая законченная выше старой', order[1]?.trip.id, charged);
    eq('самая старая внизу', order[2]?.trip.id, oldDone);

    // Точка, отмеченная «Выполнен», закрывает поездку
    const point = repo.tripRepo.points(newPlanned)[0]!;
    repo.updateRow('trip_points', point.id, { fact_date: todayIso(), status: 'done' });
    refreshTripStatus(newPlanned);
    eq('после всех точек поездка выполнена', repo.tripRepo.get(newPlanned)?.status, 'done');
    eq('следующей точки больше нет', summarize(repo.tripRepo.get(newPlanned)!).nextPoint, null);

    eq('выгрузка по умолчанию — на день позже', addDays('2026-11-12', 1), '2026-11-13');
    check('в браузере координаты ведут на Яндекс.Карты', mapLink(55.75, 37.61, 'Склад').includes('yandex.ru'));
    check('адрес без координат тоже открывает карту', mapLink(null, null, 'Москва, Ленина 1').includes('yandex.ru'));
  }

  console.log('\n17. Заявка из файлов: разбор, справочники и поездка');
  {
    const ord = await import('../lib/order');

    // Ответ модели приходит с текстом вокруг JSON и «человеческими» датами
    const parsed = ord.parseOrderJson(
      [
        'Вот что нашлось в заявке:',
        '```json',
        '{',
        '  "title": "Москва → Тверь",',
        '  "cargo": "Кирпич",',
        '  "weight": "20 000 кг",',
        '  "points": [',
        '    { "kind": "погрузка", "date": "12.11.2026", "company": "ООО «Тестовая фирма»", "place": "Склад А", "address": "Москва, складская 1" },',
        '    { "type": "выгрузка", "date": "13 ноября 2026", "place": "Новый склад", "address": "Тверь, Новая 5", "coords": "56.8, 35.9" }',
        '  ],',
        '  "missing": ["контакт на выгрузке"],',
        '  "comment": "Проверьте дату выгрузки"',
        '}',
        '```',
      ].join('\n'),
    );
    eq('название рейса разобрано', parsed.title, 'Москва → Тверь');
    eq('вес из текста стал числом', parsed.weight, 20000);
    eq('точек маршрута две', parsed.points.length, 2);
    eq('погрузка распознана', parsed.points[0]?.kind, 'load');
    eq('выгрузка распознана', parsed.points[1]?.kind, 'unload');
    eq('дата из заявки разобрана', parsed.points[0]?.date, '2026-11-12');
    eq('дата словами разобрана', parsed.points[1]?.date, '2026-11-13');
    eq('замечание модели сохранено', parsed.missing[0], 'контакт на выгрузке');

    // В сообщении для модели инструкция, текст файла и фото отдельной частью
    const msgs = ord.buildOrderMessages([
      { name: 'заявка.txt', kind: 'text', data: 'погрузка 12.11.2026', size: 20 },
      { name: 'заявка.jpg', kind: 'image', data: 'data:image/jpeg;base64,AAA', size: 3 },
    ]);
    const parts = msgs[1]?.content as { type: string; text?: string; image_url?: { url: string } }[];
    check(
      'фото уходит картинкой, а не текстом',
      parts.some((p) => p.type === 'image_url' && (p.image_url?.url ?? '').startsWith('data:image/jpeg')),
    );
    check('текстовый файл уходит текстом', parts.some((p) => p.type === 'text' && (p.text ?? '').includes('12.11.2026')));
    check('инструкция просит строгий JSON', parts.some((p) => (p.text ?? '').includes('"points"')));

    // Черновик: знакомые фирма и места узнаются по названию, адресу и координатам
    const draft = ord.buildDraft(parsed);
    eq('в черновике два места', draft.places.length, 2);
    const firstPlace = draft.places.find((p) => p.name === 'Склад А')!;
    eq('знакомое место предложено использовать', firstPlace.action, 'link');
    eq('знакомое место найдено в справочнике', firstPlace.linkId, placeA);
    check('сказано, по каким признакам нашли', firstPlace.reasons.length > 0);
    const secondPlace = draft.places.find((p) => p.name === 'Новый склад')!;
    eq('незнакомое название узнано по координатам', secondPlace.linkId, placeB);
    eq('порядок и связь мест сохранены', secondPlace.reasons.some((r) => r.includes('координаты')), true);
    eq('фирма узнана по названию', draft.companies[0]?.action, 'link');
    eq('фирма в заявке одна', draft.companies.length, 1);

    // Применение: поездка из заявки, точки по порядку, справочники не растут
    const tripsBefore = repo.tripRepo.all().length;
    const applied = ord.applyDraft(draft, useApp.getState().settings);
    eq('поездка создана', repo.tripRepo.all().length, tripsBefore + 1);
    eq('точек в поездке', repo.tripRepo.points(applied.tripId).length, 2);
    eq('фирма не задвоилась', applied.companiesAdded, 0);
    eq('места не задвоились', applied.placesAdded, 0);
    eq('вес заявки у поездки', repo.tripRepo.get(applied.tripId)?.weight, 20000);
    eq('начисление посчитано по точкам', repo.tripRepo.get(applied.tripId)?.amount, 10500);
    const newPoints = repo.tripRepo.points(applied.tripId);
    eq('первая точка — склад А', newPoints[0]?.place_id, placeA);
    eq('вторая точка — склад Б', newPoints[1]?.place_id, placeB);
    eq('порядок точек сохранён', newPoints[1]?.seq, 2);
    eq('точки пока в плане', newPoints[0]?.status, 'planned');
    eq('поездка пока в плане', repo.tripRepo.get(applied.tripId)?.status, 'planned');
    check('груз заявки добавлен в справочник', applied.cargoAdded);
    check('груз прописан в поездке', repo.tripRepo.get(applied.tripId)?.cargo_type_id !== null);
    check('итог создания понятен словами', ord.describeOrderResult(applied).includes('Поездка создана'));

    // Похожее место с пустыми полями — предлагаем не заводить заново, а дополнить
    const placeC = repo.insertRow('places', {
      name: 'Терминал Тест',
      company_id: null,
      address: '',
      lat: null,
      lon: null,
      contact: '',
      load_type: null,
      cargo_type_id: null,
      note: '',
    });
    const thin = ord.buildDraft(
      ord.parseOrderJson(
        JSON.stringify({
          cargo: '',
          points: [
            {
              kind: 'unload',
              place: 'Терминал Тест',
              address: 'Тверь, Терминальная 3',
              contact: '+78120000000',
              coords: '56.86, 35.91',
            },
          ],
        }),
      ),
    );
    eq('пустое место в справочнике предлагаем дополнить', thin.places[0]?.action, 'link');
    eq('перечислено, что допишем', thin.places[0]?.fill.join(' · '), 'Адрес · Контакт · Координаты');
    const filled = ord.applyDraft(thin, useApp.getState().settings);
    eq('место не задвоилось', filled.placesAdded, 0);
    eq('место дополнено', filled.placesFilled, 1);
    const terminal = repo.refs.place(placeC)!;
    eq('адрес дописан', terminal.address, 'Тверь, Терминальная 3');
    eq('контакт дописан', terminal.contact, '+78120000000');
    eq('координаты дописаны', terminal.lat, 56.86);

    // Совсем новые место и фирма — предлагаем добавить
    const fresh = ord.buildDraft(
      ord.parseOrderJson(
        JSON.stringify({
          cargo: '',
          points: [
            { kind: 'load', place: 'Казанский Терминал', address: 'Казань, Портовая 9', company: 'ООО Тестовый Завод' },
          ],
        }),
      ),
    );
    eq('незнакомое место предлагаем добавить', fresh.places[0]?.action, 'add');
    eq('незнакомую фирму предлагаем добавить', fresh.companies[0]?.action, 'add');
    const created = ord.applyDraft(fresh, useApp.getState().settings);
    eq('новое место добавлено', created.placesAdded, 1);
    eq('новая фирма добавлена', created.companiesAdded, 1);
    const added = repo.refs.places().find((p) => p.name === 'Казанский Терминал')!;
    eq('место привязано к новой фирме', repo.refs.company(added.company_id)?.name, 'ООО Тестовый Завод');
    eq('координат не выдумывали', added.lat, null);

    // Ручная правка названия пересчитывает предложение
    const rechecked = ord.recheckPlace({
      ...fresh.places[0]!,
      name: 'Склад А',
      address: 'Москва, складская 1',
      coords: '',
      action: 'add',
    });
    eq('после правки место узнано', rechecked.action, 'link');
    eq('после правки найден склад А', rechecked.linkId, placeA);

    // Пропущенное место не создаётся — точка остаётся без места
    const skipped = ord.applyDraft(
      { ...fresh, places: fresh.places.map((p) => ({ ...p, action: 'skip' as const })) },
      useApp.getState().settings,
    );
    eq('пропущенное место не добавлено', skipped.placesAdded, 0);
    eq('точка осталась без места', repo.tripRepo.points(skipped.tripId)[0]?.place_id, null);

    // Ответ без заявки не роняет экран, а объясняет причину
    let emptyError = '';
    try {
      ord.parseOrderJson('Извините, на фото ничего не разобрать');
    } catch (e) {
      emptyError = e instanceof Error ? e.message : '';
    }
    check('на пустом ответе понятная ошибка', emptyError.includes('заявку'));

    // Выбор фирмы вручную: список фирм пересобирается, решения не теряются
    const renamed = ord.syncCompanies({
      ...draft,
      places: draft.places.map((p, i) => (i === 0 ? { ...p, company: 'Тестовая фирма' } : p)),
    });
    eq('фирма из списка попала в черновик', renamed.companies.length, 1);
    eq('существующая фирма узнана', renamed.companies[0]?.action, 'link');
    eq('фирма привязана к справочнику', renamed.companies[0]?.linkId, company);
    const kept = ord.syncCompanies({
      ...renamed,
      companies: renamed.companies.map((c) => ({ ...c, action: 'skip' as const })),
    });
    eq('решение пользователя по фирме не сбрасывается', kept.companies[0]?.action, 'skip');
    const brandNew = ord.syncCompanies({
      ...draft,
      places: draft.places.map((p, i) => (i === 0 ? { ...p, company: 'Совсем Новая Фирма' } : p)),
    });
    eq('незнакомая фирма из списка — на добавление', brandNew.companies[0]?.action, 'add');

    // Ручная привязка места из справочника
    const linked = ord.linkPlaceTo(draft.places[0]!, repo.refs.place(placeB)!);
    eq('место привязано вручную', linked.linkId, placeB);
    eq('сказано, что выбрано вручную', linked.reasons[0], 'выбрано вручную');
    const emptyPlace = repo.insertRow('places', {
      name: 'Пустое место Тест',
      company_id: null,
      address: '',
      lat: null,
      lon: null,
      contact: '',
      load_type: null,
      cargo_type_id: null,
      note: '',
    });
    const toEmpty = ord.linkPlaceTo(
      { ...draft.places[0]!, address: 'Москва, Ленина 1', contact: '+70000000000', coords: '55.7, 37.6' },
      repo.refs.place(emptyPlace)!,
    );
    eq('для пустого места предложено дополнить', toEmpty.fill.join(', '), 'Адрес, Контакт, Координаты');

    // Разбор через помощника: ход работы виден по шагам, черновик собирается сразу
    const originalFetch20 = globalThis.fetch;
    const stages: string[] = [];
    const streamAnswer = JSON.stringify({
      title: 'Т',
      cargo: 'Кирпич',
      points: [{ kind: 'load', place: 'Склад А' }],
    });
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { stream?: boolean };
      if (!body.stream) {
        return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: streamAnswer } }] })}\n\n`),
          );
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const run = await ord.extractOrder(
        [{ name: 'заявка.txt', kind: 'text', data: 'загрузка склад А 12.11.2026', size: 26 }],
        (p) => stages.push(p.chars ? `${p.stage}:${p.chars}` : p.stage),
      );
      eq('черновик собран сразу при разборе', run.draft.points.length, 1);
      eq('место узнано при разборе', run.draft.places[0]?.linkId, placeA);
      eq('первый шаг — отправка', stages[0], 'sending');
      check('видно чтение ответа', stages.some((s) => s.startsWith('receiving:')));
      check('шаги идут по порядку', stages.includes('parsing') && stages[stages.length - 1] === 'matching');
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch20;
    }

    check('за раз принимается несколько файлов', ord.MAX_FILES >= 3);

    // Заявку можно не прикладывать файлом, а вписать текстом прямо на экране
    const manual = ord.textToAttachment('  15.11 погрузка Москва, склад Ромашка, кирпич 20 т  ');
    eq('вписанный текст уходит как текстовый источник', manual.kind, 'text');
    eq('лишние пробелы вокруг убраны', manual.data, '15.11 погрузка Москва, склад Ромашка, кирпич 20 т');
    eq('у текста своё имя', manual.name, 'Текст заявки');
    check('видно, что текст вписан, а не прочитан из файла', manual.manual === true);
    eq('очень длинный текст обрезается', ord.textToAttachment('я'.repeat(ord.MAX_TEXT + 500)).data.length, ord.MAX_TEXT);

    const manualParts = ord.buildOrderMessages([manual])[1]?.content as { type: string; text?: string }[];
    check(
      'текст заявки уходит помощнику целиком',
      manualParts.some((p) => p.type === 'text' && (p.text ?? '').includes('кирпич 20 т')),
    );
    check(
      'помощнику сказано, что это вписанный текст',
      manualParts.some((p) => (p.text ?? '').includes('вписанная текстом')),
    );
    check(
      'текст и файлы уходят вместе',
      ord
        .buildOrderMessages([manual, { name: 'заявка.txt', kind: 'text', data: 'ещё заявка', size: 10 }])
        .some((m) =>
          Array.isArray(m.content)
            ? (m.content as { text?: string }[]).some((p) => (p.text ?? '').includes('ещё заявка'))
            : false,
        ),
    );

    let emptyMessage = '';
    try {
      await ord.extractOrder([]);
    } catch (e) {
      emptyMessage = e instanceof Error ? e.message : '';
    }
    check('без файлов и без текста разбор не начинается', emptyMessage.includes('вставьте текст заявки'));

    {
      const mod = await import('../pages/OrderFromFiles');
      const html = renderToString(
        createElement(
          MemoryRouter,
          { initialEntries: ['/assistant/order'] },
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: '/assistant/order',
              element: createElement(mod.default as never),
            }),
          ),
        ) as never,
      );
      check(
        'экран «Заявка из файла» собирается',
        html.length > 200 && html.includes('Разобрать заявку'),
      );
      check('на экране есть приглашение приложить файлы', html.includes('Сфотографировать'));
      check('на экране есть окно для текста заявки', html.includes('Текст заявки') && html.includes('<textarea'));
    }
  }

  console.log('\n18. Настройки отдельным файлом');
  {
    const { buildSettingsFile, applySettingsFile } = await import('../lib/backup');
    const before = repo.getSettings();
    repo.setSetting('ai_api_key', 'test-key-123');
    repo.setSetting('ai_model', 'test-model');
    repo.setSetting('yadisk_login', 'test-login');
    repo.setSetting('base_amount', 12000);

    const text = buildSettingsFile();
    const payload = JSON.parse(text) as { kind?: string; settings: { key: string; value: string }[] };
    eq('файл помечен как настройки', payload.kind, 'settings');
    check(
      'в файле есть ключ ИИ',
      payload.settings.some((s) => s.key === 'ai_api_key' && s.value === 'test-key-123'),
    );
    check('в файле есть вход в Яндекс Диск', payload.settings.some((s) => s.key === 'yadisk_login'));
    check(
      'в файле есть ставки',
      payload.settings.some((s) => s.key === 'base_amount' && s.value === '12000'),
    );

    // «Переустановка»: настройки пустые, файл возвращает их
    repo.setSetting('ai_api_key', '');
    repo.setSetting('ai_model', '');
    repo.setSetting('yadisk_login', '');
    repo.setSetting('base_amount', 10500);
    const applied = applySettingsFile(text);
    check('настройки применены', applied >= 4, `(${applied})`);
    eq('ключ ИИ восстановлен', repo.getSettings().ai_api_key, 'test-key-123');
    eq('модель восстановлена', repo.getSettings().ai_model, 'test-model');
    eq('вход в Яндекс Диск восстановлен', repo.getSettings().yadisk_login, 'test-login');
    eq('ставка восстановлена', repo.getSettings().base_amount, 12000);

    // Через общий импорт: файл только с настройками не требует таблиц
    const viaImport = importJson(text);
    eq('импорт настроек не трогает данные', viaImport.inserted, 0);
    check('импорт настроек объясняет результат', viaImport.message.includes('настроек'));

    // Лишние ключи игнорируются, чужой файл — понятная ошибка
    const junk = JSON.stringify({
      kind: 'settings',
      settings: [
        { key: 'нет_такой_настройки', value: '1' },
        { key: 'ai_model', value: 'm2' },
      ],
    });
    eq('применяется только известное', applySettingsFile(junk), 1);
    eq('известное значение обновилось', repo.getSettings().ai_model, 'm2');
    let bad = '';
    try {
      applySettingsFile('{"tables":{}}');
    } catch (e) {
      bad = e instanceof Error ? e.message : '';
    }
    check('чужой файл отклонён с объяснением', bad.includes('настройки'));

    // Экран настроек: карточка переноса настроек на месте
    const mod = await import('../pages/Settings');
    const html = renderToString(
      createElement(
        MemoryRouter,
        { initialEntries: ['/settings'] },
        createElement(mod.default as never),
      ) as never,
    );
    check('в настройках есть сохранение в файл', html.includes('Сохранить настройки в файл'));
    check('в настройках есть загрузка из файла', html.includes('Загрузить настройки из файла'));

    // Вернуть исходные значения
    repo.setSetting('ai_api_key', before.ai_api_key);
    repo.setSetting('ai_model', before.ai_model);
    repo.setSetting('yadisk_login', before.yadisk_login);
    repo.setSetting('base_amount', before.base_amount);
  }

  console.log('\n19. Подбор логотипов и значков по названию');
  {
    const pics = await import('../lib/pictures');
    const { dataUrlToBytes } = await import('../lib/files');

    // Название: чистка, организационные формы, латиница
    eq('кавычки и скобки убраны', pics.cleanName('ООО «Ромашка» (Москва)'), 'ООО Ромашка Москва');
    eq('организационная форма убрана', pics.stripLegalForm('ООО «Ромашка»'), 'Ромашка');
    eq('латиница', pics.translit('Грузовик'), 'Gruzovik');
    const companyVariants = pics.nameVariants('Маловасилевский ООО', 'company');
    check('вариант без формы', companyVariants.includes('Маловасилевский'));
    check('вариант «ООО Название»', companyVariants.includes('ООО Маловасилевский'));
    check('вариант «Название ООО»', companyVariants.includes('Маловасилевский ООО'));
    check('вариант латиницей', companyVariants.includes('Malovasilevskiy'));
    check('вариантов несколько', companyVariants.length >= 4, `(${companyVariants.length})`);

    // Грузы: понятные всем наборам слова
    eq('груз по-английски', pics.englishWords('Цемент', 'cargo').join(','), 'cement');
    const cargoQuery = pics.localQuery('Кирпич', 'cargo');
    check('значок груза ищется и по-английски', cargoQuery.icon.includes('brick'));
    check('значок груза ищется и латиницей', cargoQuery.icon.includes('Kirpich'));
    check('для груза есть значок по умолчанию', cargoQuery.icon.includes('cargo box'));
    const companyQuery = pics.localQuery('ООО «Газпром»', 'company');
    eq('для значков первым идёт латиница', companyQuery.icon[0], 'Gazprom');
    eq('для интернета первым идёт «название + logo»', companyQuery.web[0], 'Газпром logo');
    check('варианты с «ООО» тоже проверяются', companyQuery.web.some((q) => q.includes('ООО')));
    eq('адрес сайта по названию', pics.guessDomain('ООО «Газпром»'), 'gazprom.ru');
    eq('адрес сайта приводится к виду', pics.cleanDomain('https://www.gazprom.ru/about?x=1'), 'gazprom.ru');
    eq('не адрес — пусто', pics.cleanDomain('нет такого'), '');

    // Ответ помощника: только JSON, мусор не ломает поиск
    const aiAnswer = pics.parsePictureQuery(
      '```json\n{"icon":["romashka"],"web":["romashka logo"],"domain":"romashka.ru","note":"Ромашка"}\n```',
    );
    eq('помощник понял название', aiAnswer?.icon[0], 'romashka');
    eq('помощник подсказал адрес', aiAnswer?.domain, 'romashka.ru');
    check('варианты от помощника помечены', aiAnswer?.byAi === true);
    eq('без JSON — ничего не понятно', pics.parsePictureQuery('Извините, не могу'), null);

    // Разбор источников
    const icons = pics.parseIconify({ icons: ['mdi:truck', 'logos:gazprom'] });
    eq('значки разобраны', icons.length, 2);
    eq('обычный значок', icons[0]?.kind, 'icon');
    eq('фирменный логотип', icons[1]?.kind, 'logo');
    check('ссылка на значок собрана', icons[0]?.url.includes('/mdi/truck.svg') === true);
    check('логотип крупнее значка', (icons[1]?.url.includes('height=256') ?? false) === true);

    const commons = pics.parseCommons({
      query: {
        pages: {
          '1': {
            title: 'File:Gazprom Neft - logo.png',
            imageinfo: [{ thumburl: 'https://thumb/gazprom.png', url: 'https://full/gazprom.png', width: 1200, mime: 'image/png' }],
          },
          '2': { title: 'File:Гимн.ogg', imageinfo: [{ url: 'https://x/a.ogg', width: 900, mime: 'audio/ogg' }] },
          '3': { title: 'File:Точка.png', imageinfo: [{ url: 'https://x/small.png', width: 20, mime: 'image/png' }] },
        },
      },
    });
    eq('из Викисклада взято только годное', commons.length, 1);
    eq('подпись без «File:» и расширения', commons[0]?.title, 'Gazprom Neft - logo');
    eq('логотип узнан по названию файла', commons[0]?.kind, 'logo');
    eq('берём уменьшенную копию', commons[0]?.thumb, 'https://thumb/gazprom.png');

    const favicons = pics.faviconHits('gazprom.ru');
    eq('значков сайта четыре', favicons.length, 4);
    check('есть значок от Яндекса', favicons.some((h) => h.source.includes('Яндекс')));
    check('есть значок от DuckDuckGo', favicons.some((h) => h.url.includes('duckduckgo')));
    eq('без адреса значков нет', pics.faviconHits('').length, 0);

    // Викиданные: официальный сайт и логотип фирмы
    const wikiSearch = pics.parseWikidataSearch({
      search: [{ id: 'Q3927', label: 'Газпром' }, { id: 'нет', label: 'мусор' }],
    });
    eq('запись Викиданных разобрана', wikiSearch.length, 1);
    eq('номер записи', wikiSearch[0]?.id, 'Q3927');
    const wikiEntity = pics.parseWikidataEntity(
      {
        entities: {
          Q3927: {
            claims: {
              P856: [{ mainsnak: { datavalue: { value: 'https://www.gazprom.ru/about' } } }],
              P154: [{ mainsnak: { datavalue: { value: 'File:Газпром лого.svg' } } }],
            },
          },
        },
      },
      'Q3927',
    );
    eq('официальный сайт из Викиданных', wikiEntity.domain, 'gazprom.ru');
    eq('файл логотипа из Викиданных', wikiEntity.logo, 'File:Газпром лого.svg');
    eq('пустая запись — без сайта и логотипа', pics.parseWikidataEntity({}, 'Q1').domain, '');
    check(
      'ссылка на логотип из Викисклада',
      pics.commonsFileUrl('File:Logo.svg').includes('Special:FilePath/Logo.svg?width=256'),
    );
    eq('без имени файла ссылки нет', pics.commonsFileUrl('File:'), '');

    const dupes = pics.dedupeHits([
      { id: 'a', title: 'a', source: 's', url: 'https://x/1.png', thumb: 'https://x/1.png', kind: 'icon' },
      { id: 'b', title: 'b', source: 's', url: 'http://X/1.png', thumb: 'http://X/1.png', kind: 'icon' },
      { id: 'c', title: 'c', source: 's', url: 'https://x/2.png', thumb: 'https://x/2.png', kind: 'photo' },
    ]);
    eq('одинаковые картинки схлопнуты', dupes.length, 2);
    const sorted = pics.sortHits([
      { id: 'p', title: 'p', source: 's', url: 'https://x/p.png', thumb: '', kind: 'photo' },
      { id: 'i', title: 'i', source: 's', url: 'https://x/i.svg', thumb: '', kind: 'icon' },
      { id: 'l', title: 'l', source: 's', url: 'https://x/l.png', thumb: '', kind: 'logo' },
      { id: 's', title: 's', source: 's', url: 'https://x/s.png', thumb: '', kind: 'logo', site: 'x.ru' },
    ]);
    eq('сначала логотипы, потом значки, потом фото', sorted.map((h) => h.kind).join(','), 'logo,logo,icon,photo');
    eq('значок сайта — последним из логотипов', sorted[1]?.id, 's');
    check('картинок показываем много', pics.MAX_HITS >= 10, `(${pics.MAX_HITS})`);

    // Поиск целиком: подставной интернет отвечает значками и Викискладом
    const originalFetch22 = globalThis.fetch;
    const stages: string[] = [];
    const fakeFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api.iconify.design')) {
        return new Response(JSON.stringify({ icons: ['logos:gazprom', 'mdi:truck'] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('commons.wikimedia.org')) {
        return new Response(
          JSON.stringify({
            query: {
              pages: {
                '1': {
                  title: 'File:Gazprom logo.png',
                  imageinfo: [{ thumburl: 'https://thumb/g.png', url: 'https://full/g.png', width: 800, mime: 'image/png' }],
                },
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('wbsearchentities')) {
        return new Response(JSON.stringify({ search: [{ id: 'Q3927', label: 'Газпром' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('wbgetentities')) {
        return new Response(
          JSON.stringify({
            entities: {
              Q3927: {
                claims: {
                  P856: [{ mainsnak: { datavalue: { value: 'https://www.gazprom.ru/' } } }],
                  P154: [{ mainsnak: { datavalue: { value: 'File:Gazprom logo.svg' } } }],
                },
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('chat/completions')) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"icon":["gazprom"],"web":["gazprom logo"],"domain":"gazprom.ru","note":"Газпром"}' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error('нет сети');
    }) as unknown as typeof fetch;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fakeFetch;

    try {
      const found = await pics.searchPictures({
        name: 'ООО «Газпром»',
        kind: 'company',
        cfg: null,
        onProgress: (p) => stages.push(p.stage),
      });
      check('картинки нашлись', found.hits.length >= 2, `(${found.hits.length})`);
      eq('первым идёт логотип', found.hits[0]?.kind, 'logo');
      check('видно, сколько нашлось', found.notes.some((n) => n.includes('Найдено картинок')));
      eq(
        'шаги поиска по порядку',
        stages.join(','),
        'variants,icons,icons,logos,logos,sites,sites,done',
      );
      eq('адрес сайта найден на устройстве', found.query.domain, 'gazprom.ru');
      check('логотип из Викиданных найден', found.hits.some((h) => h.source.includes('Викиданные')));
      check('значки сайта найдены', found.hits.some((h) => h.site === 'gazprom.ru'));
      check('без ключа варианты местные', found.query.byAi === false);

      // Помощник с ключом: варианты приходят от модели
      const aiFound = await pics.searchPictures({
        name: 'ООО «Газпром»',
        kind: 'company',
        cfg: { baseUrl: 'https://api.example/v1', key: 'sk-test', model: 'test-model' },
      });
      check('варианты от помощника использованы', aiFound.query.byAi === true);
      eq('запросы помощника первыми', aiFound.query.icon[0], 'gazprom');
      eq('пояснение помощника сохранено', aiFound.query.note, 'Газпром');

      // Викиданные подсказали другой адрес — ищем значки по нему и говорим об этом
      (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('wbsearchentities')) {
          return new Response(JSON.stringify({ search: [{ id: 'Q1', label: 'Газпром нефть' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('wbgetentities')) {
          return new Response(
            JSON.stringify({
              entities: {
                Q1: { claims: { P856: [{ mainsnak: { datavalue: { value: 'https://www.gazprom-neft.ru/' } } }] } },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error('нет сети');
      }) as unknown as typeof fetch;
      const other = await pics.searchPictures({ name: 'Газпром нефть', kind: 'company', cfg: null });
      check('значки сайта взяты с адреса из Викиданных', other.hits.some((h) => h.site === 'gazprom-neft.ru'));
      check('сказано, какой сайт найден', other.notes.some((n) => n.includes('gazprom-neft.ru')));

      // Один источник упал — поиск всё равно работает
      (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('api.iconify.design')) throw new Error('сеть недоступна');
        if (url.includes('commons.wikimedia.org')) {
          return new Response(
            JSON.stringify({
              query: {
                pages: {
                  '1': {
                    title: 'File:Gazprom logo.png',
                    imageinfo: [{ thumburl: 'https://thumb/g.png', url: 'https://full/g.png', width: 800, mime: 'image/png' }],
                  },
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error('нет сети');
      }) as unknown as typeof fetch;
      const partial = await pics.searchPictures({ name: 'Газпром', kind: 'company', cfg: null });
      check('при сбое значков картинки всё равно есть', partial.hits.length > 0);
      check('сказано, что значки не ответили', partial.notes.some((n) => n.includes('Наборы значков')));
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch22;
    }

    // Картинка из файла обратно в байты — так её сохраняют файлом
    const decoded = dataUrlToBytes('data:image/png;base64,AAAA');
    eq('data URL разобран', decoded?.bytes.length, 3);
    eq('вид картинки сохранён', decoded?.mime, 'image/png');

    // Экран подбора собирается
    const finderMod = await import('../pages/PictureFinder');
    const finderHtml = renderToString(
      createElement(
        MemoryRouter,
        { initialEntries: ['/assistant/pictures'] },
        createElement(finderMod.default as never),
      ) as never,
    );
    check('экран «Значки и логотипы» собирается', finderHtml.includes('Поиск картинки'));
    check('на экране есть выбор, куда поставить', finderHtml.includes('Куда поставить'));
    check('на экране есть кнопка поиска', finderHtml.includes('Найти'));
  }

  console.log('\n20. Логотипы и значки в списках выбора');
  {
    const { Select, SelectMenu } = await import('../ui/components');
    const { filterOptions, SELECT_SEARCH_FROM } = await import('../ui/select');
    const logo = 'data:image/png;base64,AAAA';
    const options = [
      { value: 'c1', label: 'ООО «Ромашка»', logo },
      { value: 'c2', label: 'ИП Петров' },
      { value: 'c3', label: 'ООО «Василёк»', logo, hint: 'Москва' },
    ];

    // Выбранная запись: название и логотип видны прямо в поле
    const closed = renderToString(
      createElement(Select as never, { value: 'c1', onChange: () => {}, options } as never) as never,
    );
    check('в поле видно название записи', closed.includes('ООО «Ромашка»'));
    check('в поле виден логотип записи', closed.includes(`src="${logo}"`));
    check('это не <select>: в него логотип не поставить', !closed.includes('<select'));
    const empty = renderToString(
      createElement(
        Select as never,
        { value: null, onChange: () => {}, options, placeholder: 'Не выбрана' } as never,
      ) as never,
    );
    check('без выбора видна подсказка', empty.includes('Не выбрана'));
    check('без выбора логотипа в поле нет', !empty.includes('opt-avatar'));

    // Раскрытый список: логотип у каждой записи, у остальных — место под него
    const menu = renderToString(
      createElement(
        SelectMenu as never,
        { value: 'c2', options, placeholder: 'Не выбрана', onPick: () => {} } as never,
      ) as never,
    );
    check('в списке видны все записи', options.every((o) => menu.includes(o.label)));
    check('в списке видны логотипы', menu.includes(`src="${logo}"`));
    eq('место под логотип есть у каждой строки', menu.split('opt-avatar').length - 1, options.length);
    check('подсказка записи видна', menu.includes('Москва'));
    check('выбранная запись помечена', menu.includes('is-active'));
    check('список помечен как список выбора', menu.includes('role="listbox"'));

    // Поиск по набору букв: список отбирается по названию и подсказке
    const many = Array.from({ length: 12 }, (_, i) => ({
      value: `v${i}`,
      label: `Фирма ${i}`,
      logo: i === 0 ? logo : '',
    }));
    eq('без букв виден весь список', filterOptions(many, '').length, many.length);
    eq('буквы отбирают записи', filterOptions(many, 'фирма 3').length, 1);
    eq('регистр не важен', filterOptions(many, 'ФИРМА').length, many.length);
    eq(
      'ищем и по подсказке записи',
      filterOptions([{ value: 'a', label: 'Ромашка', hint: 'Москва' }], 'москва').length,
      1,
    );
    eq('ничего не нашлось — пусто', filterOptions(many, 'ззз').length, 0);
    check('поиск стоит в длинных списках', SELECT_SEARCH_FROM <= many.length, `(с ${SELECT_SEARCH_FROM} записей)`);

    const longMenu = renderToString(
      createElement(
        SelectMenu as never,
        { value: null, options: many, placeholder: 'Не выбрана', onPick: () => {} } as never,
      ) as never,
    );
    check('в длинном списке есть поле поиска', longMenu.includes('select-search'));
    check('поле поиска подписано', longMenu.includes('Поиск по списку'));
    check('в коротком списке поиска нет', !menu.includes('select-search'));

    // Связка с экранами: в списках выбора справочников подставлен логотип записи.
    // Экраны читают запись по адресу в useEffect, а при сборке на сервере они не
    // выполняются, поэтому проверяем по исходникам экранов.
    const withPictures = [
      'pages/Refs.tsx',
      'pages/TripDetail.tsx',
      'pages/RefuelDetail.tsx',
      'pages/WaybillDetail.tsx',
      'pages/PictureFinder.tsx',
      'pages/OrderFromFiles.tsx',
      'ui/PlacePicker.tsx',
    ];
    let wired = 0;
    for (const file of withPictures) {
      const src = await (await fetch(`file://${process.cwd()}/src/${file}`)).text();
      if (src.includes('logo:')) wired++;
    }
    eq('логотипы подставлены во все списки выбора справочников', wired, withPictures.length);
  }

  console.log('\n21. Логотип в карточке записи');
  {
    const { PictureSearch } = await import('../ui/PictureSearch');
    const logo = 'data:image/png;base64,AAAA';
    const html = renderToString(
      createElement(
        PictureSearch as never,
        { initialName: 'Ромашка', showKind: false, current: logo, onPick: () => {} } as never,
      ) as never,
    );
    check('видно нынешнюю картинку записи', html.includes(`src="${logo}"`));
    check('сказано, что новая её заменит', html.includes('новая её заменит'));
    const empty = renderToString(
      createElement(
        PictureSearch as never,
        { initialName: 'Ромашка', showKind: false, onPick: () => {} } as never,
      ) as never,
    );
    check('без нынешней картинки подсказки нет', !empty.includes('новая её заменит'));
  }

  console.log('\n22. Экран «Ещё»: разделы переключателем');
  {
    const moreMod = await import('../pages/More');
    const html = renderToString(
      createElement(MemoryRouter, { initialEntries: ['/more'] }, createElement(moreMod.default as never)) as never,
    );
    check('виден переключатель разделов', html.includes('Данные') && html.includes('Сервисы'));
    check(
      'сначала показаны записи учёта со справочниками',
      html.includes('Путевые листы') && html.includes('Автомобили') && html.includes('Справочники'),
    );
    check('подсказка раздела на месте', html.includes('Поиск по всему, путевые листы, поездки'));
    check(
      'сервисы убраны во вторую половину',
      !html.includes('Обмен данными') && !html.includes('Значки и логотипы') && !html.includes('Настройки'),
    );
    check('в данных есть вход в общий поиск', html.includes('Поиск по всему'));
  }

  console.log('\n23. Поиск по всему');
  {
    const { globalSearch, SEARCH_KINDS } = await import('../lib/search');

    const empty = globalSearch('');
    eq('пустая строка — ничего не ищем', empty.total, 0);
    eq('пустая строка — пустой список', empty.hits.length, 0);

    const byPlate = globalSearch('а123вс');
    check('поиск по номеру машины находит технику', byPlate.byKind.vehicle >= 1, `(найдено ${byPlate.byKind.vehicle})`);
    check('и её путевой лист', byPlate.byKind.waybill >= 1);
    check(
      'находка техники ведёт в карточку',
      byPlate.hits.some((h) => h.kind === 'vehicle' && h.to === `/vehicles/${vehicleId}`),
    );

    const byPlace = globalSearch('склад б');
    check('поиск по месту находит само место', byPlace.hits.some((h) => h.kind === 'place' && h.title === 'Склад Б'));
    check('поиск по месту находит поездку', byPlace.hits.some((h) => h.kind === 'trip'));

    const byAddress = globalSearch('тверь');
    check('поиск по адресу находит место', byAddress.hits.some((h) => h.kind === 'place'));

    const byCompany = globalSearch('тестовая фирма');
    check(
      'поиск по фирме ведёт в справочник',
      byCompany.hits.some((h) => h.kind === 'company' && h.to === `/refs?tab=companies&id=${company}`),
    );
    eq('регистр не важен', globalSearch('ТЕСТОВАЯ ФИРМА').byKind.company, byCompany.byKind.company);

    const byNote = globalSearch('зарплата');
    check('поиск по заметке находит операцию', byNote.hits.some((h) => h.kind === 'finance'));

    const cargoName = repo.refs.cargoTypes()[0].name;
    check('поиск по грузу находит груз', globalSearch(cargoName).hits.some((h) => h.kind === 'cargo'));

    const stationName = repo.refs.fuelStations()[0].name;
    check('поиск по АЗС находит АЗС', globalSearch(stationName).hits.some((h) => h.kind === 'station'));

    const byVolume = globalSearch('700');
    check('поиск по литрам находит заправку', byVolume.hits.some((h) => h.kind === 'refueling'));

    const all = globalSearch('а');
    check(
      'у каждой находки есть название, уточнение и адрес',
      all.hits.every((h) => h.title.trim() !== '' && h.sub.trim() !== '' && h.to.startsWith('/')),
    );
    check('находки идут в порядке разделов', all.hits.length > 0);

    const limited = globalSearch('а', 1);
    eq('ограничение по разделу соблюдено', limited.hits.length, SEARCH_KINDS.filter((k) => limited.byKind[k.kind] > 0).length);
    check('общее число находок не меньше показанных', limited.total >= limited.hits.length);

    eq('чего нет — того не находим', globalSearch('жжжжж').total, 0);

    const searchMod = await import('../pages/Search');
    const html = renderToString(
      createElement(MemoryRouter, { initialEntries: ['/search'] }, createElement(searchMod.default as never)) as never,
    );
    check('экран поиска собирается', html.includes('Поиск по всему'));
    check('подсказка, что можно искать', html.includes('Начните вводить'));

    const homeMod = await import('../pages/Home');
    const homeHtml = renderToString(
      createElement(
        MemoryRouter,
        { initialEntries: ['/'] },
        createElement(homeMod.default as never, { onCreate: () => {} } as never),
      ) as never,
    );
    check(
      'на «Главной» поле поиска открывает общий поиск',
      homeHtml.includes('search-entry') && homeHtml.includes('Поиск по всему'),
    );
  }

  console.log('\n24. Порядок списков: свежие записи вверху');
  {
    // Финансы: раньше список за месяц шёл от старых к новым — это и было замечено
    const janOld = repo.insertRow('finance_ops', {
      date: '2026-01-05T10:00:00.000Z',
      kind: 'charge',
      amount: 100,
      pay_month: '2026-01',
      trip_id: null,
      waybill_id: null,
      note: 'Старая',
      auto: 0,
    });
    const janNew = repo.insertRow('finance_ops', {
      date: '2026-01-20T10:00:00.000Z',
      kind: 'charge',
      amount: 200,
      pay_month: '2026-01',
      trip_id: null,
      waybill_id: null,
      note: 'Новая',
      auto: 0,
    });
    const jan = repo.financeRepo.byMonth('2026-01');
    eq('финансы за месяц: свежая запись первая', jan[0]?.id, janNew);
    eq('финансы за месяц: старая запись последняя', jan[jan.length - 1]?.id, janOld);
    const allOps = repo.financeRepo.list();
    check(
      'финансы: свежая операция выше старой',
      allOps.findIndex((o) => o.id === janNew) < allOps.findIndex((o) => o.id === janOld),
    );

    // Записи одного дня: сверху та, что заведена позже
    const sameFirst = repo.insertRow('finance_ops', {
      date: '2026-02-01T10:00:00.000Z',
      kind: 'charge',
      amount: 1,
      pay_month: '2026-02',
      trip_id: null,
      waybill_id: null,
      note: 'Первая за день',
      auto: 0,
    });
    const sameSecond = repo.insertRow('finance_ops', {
      date: '2026-02-01T10:00:00.000Z',
      kind: 'charge',
      amount: 2,
      pay_month: '2026-02',
      trip_id: null,
      waybill_id: null,
      note: 'Вторая за день',
      auto: 0,
    });
    repo.updateRow('finance_ops', sameFirst, { created_at: '2026-02-01T10:00:00.000Z' });
    repo.updateRow('finance_ops', sameSecond, { created_at: '2026-02-01T11:00:00.000Z' });
    eq('в один день сверху запись, заведённая позже', repo.financeRepo.byMonth('2026-02')[0]?.id, sameSecond);

    // Заправки
    const refuelNew = repo.insertRow('refuelings', {
      waybill_id: waybillId,
      date: '2026-03-10T08:00:00.000Z',
      volume: 111,
      kind: 'barrel',
      station_id: null,
      note: 'Свежая',
    });
    const refuelOld = repo.insertRow('refuelings', {
      waybill_id: waybillId,
      date: '2026-03-01T08:00:00.000Z',
      volume: 222,
      kind: 'barrel',
      station_id: null,
      note: 'Старая',
    });
    const refuels = repo.refuelRepo.list();
    check(
      'заправки: свежая выше старой',
      refuels.findIndex((r) => r.id === refuelNew) < refuels.findIndex((r) => r.id === refuelOld),
    );

    // Путевые листы
    const wbOld = repo.insertRow('waybills', {
      number: '',
      name: 'Старый лист',
      date_out: '2026-01-02',
      vehicle_id: null,
      trailer_id: null,
      status: 'closed',
      note: '',
    });
    const wbNew = repo.insertRow('waybills', {
      number: '',
      name: 'Новый лист',
      date_out: '2026-01-30',
      vehicle_id: null,
      trailer_id: null,
      status: 'closed',
      note: '',
    });
    const waybills = repo.waybillRepo.list();
    check(
      'путевые листы: свежий выше старого',
      waybills.findIndex((w) => w.id === wbNew) < waybills.findIndex((w) => w.id === wbOld),
    );

    // Поездки внутри листа
    const tripOld = repo.insertRow('trips', {
      waybill_id: waybillId,
      cargo_type_id: null,
      weight: null,
      amount: 0,
      note: 'Старая',
      status: 'planned',
    });
    repo.updateRow('trips', tripOld, { created_at: '2026-01-01T10:00:00.000Z' });
    const tripNew = repo.insertRow('trips', {
      waybill_id: waybillId,
      cargo_type_id: null,
      weight: null,
      amount: 0,
      note: 'Свежая',
      status: 'planned',
    });
    repo.updateRow('trips', tripNew, { created_at: '2026-01-02T10:00:00.000Z' });
    const wbTrips = repo.tripRepo.byWaybill(waybillId);
    check(
      'поездки листа: свежая выше старой',
      wbTrips.findIndex((t) => t.id === tripNew) < wbTrips.findIndex((t) => t.id === tripOld),
    );

    // Документы карточки
    const docOld = repo.insertRow('attachments', {
      owner_table: 'waybills',
      owner_id: waybillId,
      title: 'Старый файл',
      mime: 'image/jpeg',
      path: 'a.jpg',
      thumb_path: 'a.thumb.jpg',
      size: 10,
    });
    repo.updateRow('attachments', docOld, { created_at: '2026-01-01T10:00:00.000Z' });
    const docNew = repo.insertRow('attachments', {
      owner_table: 'waybills',
      owner_id: waybillId,
      title: 'Свежий файл',
      mime: 'image/jpeg',
      path: 'b.jpg',
      thumb_path: 'b.thumb.jpg',
      size: 20,
    });
    repo.updateRow('attachments', docNew, { created_at: '2026-01-02T10:00:00.000Z' });
    const docsList = listDocs('waybills', waybillId);
    check(
      'документы: свежий файл выше старого',
      docsList.findIndex((d) => d.id === docNew) < docsList.findIndex((d) => d.id === docOld),
    );

    // Своя картинка файлом — кнопка рядом с результатами поиска
    const { PictureSearch } = await import('../ui/PictureSearch');
    const psHtml = renderToString(
      createElement(
        PictureSearch as never,
        { initialName: 'Ромашка', showKind: false, onPick: () => {} } as never,
      ) as never,
    );
    check('в подборе картинки есть кнопка «Из файла»', psHtml.includes('Из файла'));
    check('под кнопкой скрытое поле выбора файла', psHtml.includes('type="file"'));
    check('подписано, что это своя картинка', psHtml.includes('своя картинка вместо найденной'));
  }

  console.log('\n25. Яндекс Диск: данные отдельно, значки отдельно');
  {
    const webdav = await import('../lib/webdav');
    const disk = await import('../lib/yadisk');
    const { buildCloudData } = await import('../lib/backup');
    const { putBlob, getBlob, deleteBlob } = await import('../lib/files');

    // --- разбор ответов WebDAV
    const xml = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<d:multistatus xmlns:d="DAV:">',
      '<d:response><d:href>/avtobaza/</d:href><d:propstat><d:prop>',
      '<d:displayname>avtobaza</d:displayname>',
      '<d:resourcetype><d:collection/></d:resourcetype>',
      '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>',
      '<d:response><d:href>/avtobaza/%D0%A4%D0%B8%D1%80%D0%BC%D0%B0%20%D0%A0%D0%BE%D0%BC%D0%B0%D1%88%D0%BA%D0%B0.json</d:href>',
      '<d:propstat><d:prop>',
      '<d:displayname>Фирма Ромашка.json</d:displayname>',
      '<d:resourcetype/>',
      '<d:getcontentlength>1234</d:getcontentlength>',
      '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>',
      '</d:multistatus>',
    ].join('');
    const entries = webdav.parseMultiStatus(xml);
    eq('в ответе Диска два элемента', entries.length, 2);
    eq('папка распознана', entries[0]?.isDirectory, true);
    eq('файл распознан', entries[1]?.isDirectory, false);
    eq('размер файла прочитан', entries[1]?.size, 1234);
    eq('кириллица в имени раскодирована', entries[1]?.name, 'Фирма Ромашка.json');
    eq('путь без имени хоста', entries[1]?.path, '/avtobaza/Фирма Ромашка.json');
    eq('путь приводится к одному виду', webdav.normalizePath('//avtobaza///'), '/avtobaza');
    eq(
      'кириллица в адресе кодируется',
      webdav.encodePath('/avtobaza/фирма.json'),
      '/avtobaza/%D1%84%D0%B8%D1%80%D0%BC%D0%B0.json',
    );
    eq(
      'свободное место прочитано',
      webdav.parseQuota('<d:quota-available-bytes>10737418240</d:quota-available-bytes>'),
      10737418240,
    );
    eq('размер понятен человеку', webdav.humanSize(5 * 1024 * 1024), '5 МБ');
    eq(
      'логин с кириллицей не ломает заголовок',
      webdav.utf8ToBase64('иван:пароль'),
      Buffer.from('иван:пароль', 'utf8').toString('base64'),
    );
    eq('base64 обратно в байты', Array.from(webdav.base64ToBytes('AAAA')).join(','), '0,0,0');

    // --- настройки подключения
    const store = useApp.getState();
    store.saveSetting('yadisk_login', 'ivan@yandex.ru');
    store.saveSetting('yadisk_password', 'parol-prilozheniya');
    store.saveSetting('yadisk_folder', '/avtobaza');
    store.saveSetting('yadisk_keep', 2);
    store.saveSetting('yadisk_auto', 0);
    check('подключение считается настроенным', disk.cloudConfigured());
    eq('папка обмена', disk.folderPath(), '/avtobaza');
    const nameAt = new Date(2026, 10, 17, 18, 30, 5);
    eq('имя файла данных', disk.dataFileName(nameAt), 'avtobaza-2026-11-17_183005.json');
    eq('имя архива значков', disk.iconsFileName(nameAt), 'avtobaza-icons-2026-11-17_183005.zip');

    // --- файл данных: картинки в него не попадают
    const picCompany = repo.insertRow('companies', {
      name: 'Фирма с логотипом',
      logo: 'data:image/png;base64,AAAA',
      note: '',
    });
    repo.updateRow('companies', company, { logo: 'data:image/png;base64,BBBB' });
    const cloudPayload = JSON.parse(buildCloudData()) as {
      kind: string;
      tables: Record<string, Record<string, unknown>[]>;
    };
    eq('вид файла — облачные данные', cloudPayload.kind, 'cloud-data');
    const cloudCompanies = cloudPayload.tables.companies ?? [];
    check('данные в файле есть', cloudCompanies.length >= 2);
    eq(
      'картинка в файл данных не попала',
      String(cloudCompanies.find((c) => c.id === company)?.logo ?? ''),
      '',
    );
    check(
      'настройки в файл данных попали',
      (cloudPayload as unknown as { settings: { key: string }[] }).settings.some(
        (s) => s.key === 'yadisk_folder',
      ),
    );
    repo.updateRow('companies', picCompany, { logo: 'https://example.com/logo.png' });
    const withLink = JSON.parse(buildCloudData()) as {
      tables: Record<string, Record<string, unknown>[]>;
    };
    eq(
      'короткая ссылка на логотип остаётся в данных',
      String((withLink.tables.companies ?? []).find((c) => c.id === picCompany)?.logo ?? ''),
      'https://example.com/logo.png',
    );

    // --- архив значков: картинки и документы
    await putBlob('doc-28.jpg', new Uint8Array([1, 2, 3, 4]));
    const docId = repo.insertRow('attachments', {
      owner_table: 'companies',
      owner_id: company,
      title: 'Накладная',
      mime: 'image/jpeg',
      path: 'doc-28.jpg',
      thumb_path: '',
      size: 4,
    });
    const built = await disk.buildIconsArchive();
    check('архив значков собран', built !== null && built.bytes.length > 0);
    const archive = built?.bytes ?? new Uint8Array();
    const parsed = await disk.readIconsArchive(archive);
    check(
      'в описи архива есть картинка фирмы',
      parsed.manifest.pictures.some((p) => p.table === 'companies' && p.name === 'Тестовая фирма'),
    );
    check('в описи архива есть документ', parsed.manifest.documents.some((d) => d.id === docId));
    const rebuilt = await disk.buildIconsArchive();
    eq('отпечаток содержимого архива устойчив', rebuilt?.fingerprint, built?.fingerprint);
    const stats = disk.localPictureStats();
    check('картинки посчитаны', stats.pictures >= 1, `(${stats.pictures})`);
    check('видно, что у части записей значка нет', disk.hasMissingPictures());

    // --- картинки раскладываются по записям по названию
    dbSync().run('UPDATE companies SET logo = ? WHERE id = ?', ['', company]);
    await deleteBlob('doc-28.jpg');
    const restored = await disk.restoreIcons(archive);
    check(
      'картинка вернулась в свою запись',
      String(dbSync().one<{ logo: string }>('SELECT logo FROM companies WHERE id = ?', [company])?.logo ?? '').startsWith(
        'data:image/png',
      ),
    );
    eq('документ восстановлен', restored.documents, 1);
    eq('файл документа снова на месте', (await getBlob('doc-28.jpg'))?.length, 4);
    eq('записей без пары нет', restored.missing, 0);
    const again = await disk.restoreIcons(archive);
    eq('подобранные картинки повторно не затираются', again.pictures, 0);

    // --- полный обмен через подставной Яндекс Диск
    const files = new Map<string, Uint8Array>();
    const dirs = new Set<string>();
    const entryXml = (p: string, isDir: boolean, size: number): string => {
      const name = p.slice(p.lastIndexOf('/') + 1) || 'Диск';
      return (
        `<d:response><d:href>${encodeURI(p)}</d:href><d:propstat><d:prop>` +
        `<d:displayname>${name}</d:displayname>` +
        (isDir ? '<d:resourcetype><d:collection/></d:resourcetype>' : '<d:resourcetype/>') +
        `<d:getcontentlength>${size}</d:getcontentlength>` +
        '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>'
      );
    };
    const originalFetch28 = globalThis.fetch;
    const fakeDisk = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      const path = decodeURIComponent(url.replace(webdav.YADISK_HOST, '')) || '/';
      if (method === 'PROPFIND') {
        const children = [...dirs, ...files.keys()].filter(
          (p) => p !== path && p.startsWith(path === '/' ? '/' : `${path}/`) &&
            !p.slice(path === '/' ? 1 : path.length + 1).includes('/'),
        );
        const body =
          '<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">' +
          '<d:response><d:href>/</d:href><d:propstat><d:prop>' +
          '<d:quota-available-bytes>1073741824</d:quota-available-bytes>' +
          '</d:prop></d:propstat></d:response>' +
          (path !== '/' ? entryXml(path, true, 0) : '') +
          children.map((p) => entryXml(p, dirs.has(p), files.get(p)?.length ?? 0)).join('') +
          '</d:multistatus>';
        return new Response(body, { status: 207, headers: { 'Content-Type': 'application/xml' } });
      }
      if (method === 'MKCOL') {
        if (dirs.has(path)) return new Response(null, { status: 405 });
        dirs.add(path);
        return new Response(null, { status: 201 });
      }
      if (method === 'PUT') {
        const raw = init?.body;
        files.set(
          path,
          typeof raw === 'string' ? new TextEncoder().encode(raw) : new Uint8Array(raw as ArrayBuffer),
        );
        return new Response(null, { status: 201 });
      }
      if (method === 'DELETE') {
        files.delete(path);
        return new Response(null, { status: 204 });
      }
      const data = files.get(path);
      if (!data) return new Response(null, { status: 404 });
      return new Response(data.slice().buffer as ArrayBuffer, { status: 200 });
    }) as unknown as typeof fetch;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fakeDisk;

    try {
      const report = await disk.checkDisk('ivan@yandex.ru', 'parol-prilozheniya', '/avtobaza/vnyat');
      check('проверка подключения сообщает о свободном месте', report.includes('Свободно'));
      check('папка обмена создана вместе с родительской', dirs.has('/avtobaza/vnyat'));

      files.set('/avtobaza/avtobaza-2020-01-01_000000.json', new TextEncoder().encode('{}'));
      files.set('/avtobaza/avtobaza-2020-01-02_000000.json', new TextEncoder().encode('{}'));
      files.set('/avtobaza/avtobaza-2020-01-03_000000.json', new TextEncoder().encode('{}'));
      const push = await disk.pushToDisk();
      check('файл данных выгружен', files.has(`/avtobaza/${push.dataName}`), push.dataName);
      check(
        'архив значков выгружен',
        push.iconsName !== null && files.has(`/avtobaza/${push.iconsName}`),
      );
      eq('после выгрузки изменений нет', disk.cloudState().dirty, false);
      eq(
        'старые копии удалены, свежие остались',
        [...files.keys()].filter((p) => p.endsWith('.json')).sort().join(','),
        `/avtobaza/avtobaza-2020-01-03_000000.json,/avtobaza/${push.dataName}`,
      );
      const uploaded = new TextDecoder().decode(files.get(`/avtobaza/${push.dataName}`)!);
      check('в облаке лёгкий файл без картинок', !uploaded.includes('data:image'));

      // Значки не менялись — второй раз архив не гоняем (он бывает тяжёлым)
      const zipCount = () => [...files.keys()].filter((p) => p.endsWith('.zip')).length;
      const before = zipCount();
      const pushAgain = await disk.pushToDisk();
      eq('неизменённый архив значков повторно не выгружается', pushAgain.iconsName, null);
      eq('архивов значков в облаке столько же', zipCount(), before);
      repo.updateRow('companies', company, { logo: 'data:image/png;base64,CCCC' });
      const pushChanged = await disk.pushToDisk();
      check('изменённые значки выгружаются заново', pushChanged.iconsName !== null);
      check('изменённый архив лёг в облако', files.has(`/avtobaza/${pushChanged.iconsName}`));

      // Другое устройство: данных нет, картинок нет — всё приходит из облака
      dbSync().run('UPDATE companies SET logo = ? WHERE id = ?', ['', company]);
      await deleteBlob('doc-28.jpg');
      const pull = await disk.pullFromDisk(false);
      eq('имя загруженного файла', pull.dataName, pushChanged.dataName);
      check('записи из облака обновились', pull.inserted + pull.updated > 0);
      check(
        'картинка подтянулась из архива',
        String(dbSync().one<{ logo: string }>('SELECT logo FROM companies WHERE id = ?', [company])?.logo ?? '').startsWith(
          'data:image/png',
        ),
      );
      eq('документ подтянулся вместе с данными', (await getBlob('doc-28.jpg'))?.length, 4);
      eq('после загрузки изменений нет', disk.cloudState().dirty, false);

      // Значки отдельно от данных
      dbSync().run('UPDATE companies SET logo = ? WHERE id = ?', ['', company]);
      const iconFiles = await disk.listIconsFiles();
      check('архивы значков видны отдельно', iconFiles.length >= 1);
      const iconsOnly = await disk.restoreIconsFromDisk();
      eq('значки подтянулись отдельной кнопкой', iconsOnly.pictures, 1);
      const upIcons = await disk.pushIconsOnly();
      check('значки выгружаются отдельной кнопкой', upIcons !== null && files.has(`/avtobaza/${upIcons}`));

      // Ошибка доступа объясняется понятными словами
      (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () =>
        new Response(null, { status: 401 })) as unknown as typeof fetch;
      let denied = '';
      try {
        await disk.pushToDisk();
      } catch (e) {
        denied = e instanceof Error ? e.message : String(e);
      }
      check('про неверный пароль сказано понятно', denied.includes('не принял логин или пароль'), denied);
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch28;
    }

    // --- экраны
    const ydMod = await import('../pages/YandexDisk');
    const ydHtml = renderToString(
      createElement(
        MemoryRouter,
        { initialEntries: ['/yadisk'] },
        createElement(ydMod.default as never),
      ) as never,
    );
    check('объяснено, что данные и значки лежат отдельно', ydHtml.includes('хранятся в облаке отдельно'));
    check('подписано поле пароля приложения', ydHtml.includes('Пароль приложения'));
    check(
      'в инструкции есть ссылка на пароли приложений',
      ydHtml.includes('id.yandex.ru/security/app-passwords'),
    );
    check('про тип пароля сказано', ydHtml.includes('WebDAV-клиент для Яндекс Диска'));
    check('есть выгрузка данных', ydHtml.includes('Выгрузить данные'));
    check('есть загрузка данных', ydHtml.includes('Загрузить данные из облака'));
    check('есть выгрузка значков', ydHtml.includes('Выгрузить значки'));
    check('есть подтягивание значков', ydHtml.includes('Подтянуть значки из облака'));

    const settingsHtml = renderToString(
      createElement(
        MemoryRouter,
        { initialEntries: ['/settings'] },
        createElement((await import('../pages/Settings')).default as never),
      ) as never,
    );
    check('в настройках есть вход в Яндекс Диск', settingsHtml.includes('Настроить Яндекс Диск'));

    // --- родная часть для Android: без неё методы WebDAV на телефоне не отправить
    const { readFileSync } = await import('node:fs');
    const pluginJava = readFileSync(
      'android/app/src/main/java/ru/avtobaza/app/WebDavPlugin.java',
      'utf8',
    );
    check(
      'родной обработчик назван так, как его зовёт приложение',
      pluginJava.includes('@CapacitorPlugin(name = "WebDav")'),
    );
    check(
      'родной обработчик отправляет любые методы (OkHttp)',
      pluginJava.includes('okhttp3') && pluginJava.includes('builder.method(method, body)'),
    );
    check('для PROPFIND подставляется тело запроса', pluginJava.includes('PROPFIND_BODY'));
    check(
      'ответ разбирается и текстом, и в base64',
      pluginJava.includes('Base64.encodeToString') && pluginJava.includes('responseBody.string()'),
    );
    const activityJava = readFileSync(
      'android/app/src/main/java/ru/avtobaza/app/MainActivity.java',
      'utf8',
    );
    check('обработчик подключён к приложению', activityJava.includes('registerPlugin(WebDavPlugin.class)'));
    const appGradle = readFileSync('android/app/build.gradle', 'utf8');
    check('клиент OkHttp добавлен в сборку', appGradle.includes('com.squareup.okhttp3:okhttp'));
    const nativeMod = await import('../lib/native-webdav');
    check('в браузере родного обработчика нет', nativeMod.nativeWebDavReady() === false);
  }

  console.log('\n26. Защита данных: копия базы и пустая выгрузка');
  {
    const storage = await import('../db/storage');
    const { TABLES } = await import('../types');
    const disk = await import('../lib/yadisk');
    const webdav = await import('../lib/webdav');
    const { readFileSync } = await import('node:fs');
    const files28 = fakeStores.get('files')!;
    const keepMain = files28.get('avtobaza.db');
    const keepBackup = files28.get('avtobaza.db.bak');

    try {
      // --- копия базы: запись, возврат и защита от пустой копии
      files28.clear();
      const first = storage.createPersister();
      await first.save(new Uint8Array([1, 2, 3, 4, 5]));
      eq('копии ещё нет', await first.backupInfo(), null);

      const second = storage.createPersister();
      const loaded = await second.load();
      eq('база прочитана', Array.from(loaded ?? []).join(','), '1,2,3,4,5');
      eq('ошибок чтения нет', second.problem(), null);
      await second.writeBackup(new Uint8Array([1, 2, 3, 4, 5]));
      await second.save(new Uint8Array([9, 9, 9]));
      eq('копия сделана', (await second.backupInfo())?.size, 5);
      eq('в базе новые данные', Array.from(files28.get('avtobaza.db') as Uint8Array).join(','), '9,9,9');
      eq('в копии прежние данные', Array.from(files28.get('avtobaza.db.bak') as Uint8Array).join(','), '1,2,3,4,5');
      await second.writeBackup(new Uint8Array(0));
      eq('пустая копия не записывается', (await second.backupInfo())?.size, 5);

      const third = storage.createPersister();
      eq('копия возвращается на место', await third.restoreBackup(), true);
      eq('в базе снова данные из копии', Array.from(files28.get('avtobaza.db') as Uint8Array).join(','), '1,2,3,4,5');

      // --- файл есть, но прочитать его не вышло: база не считается рабочей
      files28.set('avtobaza.db', new Uint8Array(0));
      const broken = storage.createPersister();
      eq('пустой файл не отдаётся как база', await broken.load(), null);
      check('сказано, что файл не прочитан', (broken.problem() ?? '').includes('прочитать'));

      // --- прежнее имя базы подхватывается
      files28.delete('avtobaza.db');
      files28.set('avtotracker.db', new Uint8Array([7, 7]));
      const legacy = storage.createPersister();
      eq('база со старым именем прочитана', Array.from((await legacy.load()) ?? []).join(','), '7,7');

      // --- непрочитанный файл откладывается в сторону, а не затирается
      files28.set('avtobaza.db', new Uint8Array(0));
      eq('непрочитанный файл отложен', await storage.createPersister().parkBroken(), 'avtobaza.db.broken');
      check('отложенный файл остался', files28.has('avtobaza.db.broken'));
      eq('под именем базы пусто', files28.has('avtobaza.db'), false);
    } finally {
      files28.delete('avtobaza.db.broken');
      files28.delete('avtotracker.db');
      if (keepMain === undefined) files28.delete('avtobaza.db');
      else files28.set('avtobaza.db', keepMain);
      if (keepBackup === undefined) files28.delete('avtobaza.db.bak');
      else files28.set('avtobaza.db.bak', keepBackup);
    }

    // --- копия базы обновляется только у непустой базы
    check('в базе есть записи', db.rowCount() > 0, `(${db.rowCount()})`);
    eq('копия базы обновлена', await db.refreshBackup(), true);
    const copySize = (await db.backupInfo())?.size ?? 0;
    check('копия не пустая', copySize > 0, `(${copySize} байт)`);

    // --- на экране данных есть защита данных
    const dataHtml = renderToString(
      createElement(
        MemoryRouter,
        { initialEntries: ['/data'] },
        createElement((await import('../pages/Data')).default as never),
      ) as never,
    );
    check('на экране данных есть раздел «Защита данных»', dataHtml.includes('Защита данных'));
    check('сказано про копию на устройстве', dataHtml.includes('Копия на устройстве'));
    check('есть возврат из копии', dataHtml.includes('Вернуть из копии'));
    check('есть ручная копия', dataHtml.includes('Сделать копию сейчас'));

    const appSource = readFileSync('src/App.tsx', 'utf8');
    check(
      'об ошибке записи базы приложение сообщает',
      appSource.includes('setSaveErrorHandler') && appSource.includes('Не удалось сохранить базу'),
    );
    check('предупреждение о непрочитанной базе держится на экране', appSource.includes('dataWarning'));

    // --- пустая база не затирает копию с данными в облаке
    const store29 = useApp.getState();
    store29.saveSetting('yadisk_login', 'ivan@yandex.ru');
    store29.saveSetting('yadisk_password', 'parol-prilozheniya');
    store29.saveSetting('yadisk_folder', '/avtobaza');

    const cloudFile = {
      app: 'avtobaza',
      kind: 'cloud-data',
      tables: { companies: [{ id: 'c-29', name: 'Фирма из облака' }] },
    };
    const cloudText = JSON.stringify(cloudFile);
    eq('записи в файле из облака посчитаны', disk.rowsInData(cloudText), 1);
    check('на устройстве записи есть', disk.localRowCount() > 0);

    const cloudFiles = new Map<string, Uint8Array>();
    const cloudDirs = new Set<string>(['/avtobaza']);
    cloudFiles.set('/avtobaza/avtobaza-2026-01-01_000000.json', new TextEncoder().encode(cloudText));
    const originalFetch29 = globalThis.fetch;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      const path = decodeURIComponent(url.replace(webdav.YADISK_HOST, '')) || '/';
      if (method === 'PROPFIND') {
        const children = [...cloudDirs, ...cloudFiles.keys()].filter(
          (p) =>
            p !== path &&
            p.startsWith(path === '/' ? '/' : `${path}/`) &&
            !p.slice(path === '/' ? 1 : path.length + 1).includes('/'),
        );
        const body =
          '<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">' +
          children
            .map(
              (p) =>
                `<d:response><d:href>${encodeURI(p)}</d:href><d:propstat><d:prop>` +
                `<d:displayname>${p.slice(p.lastIndexOf('/') + 1)}</d:displayname>` +
                (cloudDirs.has(p)
                  ? '<d:resourcetype><d:collection/></d:resourcetype>'
                  : '<d:resourcetype/>') +
                `<d:getcontentlength>${cloudFiles.get(p)?.length ?? 0}</d:getcontentlength>` +
                '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>',
            )
            .join('') +
          '</d:multistatus>';
        return new Response(body, { status: 207, headers: { 'Content-Type': 'application/xml' } });
      }
      if (method === 'MKCOL') return new Response(null, { status: 201 });
      if (method === 'PUT') {
        const raw = init?.body;
        cloudFiles.set(
          path,
          typeof raw === 'string'
            ? new TextEncoder().encode(raw)
            : new Uint8Array(raw as ArrayBuffer),
        );
        return new Response(null, { status: 201 });
      }
      if (method === 'DELETE') {
        cloudFiles.delete(path);
        return new Response(null, { status: 204 });
      }
      const data = cloudFiles.get(path);
      if (!data) return new Response(null, { status: 404 });
      return new Response(data.slice().buffer as ArrayBuffer, { status: 200 });
    }) as unknown as typeof fetch;

    try {
      // Пустая база на устройстве: выгрузка должна остановиться
      for (const t of TABLES) dbSync().run(`DELETE FROM ${t}`);
      eq('база на устройстве пуста', disk.localRowCount(), 0);
      eq('пустая база копию не обновляет', await db.refreshBackup(), false);
      eq('копия осталась прежней', (await db.backupInfo())?.size, copySize);
      let guard = '';
      try {
        await disk.pushToDisk();
      } catch (e) {
        guard = e instanceof Error ? e.message : String(e);
      }
      check('пустая выгрузка отменена', guard.includes('Выгрузка отменена'), guard);
      check('объяснено, сколько записей в облаке', guard.includes('в облаке их 1'), guard);
      eq('файл в облаке не тронут', cloudFiles.size, 1);

      // Данные на устройстве есть — выгрузка идёт как обычно
      repo.insertRow('companies', { name: 'Фирма на устройстве', note: '' });
      const pushed = await disk.pushToDisk();
      check('непустая база выгружается', cloudFiles.has(`/avtobaza/${pushed.dataName}`));
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch29;
    }
  }

  console.log('\n27. Планшетный вид: альбомная ориентация');
  {
    const { readFileSync } = await import('node:fs');
    const { applyViewMode, tabletScreen } = await import('../store');
    const { DEFAULT_SETTINGS } = await import('../types');
    const root = (g.document as { documentElement: { dataset: Record<string, string> } }).documentElement;

    eq('по умолчанию вид подбирается сам', DEFAULT_SETTINGS.view_mode, 'auto');
    check('планшет в альбомной ориентации — широкий экран', tabletScreen(1280, 800));
    check('телефон в альбомной — не планшет', !tabletScreen(900, 420));
    check('планшет в портрете — не альбомный вид', !tabletScreen(800, 1280));

    eq('«авто» на планшете даёт планшетный вид', applyViewMode('auto', 1280, 800), 'tablet');
    eq('«авто» на телефоне даёт обычный вид', applyViewMode('auto', 420, 900), 'phone');
    eq('«авто» на телефоне в альбомной — обычный вид', applyViewMode('auto', 900, 420), 'phone');
    eq('выбор «планшет» сильнее размера экрана', applyViewMode('tablet', 420, 900), 'tablet');
    eq('выбор «телефон» сильнее размера экрана', applyViewMode('phone', 1280, 800), 'phone');
    eq('вид попал в документ', root.dataset.view, 'phone');
    applyViewMode('auto', 1280, 800);
    eq('планшетный вид попал в документ', root.dataset.view, 'tablet');

    // Вёрстка: меню-рельса слева, содержимое в две колонки
    const css = await (await fetch(`file://${process.cwd()}/src/styles.css`)).text();
    check('есть переменная ширины каркаса', css.includes('--shell-max: 720px'));
    check('есть ширина меню-рельсы', css.includes('--rail-w: 96px'));
    check('каркас берёт ширину из переменной', css.includes('max-width: var(--shell-max)'));
    const rail = css.slice(css.indexOf("[data-view='tablet'] .bottom-nav"), css.indexOf("[data-view='tablet'] .bottom-nav") + 600);
    check('меню на планшете — вертикальная рельса', rail.includes('flex-direction: column'));
    check('рельса не уезжает при прокрутке', rail.includes('position: sticky'));
    const body = css.slice(css.indexOf("[data-view='tablet'] .page-body"), css.indexOf("[data-view='tablet'] .page-body") + 400);
    check('содержимое идёт в две колонки', body.includes('grid-template-columns: repeat(auto-fit'));
    check('содержимое не шире --content-max', body.includes('max-width: var(--content-max)'));
    check('кнопка «плюс» стоит в рельсе', css.includes("[data-view='tablet'] .fab"));
    check('список записей становится плитками', css.includes("[data-view='tablet'] .page-body > .list .list-item"));

    // Настройки: переключатель вида и перенос в файле
    const mod = await import('../pages/Settings');
    const html = renderToString(
      createElement(
        MemoryRouter,
        { initialEntries: ['/settings'] },
        createElement(mod.default as never),
      ) as never,
    );
    check('в настройках есть поле «Вид»', html.includes('Планшетный вид включается сам'));
    check('в настройках видно выбранный вид', html.includes('Автоматически, по экрану'));
    const settingsSource = readFileSync('src/pages/Settings.tsx', 'utf8');
    check('переключатель вида применяется сразу', settingsSource.includes('applyViewMode'));

    const { buildSettingsFile } = await import('../lib/backup');
    const file = JSON.parse(buildSettingsFile()) as { settings: { key: string; value: string }[] };
    check('вид переносится файлом настроек', file.settings.some((s) => s.key === 'view_mode'));

    // Приложение применяет вид и следит за поворотом
    const appSource = readFileSync('src/App.tsx', 'utf8');
    check('приложение применяет вид', appSource.includes('applyViewMode'));
    check('при повороте вид пересчитывается', appSource.includes('orientationchange'));

    // Поворот разрешён системой и окно при этом не пересоздаётся
    const manifest = readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');
    check('поворот экрана разрешён', !manifest.includes('screenOrientation'));
    check(
      'при повороте окно не пересоздаётся',
      manifest.includes('orientation') && manifest.includes('screenSize'),
    );
  }

  console.log('\n28. Закрытие приложения: сохранение перед выходом');
  {
    const { readFileSync } = await import('node:fs');
    const { createElement } = await import('react');
    const { renderToString } = await import('react-dom/server');
    const appSource = readFileSync('src/App.tsx', 'utf8');
    const exitSource = readFileSync('src/ui/ExitScreen.tsx', 'utf8');
    const autoSource = readFileSync('src/lib/yadisk-auto.ts', 'utf8');
    const componentsSource = readFileSync('src/ui/components.tsx', 'utf8');
    const css = await (await fetch(`file://${process.cwd()}/src/styles.css`)).text();
    const exitStart = css.indexOf('.exit-screen');
    const exitCss = css.slice(exitStart, css.indexOf('Системные панели телефона', exitStart));

    // Вход в закрытие: пункт в листе действий со своей иконкой
    check('в листе действий есть закрытие', appSource.includes('Закрыть приложение'));
    check('у закрытия своя иконка', componentsSource.includes('power:'));
    check('пункт открывает экран закрытия', appSource.includes('onExit={openExit}'));
    check('лист называется «Действие»', appSource.includes('title="Действие"'));

    // Системная «Назад»: на главной спрашивает, внутри — обычный возврат
    check('системная «Назад» перехвачена', appSource.includes("addListener('backButton'"));
    check('на главной спрашивают подтверждение', appSource.includes('Закрыть приложение?'));
    check('возврат по внутренним экранам сохранён', appSource.includes('navigate(-1)'));
    check('подтверждение появляется над экраном закрытия', appSource.includes('if (exitOpen) setExitOpen(false)'));

    // Порядок работы: база на устройстве, копия, облако, выход
    check('база пишется на устройство', exitSource.includes('await db.flush()'));
    check('перед выходом обновляется копия базы', exitSource.includes('refreshBackup'));
    check('в облако уходит только при изменениях', exitSource.includes('state.dirty'));
    check('без изменений обмен пропускается', exitSource.includes('Всё уже в облаке'));
    check('ненастроенное облако не мешает выходу', exitSource.includes('Облако не настроено'));
    check('выгрузка перед выходом не дублирует тихий обмен', autoSource.includes('pushOnExit'));
    check('два обмена не идут разом', autoSource.includes('while (busy && Date.now() < deadline)'));

    // Ошибка не запирает приложение, а показывает причину и выбор
    check('ошибка обмена видна на экране', exitCss.includes('.exit-step-err'));
    check('можно всё равно закрыть', exitSource.includes('Всё равно закрыть'));
    check('есть путь вернуться в приложение', exitSource.includes('Вернуться в приложение'));
    check('приложение закрывается системно', exitSource.includes('exitApp'));
    check('прогресс показывается полосой и списком', exitSource.includes('aria-valuenow'));
    check('во время работы можно отменить', exitSource.includes('Отмена'));

    // Оформление — в стиле заставки
    check('экран закрытия найден в оформлении', exitStart > 0 && exitCss.length > 500);
    check('фон взят у заставки', exitCss.includes('var(--splash-bg)'));
    check('фура уезжает при выходе', exitCss.includes('.exit-truck-away'));
    check('дорога с разметкой — как на заставке', exitSource.includes('splash-dash'));
    check('полоса прогресса со своим заполнением', exitCss.includes('.exit-bar span'));
    check('уважает «уменьшение движения»', exitCss.includes('prefers-reduced-motion'));

    // Сам экран собирается: видно заголовок, шаги и отмену
    const mod = await import('../ui/ExitScreen');
    const html = renderToString(
      createElement(mod.ExitScreen as never, { onCancel: () => {} }) as never,
    );
    check('экран закрытия показывает заголовок', html.includes('Сохраняю и закрываю'));
    check(
      'видно все шаги',
      html.includes('Записываю базу на устройство') &&
        html.includes('Обновляю копию базы') &&
        html.includes('Обмен с Яндекс Диском') &&
        html.includes('Закрываю приложение'),
    );
  }

  console.log(`\nПроверок пройдено: ${passed}, ошибок: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('\nСбой проверки:', e);
  process.exit(1);
});

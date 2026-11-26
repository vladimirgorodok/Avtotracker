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
  getAllKeys() {
    const req = new FakeRequest<IDBValidKey[]>();
    req.result = [...this.map.keys()];
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
  const { todayIso, fmtDate, fmtDateTime, parseCoords, monthLabel, payMonthChoices } = await import('../lib/format');
  const { documentSummary, listDocuments: listDocs, countDocuments: countDocs, renameDocument, deleteDocument } = await import('../lib/documents');
  const { audit, auditText, auditSummary, applyFinding, undoLastFix, lastAppliedFix, loadHidden, saveHidden } = await import('../lib/audit');

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
  {
    const now = new Date();
    const curKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const nextYear = `${now.getFullYear() + 1}-01`;
    const pay = payMonthChoices();
    const payData = payMonthChoices(['2024-03']);
    check('в «месяце оплаты» нет пустых месяцев будущего года', !pay.some((m) => m >= nextYear), `(${pay.join(', ')})`);
    check('текущий месяц есть в «месяце оплаты»', pay.includes(curKey));
    check('месяц прошлого месяца есть в «месяце оплаты»', pay.length >= 2);
    check('месяцы с данными сохранены в «месяце оплаты»', payData.includes('2024-03'));
    check('выбранный месяц остаётся в «месяце оплаты»', payMonthChoices([], '2023-05').includes('2023-05'));
  }
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
    { label: 'Обновление', route: '/update', url: '/update', load: () => import('../pages/Update') },
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
    const { readFileSync } = await import('node:fs');
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

    // Проверка обновлений живёт в сервисах рядом с Диском
    const moreSource = readFileSync('src/pages/More.tsx', 'utf8');
    check('на экране «Ещё» есть вход в обновление', moreSource.includes("to: '/update'"));
    check('он подписан понятно', moreSource.includes('Проверить новую версию на GitHub'));
  }

  console.log('\n22б. Обновления: проверка сборки на GitHub');
  {
    const { readFileSync } = await import('node:fs');
    const upd = await import('../lib/update');

    // --- сравнение версий по частям: 1.0.10 новее 1.0.9
    check('версия по частям сравнивается верно', upd.compareVersions('1.0.10', '1.0.9') > 0);
    check('старшая часть важнее младшей', upd.compareVersions('1.1.0', '1.0.99') > 0);
    eq('одинаковые версии равны', upd.compareVersions('1.0.50', '1.0.50'), 0);
    check('короткая версия не старше длинной', upd.compareVersions('1.0', '1.0.0') === 0);

    // --- разбор ответа GitHub: версия и контрольная сумма берутся из ответа
    const release = {
      tag_name: 'latest',
      body: 'Автоматическая сборка из ветки main, коммит 36eb275, версия 1.0.50. Ставится поверх предыдущей версии.',
      published_at: '2026-11-26T06:44:01Z',
      assets: [
        { name: 'notes.txt', browser_download_url: 'https://example.com/notes.txt', size: 10 },
        {
          name: 'avtobaza-debug.apk',
          browser_download_url:
            'https://github.com/vladimirgorodok/Avtotracker/releases/download/latest/avtobaza-debug.apk',
          size: 7415397,
          digest: 'sha256:35089a69a0ca0f4d9c0712033092738974e826f9bd99c55137ca43f3d1e8678c',
        },
      ],
    };
    const info = upd.parseRelease(release);
    check('сборка разобрана', info !== null);
    eq('версия взята из заметок', info?.version, '1.0.50');
    eq('коммит прочитан', info?.commit, '36eb275');
    eq('ссылка ведёт на файл приложения', String(info?.apkUrl).endsWith('.apk'), true);
    eq('размер файла прочитан', info?.size, 7415397);
    eq(
      'контрольная сумма без приставки',
      info?.sha256,
      '35089a69a0ca0f4d9c0712033092738974e826f9bd99c55137ca43f3d1e8678c',
    );
    eq('сборка без файла приложения не разбирается', upd.parseRelease({ tag_name: 'latest', assets: [] }), null);
    eq(
      'заметки без версии — берём имя метки',
      upd.parseRelease({ tag_name: 'v2', assets: [{ name: 'a.apk', browser_download_url: 'x' }] })?.version,
      'v2',
    );

    // --- новее ли сборка установленной
    check('сборка новее — предлагаем обновиться', upd.isNewer(info!, '1.0.49'));
    check('та же версия — обновлять нечего', !upd.isNewer(info!, '1.0.50'));
    check('старая сборка не предлагается', !upd.isNewer(info!, '1.1.0'));

    // --- размер файла понятен человеку
    check('размер показан в мегабайтах', upd.fileSize(7415397).includes('МБ'));
    eq('пустой размер ни о чём не говорит', upd.fileSize(0), '');

    // --- страница сборки ведёт в правильный репозиторий
    check(
      'ссылка на страницу сборки верна',
      upd.releasePageUrl().includes('vladimirgorodok/Avtotracker/releases/latest'),
    );

    // --- экран «Обновление» собирается и всё рассказывает
    const updateHtml = renderToString(
      createElement(
        MemoryRouter,
        { initialEntries: ['/update'] },
        createElement((await import('../pages/Update')).default as never),
      ) as never,
    );
    check('экран обновления собирается', updateHtml.length > 300, `(${updateHtml.length} символов)`);
    check('видно установленную версию', updateHtml.includes('Установлено'));
    check('есть кнопка проверки', updateHtml.includes('Проверить обновление'));
    check('в браузере честно сказано про телефон', updateHtml.includes('Установка доступна в приложении на телефоне'));
    check('есть переключатель проверки при запуске', updateHtml.includes('Проверять обновления при запуске'));

    // --- запрос к GitHub: адрес и разбор ответа
    eq('репозиторий обновлений назван верно', upd.UPDATE_REPO, 'vladimirgorodok/Avtotracker');
    const updateSource = readFileSync('src/lib/update.ts', 'utf8');
    check('адрес запроса собирается из репозитория', updateSource.includes('/releases/tags/latest'));
    check('о новой версии сообщаем весточкой', updateSource.includes('checkUpdateQuietly'));
    check('проверка при запуске не чаще раза в сутки', updateSource.includes('CHECK_EVERY_MS'));
    check('нативное скачивание подключено', updateSource.includes('registerPlugin<AppUpdateNative>'));

    // --- сборка и нативная часть: скачивание с проверкой суммы и установка
    const appUpdateJava = readFileSync('android/app/src/main/java/ru/avtobaza/app/AppUpdatePlugin.java', 'utf8');
    check('обработчик обновления на месте', appUpdateJava.includes('@CapacitorPlugin(name = "AppUpdate")'));
    check('сборка проверяется по контрольной сумме', appUpdateJava.includes('MessageDigest.getInstance("SHA-256")'));
    check('несовпавшая сборка удаляется', appUpdateJava.includes('контрольная сумма не совпала'));
    check('установщику файл идёт через FileProvider', appUpdateJava.includes('FileProvider.getUriForFile'));
    check('сборка ставится системным окном', appUpdateJava.includes('Intent.ACTION_VIEW'));
    check('есть запрос разрешения на установку', appUpdateJava.includes('ACTION_MANAGE_UNKNOWN_APP_SOURCES'));
    const manifest = readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');
    check('в манифесте есть разрешение ставить сборки', manifest.includes('android.permission.REQUEST_INSTALL_PACKAGES'));
    const mainJava = readFileSync('android/app/src/main/java/ru/avtobaza/app/MainActivity.java', 'utf8');
    check('обработчик обновления подключён', mainJava.includes('registerPlugin(AppUpdatePlugin.class)'));
    const viteSource = readFileSync('vite.config.ts', 'utf8');
    check('версия зашивается при сборке', viteSource.includes('__APP_VERSION__'));
    const appSourceU = readFileSync('src/App.tsx', 'utf8');
    check('проверка при запуске подключена', appSourceU.includes('checkUpdateQuietly()'));
    check('маршрут обновления добавлен', appSourceU.includes('path="/update"'));
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

  console.log('\n25. Яндекс Диск: данные отдельным файлом, картинки поштучно');
  {
    const webdav = await import('../lib/webdav');
    const disk = await import('../lib/yadisk');
    const { buildCloudData } = await import('../lib/backup');
    const { putBlob, getBlob, deleteBlob, dataUrlToBytes } = await import('../lib/files');

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
    eq('имя описи файлов', disk.LIST_NAME, 'avtobaza-files.json');
    eq('папка картинок и фотографий', disk.FILES_FOLDER, 'files');

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
      'поля с картинкой в файле нет вовсе — иначе своя картинка затрётся',
      !Object.prototype.hasOwnProperty.call(
        cloudCompanies.find((c) => c.id === company) ?? {},
        'logo',
      ),
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

    // --- опись значков и фотографий: файлы уходят в облако поштучно
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
    const list = disk.buildIconsList();
    check('опись значков и фотографий собрана', list !== null && list.items.length >= 2);
    const picRecord = (list?.manifest.pictures ?? []).find(
      (p) => p.table === 'companies' && p.name === 'Тестовая фирма',
    );
    check('в описи есть картинка фирмы', Boolean(picRecord));
    check(
      'в описи есть документ',
      (list?.manifest.documents ?? []).some((d) => d.id === docId),
    );
    check('файл картинки назван по содержимому', String(picRecord?.file ?? '').startsWith('pic-'));
    check(
      'файл документа назван по записи',
      String((list?.manifest.documents ?? [])[0]?.file ?? '').startsWith('doc-'),
    );
    const listAgain = disk.buildIconsList();
    eq(
      'имя файла картинки не меняется — второй раз она не уйдёт',
      (listAgain?.manifest.pictures ?? []).find((p) => p.name === 'Тестовая фирма')?.file,
      picRecord?.file,
    );
    eq(
      'размер документа взят из базы',
      (list?.manifest.documents ?? []).find((d) => d.id === docId)?.size,
      4,
    );
    const stats = disk.localPictureStats();
    check('картинки посчитаны', stats.pictures >= 1, `(${stats.pictures})`);
    check('видно, что у части записей значка нет', disk.hasMissingPictures());

    // --- прежний вид облака: архив значков ещё читается
    const JSZip = (await import('jszip')).default;
    const legacy = new JSZip();
    legacy.file('icons.json', JSON.stringify(list?.manifest));
    for (const item of list?.items ?? []) {
      const bytes =
        item.kind === 'picture' ? dataUrlToBytes(item.source)?.bytes : await getBlob(item.source);
      if (bytes) legacy.file(item.file, bytes);
    }
    const archive = await legacy.generateAsync({ type: 'uint8array' });
    const parsed = await disk.readIconsArchive(archive);
    eq(
      'прежний архив читается: картинки на месте',
      parsed.manifest.pictures.length,
      list?.manifest.pictures.length ?? 0,
    );

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
    /** Сколько запросов ушло на Диск и сколько из них — чтение папки */
    let calls = 0;
    let listings = 0;
    const fakeDisk = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      const path = decodeURIComponent(url.replace(webdav.YADISK_HOST, '')) || '/';
      if (method === 'PROPFIND') {
        listings++;
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
      const iconFilesIn = () =>
        [...files.keys()].filter((p) => p.startsWith(`/avtobaza/${disk.FILES_FOLDER}/`));
      check(
        'значки и фотографии выгружены поштучно',
        push.filesUploaded > 0 && iconFilesIn().length === push.filesUploaded,
        `(${push.filesUploaded})`,
      );
      check('опись файлов легла в облако', files.has(`/avtobaza/${disk.LIST_NAME}`));
      eq('после выгрузки изменений нет', disk.cloudState().dirty, false);
      eq(
        'старые копии данных удалены, свежие остались',
        [...files.keys()]
          .filter((p) => /\/avtobaza-\d{4}-\d{2}-\d{2}_\d{6}\.json$/.test(p))
          .sort()
          .join(','),
        `/avtobaza/avtobaza-2020-01-03_000000.json,/avtobaza/${push.dataName}`,
      );
      const uploaded = new TextDecoder().decode(files.get(`/avtobaza/${push.dataName}`)!);
      check('в облаке лёгкий файл без картинок', !uploaded.includes('data:image'));
      check(
        'настройки обмена у каждого устройства свои',
        !uploaded.includes('yadisk_icons_meta') && !uploaded.includes('yadisk_dirty'),
      );

      // Значки не менялись — в облако даже не смотрим
      const filesBefore = iconFilesIn().length;
      const callsBefore = calls;
      const listingsBefore = listings;
      const pushAgain = await disk.pushToDisk();
      eq('неизменённые значки повторно не выгружаются', pushAgain.filesUploaded, 0);
      eq('файлов в облаке столько же', iconFilesIn().length, filesBefore);
      // Папку читаем один раз, а не дважды: раньше на выгрузку уходило два чтения
      eq('папка читается за выгрузку один раз', listings - listingsBefore, 1);
      check('запросов к Диску немного', calls - callsBefore <= 5, `(${calls - callsBefore})`);

      const stages: string[] = [];
      repo.updateRow('companies', company, { logo: 'data:image/png;base64,CCCC' });
      const pushChanged = await disk.pushToDisk((s) => stages.push(`${s.step}|${s.text}`));
      check('изменённый значок выгружается', pushChanged.filesUploaded >= 1);
      check('новый файл лёг в папку files', iconFilesIn().length >= filesBefore);
      check('старый файл значка из облака убран', pushChanged.filesRemoved >= 1);
      check(
        'выгрузка рассказывает о своих шагах',
        stages.some((s) => s.startsWith('data|')) &&
          stages.some((s) => s.startsWith('icons|')) &&
          stages.some((s) => s.startsWith('trim|')),
        stages.join('; '),
      );
      check(
        'в отчёте видно, что отправляются значки и фотографии',
        stages.some((s) => s.includes('Отправляю значки и фотографии (')),
        stages.join('; '),
      );

      // Отпечаток значков: по нему видно, что значков не касались
      const metaNow = disk.iconsMeta();
      check('отпечаток значков запомнен', useApp.getState().settings.yadisk_icons_meta === metaNow);
      check(
        'в отпечаток входит место выгрузки',
        metaNow.startsWith('files|ivan@yandex.ru@/avtobaza|'),
        metaNow,
      );
      check(
        'отпечаток считает картинки и документы',
        metaNow.includes('doc:') && metaNow.split('|').length >= 3,
        metaNow,
      );

      // Место выгрузки сменилось — в новой папке файлы должны уйти заново
      store.saveSetting('yadisk_folder', '/avtobaza/novaya');
      const pushOtherFolder = await disk.pushToDisk();
      check('в новой папке значки выгружаются заново', pushOtherFolder.filesUploaded > 0);
      check(
        'файлы легли именно в новую папку',
        [...files.keys()].some((p) => p.startsWith('/avtobaza/novaya/files/')),
      );
      check('опись легла в новую папку', files.has('/avtobaza/novaya/avtobaza-files.json'));
      store.saveSetting('yadisk_folder', '/avtobaza');
      check(
        'отпечаток снова про прежнюю папку',
        disk.iconsMeta().startsWith('files|ivan@yandex.ru@/avtobaza|'),
      );

      // Прежний архив значков: при загрузке данных из облака он тоже уходит
      const legacyName = 'avtobaza-icons-2019-05-05_050505.zip';
      files.set(`/avtobaza/${legacyName}`, new TextEncoder().encode('прежний архив'));

      // Другое устройство: данных нет, картинок нет — всё приходит из облака
      dbSync().run('UPDATE companies SET logo = ? WHERE id = ?', ['', company]);
      await deleteBlob('doc-28.jpg');
      const pull = await disk.pullFromDisk(false);
      eq('имя загруженного файла', pull.dataName, pushChanged.dataName);
      check('при загрузке прежний архив значков уходит', !files.has(`/avtobaza/${legacyName}`));
      check('записи из облака обновились', pull.inserted + pull.updated > 0);
      check(
        'картинка подтянулась по описи',
        String(dbSync().one<{ logo: string }>('SELECT logo FROM companies WHERE id = ?', [company])?.logo ?? '').startsWith(
          'data:image/png',
        ),
      );
      eq('документ подтянулся по описи', (await getBlob('doc-28.jpg'))?.length, 4);
      eq('после загрузки изменений нет', disk.cloudState().dirty, false);

      // Обмен не затирает свои картинки: второй раз качать уже нечего
      const pullAgain = await disk.pullFromDisk(false);
      eq(
        'повторный обмен ничего не качает',
        pullAgain.icons.pictures + pullAgain.icons.documents,
        0,
      );
      check(
        'картинка осталась на месте',
        String(
          dbSync().one<{ logo: string }>('SELECT logo FROM companies WHERE id = ?', [company])
            ?.logo ?? '',
        ).startsWith('data:image/png'),
      );

      // Значки отдельно от данных
      dbSync().run('UPDATE companies SET logo = ? WHERE id = ?', ['', company]);
      await deleteBlob('doc-28.jpg');
      const iconsOnly = await disk.restoreIconsFromDisk();
      eq('значки подтянулись отдельной кнопкой', iconsOnly.pictures, 1);
      eq('фотография подтянулась отдельной кнопкой', iconsOnly.documents, 1);
      const iconsAgain = await disk.restoreIconsFromDisk();
      eq('повторно ничего не скачивается', iconsAgain.pictures + iconsAgain.documents, 0);
      const upIcons = await disk.pushIconsOnly();
      eq('выгружать значки повторно нечего', upIcons.uploaded, 0);
      check('в описи видно, сколько файлов в облаке', upIcons.total >= 2, `(${upIcons.total})`);

      // Подтягивание на другое устройство: один и тот же лист не должен удваиваться
      {
        const { todayIso } = await import('../lib/format');
        const { sameWaybill } = await import('../lib/calc');
        const today = todayIso();
        const vehicle = repo.insertRow('vehicles', {
          name: 'Тестовый тягач',
          plate: 'А001АА01',
          kind: 'tractor',
          logo: '',
          note: '',
          archived: 0,
        });

        // как на телефоне: лист за сегодня и перевозка с точкой
        const wbCloud = repo.insertRow('waybills', {
          name: `${today} — открыт`,
          date_out: today,
          status: 'open',
          odometer_out: 500000,
          fuel_out: 700,
          vehicle_id: vehicle,
          note: '',
        });
        const tripCloud = repo.insertRow('trips', {
          waybill_id: wbCloud,
          cargo_type_id: null,
          weight: 20000,
          amount: 10500,
          note: 'из облака',
          status: 'planned',
        });
        const pointCloud = repo.insertRow('trip_points', {
          trip_id: tripCloud,
          seq: 1,
          kind: 'load',
          plan_date: today,
          status: 'planned',
          note: 'точка из облака',
        });
        const pushedTo = await disk.pushToDisk();
        check('лист выгружен в облако', files.has(`/avtobaza/${pushedTo.dataName}`));

        // как на планшете: своя шапка на ту же дату, автомобиль ещё не выбран
        dbSync().run('DELETE FROM waybills WHERE id = ?', [wbCloud]);
        dbSync().run('DELETE FROM trips WHERE id = ?', [tripCloud]);
        const wbLocal = repo.insertRow('waybills', {
          name: `${today} — открыт`,
          date_out: today,
          status: 'open',
          odometer_out: null,
          fuel_out: null,
          vehicle_id: null,
          note: 'местная шапка',
        });
        const tripLocal = repo.insertRow('trips', {
          waybill_id: wbLocal,
          cargo_type_id: null,
          weight: null,
          amount: 10500,
          note: 'местная перевозка',
          status: 'planned',
        });

        const pulled = await disk.pullFromDisk(false);
        const openToday = repo.waybillRepo.list().filter((w) => w.date_out === today && w.status === 'open');
        eq('после подтягивания лист на день один', openToday.length, 1);
        eq('остался свой лист', openToday[0]?.id, wbLocal);
        eq('слитый лист посчитан', pulled.merged, 1);
        eq('шапка дополнилась автомобилем', openToday[0]?.vehicle_id, vehicle);
        eq('шапка дополнилась одометром', openToday[0]?.odometer_out, 500000);
        eq('шапка дополнилась топливом', openToday[0]?.fuel_out, 700);
        eq('своё в шапке не затёрто', openToday[0]?.note, 'местная шапка');

        const trips = repo.tripRepo.byWaybill(wbLocal);
        eq('перевозки обоих устройств в одном листе', trips.length, 2);
        check('перевозка из облака не потерялась', trips.some((t) => t.id === tripCloud));
        check('своя перевозка на месте', trips.some((t) => t.id === tripLocal));
        eq('точка из облака подтянулась', repo.tripRepo.points(tripCloud).length, 1);
        check(
          'перевозок без листа не осталось',
          repo.tripRepo.all().every((t) => t.waybill_id !== wbCloud),
        );

        // повторное подтягивание ничего не удваивает
        await disk.pullFromDisk(false);
        eq('повторное подтягивание не удваивает перевозки', repo.tripRepo.byWaybill(wbLocal).length, 2);
        eq(
          'повторное подтягивание не удваивает лист',
          repo.waybillRepo.list().filter((w) => w.date_out === today && w.status === 'open').length,
          1,
        );

        // второй раз лист на этот день не заводится
        const twinNow = sameWaybill({ date_out: today, status: 'open', vehicle_id: null, date_in: null });
        eq('второй лист на этот день не заводится', twinNow?.id, wbLocal);

        // уборка: строки проверки в базе не оставляем
        dbSync().run('DELETE FROM trip_points WHERE id = ?', [pointCloud]);
        dbSync().run('DELETE FROM trips WHERE id IN (?, ?)', [tripCloud, tripLocal]);
        dbSync().run('DELETE FROM waybills WHERE id = ?', [wbLocal]);
        dbSync().run('DELETE FROM vehicles WHERE id = ?', [vehicle]);
      }

      // --- удалённое уходит и из облака: папка с файлами подчищается
      const manifestRaw = () =>
        new TextDecoder().decode(files.get('/avtobaza/avtobaza-files.json') ?? new Uint8Array());
      const namesNow = () => iconFilesIn().map((p) => p.split('/').pop() as string);
      // Чужой файл в папке: его трогать нельзя
      files.set('/avtobaza/files/чужое-письмо.txt', new TextEncoder().encode('не наше'));

      // Заводим запись со значком — он уходит в облако
      const picGone = repo.insertRow('companies', {
        name: 'Фирма со значком на удаление',
        logo: 'data:image/png;base64,ZDDD',
        note: '',
      });
      const pushPic = await disk.pushToDisk();
      check('значок новой записи выгружен', pushPic.filesUploaded >= 1, `(${pushPic.filesUploaded})`);
      check('в папке лежит файл значка', iconFilesIn().some((p) => p.includes('/pic-')));
      const beforeClean = namesNow();

      // Значок убрали — файл должен уйти и из облака
      repo.updateRow('companies', picGone, { logo: '' });
      const pushClean = await disk.pushToDisk();
      const afterClean = namesNow();
      const goneNames = beforeClean.filter((n) => !afterClean.includes(n));
      check('удалённый значок убран из облака', pushClean.filesRemoved >= 1, `(${pushClean.filesRemoved})`);
      check(
        'убранного файла в папке больше нет',
        goneNames.length >= 1 && !afterClean.includes(goneNames[0]),
        goneNames.join(','),
      );
      check('опись больше не зовёт убранный файл', !manifestRaw().includes(goneNames[0]));
      check('чужой файл в папке не тронут', files.has('/avtobaza/files/чужое-письмо.txt'));
      files.delete('/avtobaza/files/чужое-письмо.txt');

      // Значок вернули — файл возвращается в облако
      repo.updateRow('companies', picGone, { logo: 'data:image/png;base64,ZDDD' });
      const pushBack = await disk.pushToDisk();
      check('вернувшийся значок снова выгружен', pushBack.filesUploaded >= 1);
      check('в папке снова наш файл', namesNow().includes(goneNames[0]), goneNames[0]);

      // База отстала от облака — чистку откладываем: чужое убирать нельзя
      files.set('/avtobaza/files/pic-deadbeefdeadbeef.jpg', new TextEncoder().encode('x'));
      store.saveSetting('yadisk_last_data', 'avtobaza-2020-01-01_000000.json');
      const iconsLate = await disk.pushIconsOnly();
      check('пока база отстала, чужое не убираем', files.has('/avtobaza/files/pic-deadbeefdeadbeef.jpg'));
      eq('про отложенную чистку не отчитываются', iconsLate.removed, 0);
      files.delete('/avtobaza/files/pic-deadbeefdeadbeef.jpg');
      store.saveSetting('yadisk_last_data', pushBack.dataName);

      // Прежний архив значков: писала его только старая версия — в облаке не держим
      const archiveName = 'avtobaza-icons-2026-01-01_000000.zip';
      files.set(`/avtobaza/${archiveName}`, new TextEncoder().encode('прежний архив'));
      const pushArch = await disk.pushToDisk();
      check('прежний архив значков убран из облака', !files.has(`/avtobaza/${archiveName}`));
      check('про убранный архив сказано в отчёте', pushArch.filesRemoved >= 1, `(${pushArch.filesRemoved})`);

      // Кнопка «Выгрузить значки» убирает архив даже без прочих изменений
      files.set(`/avtobaza/${archiveName}`, new TextEncoder().encode('прежний архив'));
      const iconsArch = await disk.pushIconsOnly();
      check('кнопка выгрузки значков тоже убирает архив', !files.has(`/avtobaza/${archiveName}`));
      check('и говорит, сколько убрала', iconsArch.removed >= 1, `(${iconsArch.removed})`);

      // --- дубли справочников: обмен сливает их сам, чтобы список не пух
      const cargoKeep = repo.insertRow('cargo_types', {
        name: 'Дубль груза',
        icon: 'data:image/png;base64,DDDD',
        note: '',
      });
      const cargoDrop = repo.insertRow('cargo_types', {
        name: 'дубль ГРУЗА',
        icon: '',
        note: 'заведён дважды',
      });
      const wbDupe = repo.insertRow('waybills', {
        date_out: '2026-11-21',
        status: 'open',
        vehicle_id: null,
        note: '',
      });
      const tripDupe = repo.insertRow('trips', {
        waybill_id: wbDupe,
        cargo_type_id: cargoDrop,
        weight: null,
        amount: 0,
        note: '',
        status: 'planned',
      });

      const pushDupe = await disk.pushToDisk();
      check(
        'обмен слил дубли справочников',
        pushDupe.mergedDuplicates >= 1,
        `(${pushDupe.mergedDuplicates})`,
      );
      eq('в списке осталась одна запись', repo.countRows('cargo_types', 'id IN (?, ?)', [cargoKeep, cargoDrop]), 1);
      eq(
        'перевозка переехала на оставленную запись',
        String(
          dbSync().one<{ cargo_type_id: string | null }>(
            'SELECT cargo_type_id FROM trips WHERE id = ?',
            [tripDupe],
          )?.cargo_type_id ?? '',
        ),
        cargoKeep,
      );
      eq(
        'пустое поле заполнилось из убранной записи',
        String(
          dbSync().one<{ note: string }>('SELECT note FROM cargo_types WHERE id = ?', [cargoKeep])
            ?.note ?? '',
        ),
        'заведён дважды',
      );
      const dupeFile = JSON.parse(
        new TextDecoder().decode(files.get(`/avtobaza/${pushDupe.dataName}`) ?? new Uint8Array()),
      ) as { tables: { cargo_types: { name: string; deleted: number }[] } };
      eq(
        'в облако ушла одна запись',
        dupeFile.tables.cargo_types.filter(
          (c) => c.deleted === 0 && c.name.toLowerCase() === 'дубль груза',
        ).length,
        1,
      );

      // Дубли, оставшиеся от прежних версий, обмен сливает и при загрузке
      const cargoOld = repo.insertRow('cargo_types', { name: 'Старый дубль', icon: '', note: '' });
      const cargoOld2 = repo.insertRow('cargo_types', { name: 'СТАРЫЙ ДУБЛЬ', icon: '', note: '' });
      const pullDupe = await disk.pullFromDisk(false);
      check(
        'загрузка тоже сливает дубли',
        pullDupe.mergedDuplicates >= 1,
        `(${pullDupe.mergedDuplicates})`,
      );
      eq(
        'осталась одна запись и после загрузки',
        repo.countRows('cargo_types', 'id IN (?, ?)', [cargoOld, cargoOld2]),
        1,
      );
      eq('слитое помечено на выгрузку', disk.cloudState().dirty, true);

      // Уборка: строки проверки в базе не оставляем
      dbSync().run('DELETE FROM trips WHERE id = ?', [tripDupe]);
      dbSync().run('DELETE FROM waybills WHERE id = ?', [wbDupe]);
      dbSync().run('DELETE FROM cargo_types WHERE id IN (?, ?, ?, ?)', [
        cargoKeep,
        cargoDrop,
        cargoOld,
        cargoOld2,
      ]);

      // Убрали все значки и фотографии — в облаке тоже ничего не остаётся
      const { PICTURE_COLUMNS } = await import('../lib/backup');
      const picsWas: { table: string; column: string; id: string; value: string }[] = [];
      for (const { table, column } of PICTURE_COLUMNS) {
        for (const row of dbSync().all<{ id: string; value: string }>(
          `SELECT id, ${column} AS value FROM ${table} WHERE ${column} <> ''`,
        )) {
          picsWas.push({ table, column, id: row.id, value: row.value });
        }
        dbSync().run(`UPDATE ${table} SET ${column} = ''`);
      }
      const docsWas = dbSync().all<{ id: string; deleted: number }>(
        'SELECT id, deleted FROM attachments',
      );
      dbSync().run('UPDATE attachments SET deleted = 1');
      const pushEmpty = await disk.pushToDisk();
      check('пустая папка: наших файлов в облаке нет', iconFilesIn().length === 0, `(${iconFilesIn().length})`);
      check('про убранное сказано в отчёте', pushEmpty.filesRemoved >= 1, `(${pushEmpty.filesRemoved})`);
      check('опись стала пустой', manifestRaw().includes('"pictures":[]') && manifestRaw().includes('"documents":[]'));

      // Возвращаем всё как было и выгружаем: дальше проверки идут по чистому месту
      for (const p of picsWas) {
        dbSync().run(`UPDATE ${p.table} SET ${p.column} = ? WHERE id = ?`, [p.value, p.id]);
      }
      for (const d of docsWas) {
        dbSync().run('UPDATE attachments SET deleted = ? WHERE id = ?', [d.deleted, d.id]);
      }
      dbSync().run('DELETE FROM companies WHERE id = ?', [picGone]);
      await disk.pushToDisk();

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
    const { readFileSync } = await import('node:fs');
    const ydSource = readFileSync('src/pages/YandexDisk.tsx', 'utf8');
    const ydMod = await import('../pages/YandexDisk');
    const ydHtml = renderToString(
      createElement(
        MemoryRouter,
        { initialEntries: ['/yadisk'] },
        createElement(ydMod.default as never),
      ) as never,
    );
    check('объяснено, что данные и значки лежат отдельно', ydHtml.includes('хранятся в облаке отдельно'));
    check('подписано поле пароля приложения', ydSource.includes('Пароль приложения'));
    check(
      'в инструкции есть ссылка на пароли приложений',
      ydSource.includes('id.yandex.ru/security/app-passwords'),
    );
    check('про тип пароля сказано', ydSource.includes('WebDAV-клиент для Яндекс Диска'));
    // Введённые данные авторизации прячем: место в карточке они не занимают
    check('данные подключения указаны — карточка свёрнута', ydHtml.includes('Данные подключения введены'));
    check('в свёрнутой карточке видно логин и папку', ydHtml.includes('Логин ') && ydHtml.includes('папка '));
    check('поля прячутся за стрелкой', ydSource.includes("useState(() => !cloudState().configured)"));
    check('карточку можно раскрыть', ydSource.includes('Показать') && ydSource.includes("icon={showConn ? 'up' : 'down'}"));
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
    check(
      'кнопки действий на планшете — одной строкой во всю ширину',
      css.includes("[data-view='tablet'] .page-body > .form-actions") &&
        css.includes('grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr))'),
    );
    check(
      'поиск, вкладки и счётчик со кнопкой — во всю ширину',
      css.includes("[data-view='tablet'] .page-body > .searchbar") &&
        css.includes("[data-view='tablet'] .page-body > .tabs"),
    );
    check(
      'карточка «пока пусто» — во всю ширину',
      css.includes("[data-view='tablet'] .page-body > .card:has(.empty)"),
    );
    check('пустоты в раскладке заполняются', css.includes('grid-auto-flow: row dense'));
    const wbSource = readFileSync('src/pages/WaybillDetail.tsx', 'utf8');
    check('кнопки листа собраны в один ряд', wbSource.includes('className="form-actions"'));
    const tripSource = readFileSync('src/pages/TripDetail.tsx', 'utf8');
    check('кнопки перевозки собраны в один ряд', tripSource.includes('className="form-actions"'));

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

  console.log('\n29. Обмен не гоняет значки и фотографии зря');
  {
    const { readFileSync } = await import('node:fs');
    const diskSource = readFileSync('src/lib/yadisk.ts', 'utf8');
    const autoSource = readFileSync('src/lib/yadisk-auto.ts', 'utf8');
    const ydSource = readFileSync('src/pages/YandexDisk.tsx', 'utf8');
    const exitSource = readFileSync('src/ui/ExitScreen.tsx', 'utf8');
    const css = await (await fetch(`file://${process.cwd()}/src/styles.css`)).text();

    // Дешёвый отпечаток сверяется до сбора описи: обход базы дешевле чтения файлов
    const metaAt = diskSource.indexOf('const meta = iconsMeta();');
    const buildAt = diskSource.indexOf('const list = buildIconsList();');
    check('отпечаток значков считается до сбора описи', metaAt > 0 && buildAt > metaAt);
    check(
      'значки не тронуты — в облако не смотрим',
      diskSource.includes("meta === String(store.settings.yadisk_icons_meta ?? '')"),
    );
    check('отпечаток живёт в настройках', readFileSync('src/types.ts', 'utf8').includes('yadisk_icons_meta: string;'));
    check('в отпечаток входит место выгрузки', diskSource.includes('function cloudPlace()'));
    check('смена папки сбрасывает отпечатки', ydSource.includes("saveSetting('yadisk_icons_meta', '')"));

    // Файлы уходят поштучно: сначала читаем, что уже лежит в облаке, потом шлём новое
    check('перед выгрузкой читается список файлов', diskSource.includes('await listCloudFiles(disk, target)'));
    check('уходит только то, чего в облаке нет', diskSource.includes('!present.has(item.file)'));
    check('картинка называется по содержимому', diskSource.includes('pic-${shortHash(value)}'));
    check('фотография называется по номеру записи', diskSource.includes('doc-${safeName(doc.id)'));
    check(
      'вместо архива — опись файлов',
      diskSource.includes("export const LIST_NAME = 'avtobaza-files.json'"),
    );
    check('файлы документов при сборе описи не читаются', diskSource.includes('size: Number(doc.size) || 0'));
    check('новый архив больше не собирается', !diskSource.includes('buildIconsArchive'));
    check('прежние архивы ещё читаются', diskSource.includes('async function restoreArchiveFromDisk('));
    check('на устройстве файлы опознаются одним запросом', diskSource.includes('const local = await blobKeys();'));
    check('папка с файлами отдельная', diskSource.includes("export const FILES_FOLDER = 'files'"));

    // Папка читается один раз за выгрузку, а не дважды
    check('папка читается одним запросом', diskSource.includes('async function listCloud('));
    check('данные и значки берутся из одного чтения', diskSource.includes('const cloud = await listCloud(target);'));

    // Ход обмена виден: и на экране закрытия, и на странице Диска
    check('выгрузка рассказывает о шагах', diskSource.includes('export type PushReporter'));
    check('экран закрытия показывает шаг обмена', exitSource.includes('pushOnExit((stage) =>'));
    check('страница Диска показывает шаг обмена', ydSource.includes('setStage(s.text)'));
    check('видно, что обмен идёт, а не завис', exitSource.includes('exit-timer') && css.includes('.exit-timer'));
    check('подсказка про долгие значки', exitSource.includes('значки и фотографии уходят дольше всего'));
    check('обмен перед выходом принимает отчёт', autoSource.includes('pushOnExit(report?: PushReporter)'));

    // Что считается «той же записью», когда одно и то же завели два устройства
    const backupSource = readFileSync('src/lib/backup.ts', 'utf8');
    const namesSource = readFileSync('src/lib/names.ts', 'utf8');
    check('лист сверяется по дню и автомобилю', backupSource.includes('const twin = sameWaybill({'));
    check(
      'справочники сверяются по названию',
      namesSource.includes(
        "export const SAME_BY_NAME: TableName[] = ['cargo_types', 'fuel_stations']",
      ) && backupSource.includes('SAME_BY_NAME'),
    );
    check('слитые записи справочника не удваиваются', backupSource.includes('if (refs.get(table)?.has(id)) continue;'));
    check('ссылки переводятся на свою запись', backupSource.includes('REF_LINKS'));
    check('начисление по перевозке не удваивается', backupSource.includes("AND kind = 'charge'"));
  }

  console.log('\n30. Обмен не плодит дубли: Грузы и Финансы');
  {
    const { softDeleteWhere, softDelete } = repo;
    const storeNow = useApp.getState();

    // --- Свежее устройство само заполняет справочники, и это правильные записи
    softDeleteWhere('cargo_types', '1=1');
    seedIfEmpty();
    const mine = repo.refs.cargoTypes();
    check('справочник грузов заполняется сам', mine.length >= 10, `(${mine.length})`);

    // --- Так выглядит файл с другого устройства: те же названия, но свои номера
    const otherSide = mine.map((c) => ({ ...c, id: `чужой-${c.id}` }));
    const file = JSON.stringify({
      app: 'avtobaza',
      kind: 'cloud-data',
      version: 1,
      exported_at: '2026-11-20T00:00:00.000Z',
      tables: { cargo_types: otherSide },
    });
    importJson(file, true);
    const names = repo.refs.cargoTypes().map((c) => c.name.trim().toLowerCase());
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    eq('грузов с одинаковым названием нет', dupes.length, 0);

    // --- Ссылка на чужую запись переводится на свою: записи не разъезжаются
    const mineCargo = repo.refs.cargoTypes()[0];
    const foreignTripId = 'чужой-рейс-1';
    const linked = importJson(
      JSON.stringify({
        app: 'avtobaza',
        kind: 'cloud-data',
        version: 1,
        tables: {
          cargo_types: [{ ...mineCargo, id: `чужой-${mineCargo.id}` }],
          trips: [
            {
              id: foreignTripId,
              waybill_id: '',
              cargo_type_id: `чужой-${mineCargo.id}`,
              weight: null,
              amount: 0,
              note: '',
              status: 'planned',
            },
          ],
        },
      }),
      true,
    );
    eq('ссылка на груз переведена на свою запись', repo.tripRepo.get(foreignTripId)?.cargo_type_id, mineCargo.id);
    check('слияние справочников видно в отчёте', linked.message.includes('слито записей справочников'), linked.message);

    // --- АЗС: список приходит из облака целиком, дублей тоже быть не должно
    const stations = repo.refs.fuelStations();
    check('справочник АЗС заполняется сам', stations.length >= 5, `(${stations.length})`);
    const myStation = stations[0];
    importJson(
      JSON.stringify({
        app: 'avtobaza',
        kind: 'cloud-data',
        version: 1,
        tables: {
          fuel_stations: stations.map((s) => ({ ...s, id: `чужой-${s.id}` })),
          refuelings: [
            {
              id: 'чужой-заправка-1',
              waybill_id: '',
              station_id: `чужой-${myStation.id}`,
              date: '2026-02-02',
              volume: 10,
              kind: 'barrel',
              note: '',
            },
          ],
        },
      }),
      true,
    );
    const stNames = repo.refs.fuelStations().map((s) => s.name.trim().toLowerCase());
    eq('АЗС с одинаковым названием нет', stNames.filter((n, i) => stNames.indexOf(n) !== i).length, 0);
    eq('ссылка на АЗС переведена на свою запись', repo.refuelRepo.get('чужой-заправка-1')?.station_id, myStation.id);

    // --- Та же проверка для начислений: перевозка начислена на двух устройствах
    const wbId = repo.insertRow('waybills', {
      date_out: '2026-02-02',
      status: 'open',
      vehicle_id: null,
      note: '',
    });
    const tripId = repo.insertRow('trips', {
      waybill_id: wbId,
      cargo_type_id: null,
      weight: null,
      amount: 10500,
      note: '',
      status: 'done',
    });
    repo.insertRow('trip_points', {
      trip_id: tripId,
      seq: 1,
      kind: 'load',
      place_id: null,
      plan_date: '2026-02-02',
      fact_date: '2026-02-02',
      load_type: null,
      cargo_type_id: null,
      weight: null,
      status: 'done',
      note: '',
    });
    chargeTrip(tripId, storeNow.settings);
    eq('своё начисление по перевозке одно', repo.financeRepo.byTrip(tripId).length, 1);
    const own = repo.financeRepo.byTrip(tripId)[0];
    const foreign = JSON.stringify({
      app: 'avtobaza',
      kind: 'cloud-data',
      version: 1,
      exported_at: '2026-11-20T00:00:00.000Z',
      tables: { finance_ops: [{ ...own, id: `чужое-${own.id}` }] },
    });
    importJson(foreign, true);
    eq('начисление по перевозке не удвоилось', repo.financeRepo.byTrip(tripId).length, 1);
    // уборка: строки проверки в базе не оставляем
    softDeleteWhere('finance_ops', "id LIKE 'чужое-%'", []);
    softDeleteWhere('finance_ops', 'trip_id = ?', [tripId]);
    softDeleteWhere('trip_points', 'trip_id = ?', [tripId]);
    softDelete('trips', tripId);
    softDelete('trips', foreignTripId);
    softDelete('waybills', wbId);
    softDelete('refuelings', 'чужой-заправка-1');
    softDeleteWhere('cargo_types', "id LIKE 'чужой-%'", []);
    softDeleteWhere('fuel_stations', "id LIKE 'чужой-%'", []);
  }

  console.log('\n31. Проверка данных: находки, правки и отмена');
  {
    // К строке идём напрямую: у части полей объявлен обязательный тип
    const rowOf = (table: string, id: string) =>
      dbSync().one<Record<string, unknown>>(`SELECT * FROM ${table} WHERE id = ?`, [id]);

    // --- Дубли в финансах: одинаковые дата, вид и сумма
    const dupA = repo.insertRow('finance_ops', {
      date: '2026-03-03',
      kind: 'payment',
      amount: 7777.77,
      pay_month: '2026-03',
      trip_id: null,
      waybill_id: null,
      note: 'проба А',
      auto: 0,
    });
    const dupB = repo.insertRow('finance_ops', {
      date: '2026-03-03',
      kind: 'payment',
      amount: 7777.77,
      pay_month: '2026-03',
      trip_id: null,
      waybill_id: null,
      note: 'проба Б',
      auto: 0,
    });
    const dupCount = () => repo.countRows('finance_ops', "date = '2026-03-03' AND amount = 7777.77");

    let list = audit();
    const dupFinding = list.find(
      (f) => f.kind === 'finance-duplicate' && f.id.includes(dupA) && f.id.includes(dupB),
    );
    check('дубль в финансах найден', dupFinding !== undefined);
    check('у дубля есть предложение', dupFinding?.fix !== null && dupFinding?.fix !== undefined);
    check(
      'в находке показаны обе записи',
      (dupFinding?.details.filter((d) => d.includes('проба')).length ?? 0) === 2,
    );
    // Записи без перевозок: порядок не разобрать — предложение не делается
    check('к каждой записи показаны связи', (dupFinding?.details.filter((d) => d.includes('связи:')).length ?? 0) === 2);
    if (dupFinding) {
      eq('до правки две записи', dupCount(), 2);
      await applyFinding(dupFinding);
      eq('после правки осталась одна', dupCount(), 1);
      check('правка помнит, как вернуться', lastAppliedFix() !== null);
      eq('вернуть правку удалось', undoLastFix(), true);
      eq('после отмены снова две', dupCount(), 2);
    }

    // --- Двойное начисление по одной и той же перевозке
    const wbCharge = repo.insertRow('waybills', {
      date_out: '2026-03-04',
      status: 'open',
      vehicle_id: null,
      note: '',
    });
    const tripCharge = repo.insertRow('trips', {
      waybill_id: wbCharge,
      cargo_type_id: null,
      weight: null,
      amount: 4321,
      note: '',
      status: 'charged',
    });
    const ch1 = repo.insertRow('finance_ops', {
      date: '2026-03-04',
      kind: 'charge',
      amount: 4321,
      pay_month: null,
      trip_id: tripCharge,
      waybill_id: wbCharge,
      note: 'начисление 1',
      auto: 1,
    });
    const ch2 = repo.insertRow('finance_ops', {
      date: '2026-03-04',
      kind: 'charge',
      amount: 4321,
      pay_month: null,
      trip_id: tripCharge,
      waybill_id: wbCharge,
      note: 'начисление 2',
      auto: 1,
    });
    const chargesOfTrip = () => repo.countRows('finance_ops', 'trip_id = ? AND kind = ?', [tripCharge, 'charge']);

    list = audit();
    const chFinding = list.find(
      (f) => f.kind === 'charge-duplicate' && f.id.includes(ch1) && f.id.includes(ch2),
    );
    check('двойное начисление найдено', chFinding !== undefined);
    eq('двойное начисление — ошибка', chFinding?.level, 'err');
    check('в находке видна перевозка', chFinding?.details.some((d) => d.includes('перевозка')) ?? false);
    if (chFinding) {
      eq('начислений по перевозке два', chargesOfTrip(), 2);
      await applyFinding(chFinding);
      eq('осталось одно начисление', chargesOfTrip(), 1);
      eq('вернуть удалось', undoLastFix(), true);
      eq('отмена вернула оба начисления', chargesOfTrip(), 2);
    }

    // --- Одинаковые названия в справочнике: ссылки переезжают на оставшуюся запись
    const cargoKeep = repo.insertRow('cargo_types', {
      name: 'ЩебеньПроба',
      icon: 'data:image/png;base64,AAAA',
      note: '',
    });
    const cargoDrop = repo.insertRow('cargo_types', {
      name: 'щебеньпроба',
      icon: '',
      note: 'с примечанием',
    });
    const wbRef = repo.insertRow('waybills', { date_out: '2026-03-05', status: 'open', vehicle_id: null, note: '' });
    const tripRef = repo.insertRow('trips', {
      waybill_id: wbRef,
      cargo_type_id: cargoDrop,
      weight: null,
      amount: 1,
      note: '',
      status: 'planned',
    });

    list = audit();
    const refFinding = list.find(
      (f) => f.kind === 'ref-duplicate' && f.id.includes(cargoKeep) && f.id.includes(cargoDrop),
    );
    check('дубль груза найден', refFinding !== undefined);
    if (refFinding) {
      await applyFinding(refFinding);
      eq('осталась одна запись груза', repo.countRows('cargo_types', 'id IN (?, ?)', [cargoKeep, cargoDrop]), 1);
      eq(
        'ссылка переехала на оставшуюся запись',
        rowOf('trips', tripRef)?.cargo_type_id,
        cargoKeep,
      );
      eq(
        'пустое примечание заполнилось',
        rowOf('cargo_types', cargoKeep)?.note,
        'с примечанием',
      );
      eq('вернуть удалось', undoLastFix(), true);
      eq('отмена вернула обе записи', repo.countRows('cargo_types', 'id IN (?, ?)', [cargoKeep, cargoDrop]), 2);
      eq(
        'отмена вернула ссылку',
        rowOf('trips', tripRef)?.cargo_type_id,
        cargoDrop,
      );
    }

    // --- Ссылка в никуда: перевозка осталась без листа
    const wbGone = repo.insertRow('waybills', { date_out: '2026-03-06', status: 'open', vehicle_id: null, note: '' });
    const tripOrphan = repo.insertRow('trips', {
      waybill_id: wbGone,
      cargo_type_id: null,
      weight: null,
      amount: 0,
      note: '',
      status: 'planned',
    });
    repo.softDelete('waybills', wbGone);

    list = audit();
    const orphanFinding = list.find((f) => f.id === 'orphan:trips.waybill_id');
    check('ссылка в никуда найдена', orphanFinding !== undefined);
    check('в находке видно, о какой перевозке речь', orphanFinding?.details.some((d) => d.includes('перевозка')) ?? false);
    if (orphanFinding) {
      await applyFinding(orphanFinding);
      eq(
        'битая ссылка очищена',
        rowOf('trips', tripOrphan)?.waybill_id,
        '',
      );
      eq('вернуть удалось', undoLastFix(), true);
      eq(
        'отмена вернула ссылку',
        rowOf('trips', tripOrphan)?.waybill_id,
        wbGone,
      );
    }

    // --- Пустой путевой лист: заведён давно и так и остался пустым
    const wbEmpty = repo.insertRow('waybills', { date_out: '2020-01-05', status: 'open', vehicle_id: null, note: '' });
    list = audit();
    const emptyFinding = list.find((f) => f.id === `empty-waybill:${wbEmpty}`);
    check('пустой лист найден', emptyFinding !== undefined);
    if (emptyFinding) {
      await applyFinding(emptyFinding);
      eq('пустой лист помечен удалённым', repo.countRows('waybills', 'id = ?', [wbEmpty]), 0);
      eq('вернуть удалось', undoLastFix(), true);
      eq('отмена вернула лист', repo.countRows('waybills', 'id = ?', [wbEmpty]), 1);
    }

    // --- Замечание по листу с готовым исправлением: одометр сдачи меньше выезда
    const wbBad = repo.insertRow('waybills', {
      date_out: '2027-01-07',
      odometer_out: 200000,
      odometer_in: 190000,
      fuel_out: null,
      fuel_in: null,
      status: 'open',
      vehicle_id: null,
      note: '',
    });
    list = audit();
    const noteFinding = list.find((f) => f.kind === 'waybill-note' && f.id.startsWith(`waybill-note:${wbBad}:`));
    check('замечание по одометру найдено', noteFinding !== undefined);
    eq('замечание — ошибка', noteFinding?.level, 'err');
    check('у замечания есть исправление', noteFinding?.fix !== null && noteFinding?.fix !== undefined);
    if (noteFinding?.fix) {
      await applyFinding(noteFinding);
      eq(
        'одометр сдачи убран',
        rowOf('waybills', wbBad)?.odometer_in,
        null,
      );
      eq('вернуть удалось', undoLastFix(), true);
      eq(
        'отмена вернула одометр',
        rowOf('waybills', wbBad)?.odometer_in,
        190000,
      );
    }

    // --- Снимки заявок: их прикладывали к поездке, теперь в базе не нужны
    const wbOrder = repo.insertRow('waybills', {
      date_out: '2026-03-06',
      status: 'open',
      vehicle_id: null,
      note: '',
    });
    const tripOrder = repo.insertRow('trips', {
      waybill_id: wbOrder,
      cargo_type_id: null,
      weight: null,
      amount: 1500,
      note: '',
      status: 'planned',
    });
    const shotId = repo.insertRow('attachments', {
      owner_table: 'trips',
      owner_id: tripOrder,
      title: 'Заявка: снимок.jpg',
      mime: 'image/jpeg',
      path: 'shot.jpg',
      thumb_path: 'shot.thumb.jpg',
      size: 10,
    });
    const keepPhoto = repo.insertRow('attachments', {
      owner_table: 'trips',
      owner_id: tripOrder,
      title: `Фото от ${'06.03.2026'}`,
      mime: 'image/jpeg',
      path: 'keep.jpg',
      thumb_path: '',
      size: 10,
    });

    const shotFinding = audit().find((f) => f.kind === 'junk' && f.id.includes(shotId));
    check('снимок заявки в поездке найден', shotFinding !== undefined);
    check('обычное фото поездки в находку не попало', !(shotFinding?.id ?? '').includes(keepPhoto));
    check('снимки заявок убираются окончательно', shotFinding?.fix?.permanent === true);
    check(
      'видно, к какой поездке относился снимок',
      (shotFinding?.details ?? []).some((d) => d.includes('перевозка')),
    );
    if (shotFinding) {
      eq('до правки файл заявки на месте', repo.countRows('attachments', `id = '${shotId}'`), 1);
      await applyFinding(shotFinding);
      eq('файл заявки убран', repo.countRows('attachments', `id = '${shotId}'`), 0);
      eq('обычное фото осталось', repo.countRows('attachments', `id = '${keepPhoto}'`), 1);
    }

    // Разбор заявок больше не сохраняет её файлы в базе
    const orderPage = (await import('node:fs')).readFileSync('src/pages/OrderFromFiles.tsx', 'utf8');
    check('разбор заявок не прикладывает снимки к поездке', !orderPage.includes('addPhoto'));
    check('в разборе сказано, что файлы не сохраняются', orderPage.includes('в базе не сохраняются'));

    // --- Скрытые находки запоминаются на устройстве
    if (dupFinding) {
      await saveHidden([dupFinding.id]);
      eq('скрытая находка запомнена', (await loadHidden()).includes(dupFinding.id), true);
      await saveHidden([]);
      eq('список скрытых очищен', (await loadHidden()).length, 0);
    }

    // --- Подписи для экрана и для помощника
    check('подпись для меню не пустая', auditSummary().length > 0);
    check('помощник узнаёт о находках', auditText().includes('Проверка данных'));
    check('в рассказе есть куда нажать', auditText().includes('Проверка данных'));

    // уборка: строки проверки в базе не оставляем
    repo.softDelete('finance_ops', dupA);
    repo.softDelete('finance_ops', dupB);
    repo.softDelete('finance_ops', ch1);
    repo.softDelete('finance_ops', ch2);
    repo.softDelete('trips', tripCharge);
    repo.softDelete('waybills', wbCharge);
    repo.softDelete('trips', tripRef);
    repo.softDelete('waybills', wbRef);
    repo.softDeleteWhere('cargo_types', 'id IN (?, ?)', [cargoKeep, cargoDrop]);
    repo.softDelete('trips', tripOrphan);
    repo.softDelete('waybills', wbGone);
    repo.softDelete('waybills', wbEmpty);
    repo.softDelete('waybills', wbBad);
    repo.softDelete('attachments', keepPhoto);
    repo.softDelete('trips', tripOrder);
    repo.softDelete('waybills', wbOrder);
  }

  console.log('\n32. Обмен при запуске: окно после заставки');
  {
    const { readFileSync } = await import('node:fs');
    const { createElement } = await import('react');
    const { renderToString } = await import('react-dom/server');
    const appSource = readFileSync('src/App.tsx', 'utf8');
    const startSource = readFileSync('src/ui/StartScreen.tsx', 'utf8');
    const autoSource = readFileSync('src/lib/yadisk-auto.ts', 'utf8');
    const exitSource = readFileSync('src/ui/ExitScreen.tsx', 'utf8');

    // Окно показывается после заставки и только когда есть с кем обмениваться
    check('окно обмена подключено в приложении', appSource.includes('startPhase === \'show\' ? <StartScreen'));
    check('окно ждёт конца заставки', appSource.includes("setStartPhase(autoSyncWanted() ? 'show' : 'done')"));
    check('без облака окно не показывается', autoSource.includes('export function autoSyncWanted()'));
    check(
      'автобмен выключен — окна нет',
      autoSource.includes('return cloudConfigured() && cloudState().auto;'),
    );

    // Первый обмен идёт на виду, а не тихо в фоне
    check('первый обмен вынесен в startSync', autoSource.includes('export async function startSync('));
    check('тихий запуск больше не обменивается сам', !autoSource.includes("void quiet('any')"));
    check('обмен при запуске рассказывает о ходе', autoSource.includes('startSync(report?: PushReporter)'));
    check(
      'свои изменения выгружаются',
      /startSync[\s\S]{0,900}if \(state\.dirty\) \{\s*const res = await pushToDisk\(report\)/.test(autoSource),
    );
    check(
      'чужая свежая копия забирается',
      /newest\.name === state\.lastData[\s\S]{0,200}pullFromDisk\(false, report\)/.test(autoSource),
    );
    check('два обмена не идут разом', /startSync[\s\S]{0,600}while \(busy && Date\.now\(\) < deadline\)/.test(autoSource));
    check('ошибка остаётся на экране «Яндекс Диск»', /startSync[\s\S]{0,1600}noteError\(/.test(autoSource));

    // Ошибка не запирает приложение
    check('при неудаче можно повторить', startSource.includes('Повторить') && startSource.includes('setAttempt'));
    check('при неудаче можно открыть приложение', startSource.includes('Открыть приложение'));
    check('при неудаче видно причину', startSource.includes("'err', reason(e)"));
    check('во время обмена можно пропустить', startSource.includes('Пропустить'));
    check('видно, что обмен идёт, а не завис', startSource.includes('exit-timer'));
    check('долгий обмен можно смотреть до конца', !startSource.includes('HOLD_MS'));
    check('окно не уходит само по времени', !/setTimeout\(\(\) => \{\s*put\('cloud'/.test(startSource));
    check('вход открывается ровно один раз', startSource.includes('opened.current = true'));

    // Не мигает при быстром обмене
    check('окно держится на виду хотя бы чуть-чуть', startSource.includes('MIN_MS'));
    check('фура уезжает перед показом приложения', startSource.includes('exit-truck-away'));
    check('пока идёт обмен, «Назад» не выходит', appSource.includes("if (startPhase === 'show') return;"));
    check(
      'значки строки состояния светлые, пока окно на экране',
      appSource.includes("splashDone && startPhase !== 'show'"),
    );

    // Оформление — то же, что у экрана закрытия
    check('оформление взято у экрана закрытия', startSource.includes('className="exit-screen"'));
    check('та же фура и дорога, что на заставке', startSource.includes('TruckMark') && startSource.includes('splash-dash'));
    check('прогресс показывается полосой и списком', startSource.includes('aria-valuenow'));
    check('экран закрытия не тронут', exitSource.includes('pushOnExit((stage) =>'));

    // Сам экран собирается: видно заголовок, шаги и пропуск
    const mod = await import('../ui/StartScreen');
    const html = renderToString(
      createElement(mod.StartScreen as never, { onDone: () => {} }) as never,
    );
    check('окно запуска показывает заголовок', html.includes('Проверяю и обновляю'));
    check(
      'видно все шаги',
      html.includes('Проверяю данные на устройстве') &&
        html.includes('Обмен с Яндекс Диском') &&
        html.includes('Открываю приложение'),
    );
    check('пропуск виден сразу', html.includes('Пропустить'));
  }

  console.log('\n33. Сохранение на виду: индикатор в шапке');
  {
    const { readFileSync } = await import('node:fs');
    const { createElement } = await import('react');
    const { renderToString } = await import('react-dom/server');
    const { MemoryRouter } = await import('react-router-dom');
    const badgeSource = readFileSync('src/ui/SaveBadge.tsx', 'utf8');
    const autoSource = readFileSync('src/lib/yadisk-auto.ts', 'utf8');
    const dbSource = readFileSync('src/db/index.ts', 'utf8');
    const componentsSource = readFileSync('src/ui/components.tsx', 'utf8');
    const css = await (await fetch(`file://${process.cwd()}/src/styles.css`)).text();

    // Видно и запись на устройство, и выгрузку в облако
    check('в базе видно, что ещё не записано', dbSource.includes('hasUnsaved()'));
    check('обмен рассказывает о своём состоянии', autoSource.includes('export function saveStatus()'));
    check('у обмена есть все состояния', /SavePhase = 'off' \| 'saved' \| 'pending' \| 'busy' \| 'error'/.test(autoSource));
    check(
      'видно, сколько осталось до выгрузки',
      autoSource.includes('waitMs: Math.max(0, pushAt - Date.now())'),
    );
    check('отсчёт идёт по той же задержке, что и выгрузка', autoSource.includes('delayMs: PUSH_DELAY_MS'));
    check('ошибка выгрузки видна в шапке', badgeSource.includes('Не выгружено'));
    check('шаг выгрузки отмечается в состоянии', /busy = true;\s*phase = 'busy'/.test(autoSource));

    // Подписи по шагам: сохраняю → в облако N с → выгружаю → в облаке
    check('видно запись на устройство', badgeSource.includes('Сохраняю…'));
    check('видно отсчёт до выгрузки', badgeSource.includes('В облако ${left} с'));
    check('видно саму выгрузку', badgeSource.includes('Выгружаю…'));
    check('видно, что всё в облаке', badgeSource.includes('В облаке ${at}'));
    check('время выгрузки показывается часами', badgeSource.includes('toLocaleTimeString'));
    check('подпись обновляется каждую секунду', badgeSource.includes('setInterval'));
    check('нажатие открывает экран Яндекс Диска', badgeSource.includes("navigate('/yadisk')"));
    check('значок крутится, пока идёт работа', badgeSource.includes('save-badge-spin') && css.includes('.save-badge-spin'));
    check('подробности — во всплывающей подсказке', badgeSource.includes('title={hint}'));
    check(
      'уважает «уменьшение движения»',
      css.includes('prefers-reduced-motion') && /save-badge-spin svg/.test(css),
    );

    // Индикатор стоит в шапке на вкладках и на остальных экранах
    check('индикатор в шапке страниц', componentsSource.includes('<SaveBadge />'));
    for (const page of ['Home', 'Waybills', 'Trips', 'Refuelings', 'Finance', 'Vehicles', 'Audit']) {
      const src = readFileSync(`src/pages/${page}.tsx`, 'utf8');
      check(`индикатор в шапке: ${page}`, src.includes('<SaveBadge />'));
    }
    // Длинный заголовок не выдавливает индикатор из шапки
    check('заголовок в шапке сокращается', /\.topbar h1 \{[\s\S]{0,200}text-overflow: ellipsis/.test(css));

    // Сам индикатор собирается
    const badgeMod = await import('../ui/SaveBadge');
    const badgeHtml = renderToString(
      createElement(MemoryRouter, {}, createElement(badgeMod.SaveBadge as never)) as never,
    );
    check('индикатор показывает состояние', /Сохранено|В облаке|Сохраняю/.test(badgeHtml));
  }

  console.log('\n34. Сохранил — и пошёл дальше');
  {
    const { readFileSync } = await import('node:fs');

    // «Сохранить» закрывает карточку: за «крестик» больше держаться не надо
    const targets: [string, string][] = [
      ['WaybillDetail', '/waybills'],
      ['TripDetail', '/trips'],
      ['RefuelDetail', '/refuelings'],
      ['FinanceDetail', '/finance'],
      ['VehicleDetail', '/vehicles'],
    ];
    for (const [page, route] of targets) {
      const src = readFileSync(`src/pages/${page}.tsx`, 'utf8');
      const at = src.indexOf('function save()');
      const rest = src.slice(at + 1);
      const end = rest.indexOf('\n  function ');
      const body = end > 0 ? rest.slice(0, end) : rest;
      check(`${page}: сохранение закрывает карточку`, at > 0 && body.includes(`navigate('${route}')`));
    }

    // Введённые данные авторизации прячутся: место в карточке они не занимают
    const aiSource = readFileSync('src/ui/AiSettings.tsx', 'utf8');
    check('адрес и ключ ИИ прячутся, когда введены', aiSource.includes('readAiConfig() === null'));
    check('их можно раскрыть обратно', aiSource.includes('Показать адрес и ключ'));
    check('в свёрнутом виде видно адрес и наличие ключа', aiSource.includes('ключ задан'));
    const ydSource = readFileSync('src/pages/YandexDisk.tsx', 'utf8');
    check('подключение к Диску тоже сворачивается', ydSource.includes("useState(() => !cloudState().configured)"));
  }

  console.log('\n35. Чистка в облаке: удалённое уходит');
  {
    const { readFileSync } = await import('node:fs');
    const diskSource = readFileSync('src/lib/yadisk.ts', 'utf8');
    const ydSource = readFileSync('src/pages/YandexDisk.tsx', 'utf8');
    const exitSource = readFileSync('src/ui/ExitScreen.tsx', 'utf8');

    // В облаке не копится лишнее: удалённое на устройстве убирается и с Диска
    check('лишние файлы из облака убираются', diskSource.includes('function cleanLeftovers'));
    check('убираем только наши файлы', diskSource.includes('OUR_FILE_RE.test(name)'));
    check('отстали от облака — чистку откладываем', diskSource.includes('function mayCleanCloud'));
    check('после полной уборки остаётся пустая опись', diskSource.includes('function emptyManifest'));
    check('в отчёте видно, сколько убрали', ydSource.includes('убрано лишних файлов'));
    check('при выходе из приложения уборка тоже видна', exitSource.includes('убрано лишних'));
    check('в подсказке сказано, что удалённое уходит из облака', ydSource.includes('убираются из облака'));

    // Прежние архивы значков: старых версий нет — значит, архивам в облаке не место
    check('прежние архивы убираются при обмене', diskSource.includes('async function dropArchives('));
    check('выгрузка данных чистит архивы', diskSource.includes('await dropArchives(disk, cloud.icons)'));
    check('кнопка значков чистит архивы', diskSource.includes('await listIconsFiles(target)'));
    check('загрузка из облака тоже чистит архивы', diskSource.includes('в облаке им больше не место'));
    check('архивы больше не держим «на всякий случай»', !diskSource.includes('trimOld(disk, cloud.icons, 1)'));
    check('но прочитать оставшийся архив по-прежнему можно', diskSource.includes('async function readIconsArchive('));

    // Дубли справочников: список не пух, ссылки переезжают на оставленную запись
    const auditSource = readFileSync('src/lib/audit.ts', 'utf8');
    const autoSource = readFileSync('src/lib/yadisk-auto.ts', 'utf8');
    check('слияние дублей живёт отдельной функцией', auditSource.includes('export function mergeRefDuplicates('));
    check('обмен зовёт его перед выгрузкой и после загрузки', diskSource.includes('function tidyRefDuplicates('));
    check(
      'выгрузка чистит дубли до отправки файла',
      diskSource.indexOf('const mergedDuplicates = tidyRefDuplicates();') <
        diskSource.indexOf('const data = buildCloudData();'),
    );
    check('о слитых дублях сказано в отчётах', ydSource.includes('слито дублей') && exitSource.includes('слито дублей'));
    check('в тихом обмене про дубли сообщаем отдельно', autoSource.includes('function noteMerged('));
    check('в обмене при запуске дубли видны в надписи', autoSource.includes('function mergedText('));
    check('отменить слияние можно кнопкой «Вернуть»', auditSource.includes('undo: () => restoreTables(snap)'));

    // Картинки в облачный файл полем не пишутся: иначе своя картинка затрётся
    const backupSource = readFileSync('src/lib/backup.ts', 'utf8');
    check('картинка не уходит в облако пустым полем', backupSource.includes('delete row[column]'));
    check('про это сказано в коде', backupSource.includes('пустое поле значило бы'));
  }

  console.log(`\nПроверок пройдено: ${passed}, ошибок: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('\nСбой проверки:', e);
  process.exit(1);
});

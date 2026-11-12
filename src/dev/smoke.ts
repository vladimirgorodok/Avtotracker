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
  const { dumpAll, toCsv, parseCsv, importJson, importCsvZip } = await import('../lib/backup');
  const { buildWaybillPdf, buildMonthReportPdf } = await import('../lib/backup');
  const JSZip = (await import('jszip')).default;
  const { todayIso, fmtDate, parseCoords, monthLabel } = await import('../lib/format');
  const { documentSummary, listDocuments: listDocs, countDocuments: countDocs, renameDocument, deleteDocument } = await import('../lib/documents');
  const { syncState, pendingByTable, isPending, resetSyncMarkers } = await import('../lib/sync');

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

  const res2 = closeWaybill(waybillId, repo.getSettings());
  check('повторное закрытие отклонено', !res2.ok);
  eq('начислений по-прежнему одно', repo.financeRepo.byTrip(tripId).length, 1);

  console.log('\n7. Повторное начисление вручную');
  chargeTrip(tripId, repo.getSettings(), 12000);
  eq('сумма обновлена, а не продублирована', repo.financeRepo.byTrip(tripId)[0].amount, 12000);
  eq('всего операций', repo.financeRepo.byTrip(tripId).length, 1);

  console.log('\n8. Финансы за месяц');
  const month = todayIso().slice(0, 7);
  repo.insertRow('finance_ops', { date: todayIso(), kind: 'payment', amount: 5000, pay_month: month, trip_id: null, waybill_id: null, note: 'Зарплата', auto: 0 });
  const { summarizeFinance } = await import('../lib/calc');
  const fin = summarizeFinance(month);
  eq('начислено за месяц', fin.charged, 12000);
  eq('оплачено за месяц', fin.paid, 5000);
  eq('остаток', fin.balance, 7000);

  console.log('\n9. Экспорт и импорт');
  const dump = dumpAll();
  check('в выгрузке есть все таблицы', Object.keys(dump).length === 13);
  check('перевозка попала в выгрузку', dump.trips.some((t) => t.id === tripId));

  const csv = toCsv(dump.places);
  const parsed = parseCsv(csv);
  eq('CSV: строк столько же', parsed.length, dump.places.length);
  eq('CSV: название места', parsed.find((r) => r.id === placeA)?.name, 'Склад А');
  check('CSV: разделитель точка с запятой', csv.includes(';'));

  const zip = new JSZip();
  zip.file('places.csv', toCsv(dump.places));
  zip.file('companies.csv', toCsv(dump.companies));
  const zipBytes = await zip.generateAsync({ type: 'uint8array' });
  const importRes = await importCsvZip(zipBytes);
  eq('импорт ZIP: ничего не добавилось (всё совпало)', importRes.inserted, 0);
  check('импорт ZIP: записи пропущены', importRes.skipped > 0);

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

  console.log('\n12. Индикатор «ожидают отправки»');
  resetSyncMarkers();
  const stateBefore = syncState();
  eq('облако не настроено', stateBefore.configured, false);
  eq('нет входа', stateBefore.signedIn, false);
  check('все записи ждут отправки', stateBefore.pending > 0);
  const tablesPending = pendingByTable();
  eq(
    'сумма по таблицам совпадает с общим числом',
    tablesPending.reduce((acc, t) => acc + t.count, 0),
    stateBefore.pending,
  );
  check('перевозка отмечена как ожидающая', isPending('trips', tripId));

  await new Promise((r) => setTimeout(r, 15));
  useApp.getState().saveSetting('sync_pushed_at', new Date().toISOString());
  eq('после отправки ничего не ждёт', syncState().pending, 0);
  eq('перевозка отправлена', isPending('trips', tripId), false);

  await new Promise((r) => setTimeout(r, 15));
  repo.updateRow('places', placeA, { note: 'изменено после отправки' });
  check('правка снова ждёт отправки', isPending('places', placeA));
  eq('ждёт одна запись', syncState().pending, 1);

  repo.updateRow('places', placeA, { note: '' });
  resetSyncMarkers();
  check('после полной сверки снова ждёт всё', syncState().pending > 1);

  deleteDocument(docId);
  eq('документ удалён', countDocs('waybills', waybillId), 0);

  console.log('\n13. Сохранение базы');
  await db.flush();
  check('база записана', db.export().length > 0);

  console.log('\n14. Утилиты');
  eq('формат даты', fmtDate('2026-11-12'), '12.11.2026');
  eq('координаты', JSON.stringify(parseCoords('56.001765,37.531211')), JSON.stringify({ lat: 56.001765, lon: 37.531211 }));
  eq('координаты с пробелом', JSON.stringify(parseCoords('56.001765 37.531211')), JSON.stringify({ lat: 56.001765, lon: 37.531211 }));
  eq('название месяца', monthLabel('2026-11'), 'Ноябрь 2026 г.');

  console.log('\n15. ИИ-помощник');
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

  console.log('\n16. Экраны приложения');

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
    { label: 'Умный импорт', route: '/data/smart', url: '/data/smart', load: () => import('../pages/SmartImport') },
    { label: 'Ещё', route: '/more', url: '/more', load: () => import('../pages/More') },
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
    check('Гамма по умолчанию — тёмно-синяя', css.includes('--brand: #0f4c81'));
    check('Есть бирюзовая гамма', css.includes("[data-palette='teal']"));
    check('Бирюзовая гамма перекрывает тёмную тему', css.includes("[data-theme='dark'][data-palette='teal']"));
    check(
      'Порядок блоков: бирюзовая идёт после тёмной темы',
      css.indexOf("[data-palette='teal']") > css.indexOf("[data-theme='dark']"),
    );
    check('Свечение берёт цвет из гаммы', css.includes('rgba(var(--brand-rgb)'));
    check('Заставка берёт фон из гаммы', css.includes('background: var(--splash-bg)'));
  } catch (e) {
    check('CSS читает отступы системных панелей', false, e instanceof Error ? e.message : String(e));
  }

  console.log('\n16б. Оформление');
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

  console.log('\n17. Импорт ZIP в пустую базу');
  {
    const { TABLES } = await import('../types');
    const full = dumpAll();
    const zipAll = new JSZip();
    for (const t of TABLES) zipAll.file(`${t}.csv`, toCsv(full[t]));
    const zipAllBytes = await zipAll.generateAsync({ type: 'uint8array' });

    const placesBefore = repo.countRows('places');
    const tripsBefore = repo.countRows('trips');
    db.tx(() => {
      for (const t of TABLES) dbSync().run(`DELETE FROM ${t}`);
    });
    eq('база очищена', repo.countRows('places'), 0);

    const restored = await importCsvZip(zipAllBytes);
    check(
      'импорт в пустую базу добавил записи',
      restored.inserted > 0,
      `(добавлено ${restored.inserted}, пропущено ${restored.skipped})`,
    );
    eq('места восстановлены', repo.countRows('places'), placesBefore);
    eq('перевозки восстановлены', repo.countRows('trips'), tripsBefore);
  }

  console.log('\n18. Умный импорт чужого архива');
  {
    const si = await import('../lib/smart-import');

    const foreign = [
      'Дата;Путевой лист;Откуда;Куда;Вес, кг;Сумма;Груз;Тент',
      '05.11.2026;ПЛ-777;Карьер Север;Порт Юг;18 500;12 000;Отсев;есть',
      '06.11.2026;ПЛ-777;Порт Юг;База Запад;900;1 500;ПГС;нет',
    ].join('\n');
    const sheets = await si.readArchive(new TextEncoder().encode(foreign), 'Рейсы.csv');

    eq('архив прочитан', sheets.length, 1);
    eq('колонок в файле', sheets[0].columns.length, 8);

    const plan = si.buildPlan(sheets);
    const sheetPlan = plan.sheets[0];
    eq('файл распознан как перевозки', sheetPlan.table, 'trips');
    const mapped = sheetPlan.links.map((l) => l.to);
    for (const field of ['date', 'waybill_number', 'place_from', 'place_to', 'weight', 'amount', 'cargo_name']) {
      check(`колонка «${field}» распознана`, mapped.includes(field));
    }
    check('лишняя колонка осталась в стороне', sheetPlan.unknown.includes('Тент'));
    check('подсказка про лишнее поле', plan.advice.some((a) => a.includes('Тент')));

    const tripsBefore = repo.countRows('trips');
    const res = si.applyPlan(sheets, plan);
    eq('перенесено перевозок', res.inserted.trips, 2);
    eq('перевозок стало больше', repo.countRows('trips'), tripsBefore + 2);
    eq('места созданы', res.created.places, 3);
    eq('грузы созданы', res.created.cargo_types, 2);
    eq('путевой лист создан', res.created.waybills, 1);

    const wb = repo.waybillRepo.list().find((w) => w.number === 'ПЛ-777');
    check('номер листа перенесён', Boolean(wb));

    const trip = repo.tripRepo
      .all()
      .find((t) => repo.tripRepo.points(t.id).some((p) => repo.refs.place(p.place_id)?.name === 'Карьер Север'));
    check('перевозка с точками создана', Boolean(trip));
    if (trip) {
      const points = repo.tripRepo.points(trip.id);
      eq('точек у перевозки', points.length, 2);
      eq('первая точка — погрузка', points[0].kind, 'load');
      eq('вторая точка — выгрузка', points[1].kind, 'unload');
      eq('точки выполнены', points.filter((p) => p.status === 'done').length, 2);
      eq('вес перенесён', trip.weight, 18500);
      eq('сумма перенесена', trip.amount, 12000);
      eq('груз привязан', repo.refs.cargoType(trip.cargo_type_id)?.name, 'Отсев');
      eq('лист привязан', trip.waybill_id, wb?.id);
    }

    // Файл без понятного имени: таблицу подсказывают колонки
    const fuel = await si.readArchive(
      new TextEncoder().encode('Дата;Количество;Тип\n07.11.2026;350;АЗС'),
      'Данные.csv',
    );
    const fuelPlan = si.buildPlan(fuel);
    eq('таблица угадана по колонкам', fuelPlan.sheets[0].table, 'refuelings');
    const fuelRes = si.applyPlan(fuel, fuelPlan);
    eq('заправка перенесена', fuelRes.inserted.refuelings, 1);

    // Старый архив в windows-1251 — так выгружает Excel
    const legacy = new Uint8Array([
      196, 224, 242, 224, 59, 204, 229, 241, 242, 238, 59, 194, 229, 241, 10, 48, 49, 46, 49, 49,
      46, 50, 48, 50, 54, 59, 202, 224, 240, 252, 229, 240, 32, 209, 229, 226, 229, 240, 59, 49, 48,
      48,
    ]);
    const legacySheets = await si.readArchive(legacy, 'Места.csv');
    eq('кодировка windows-1251 разобрана', legacySheets[0].columns.join(';'), 'Дата;Место;Вес');
    eq('значение в windows-1251 прочитано', legacySheets[0].rows[0]['Место'], 'Карьер Север');

    // Даты и месяцы в разных форматах
    eq('дата ДД.ММ.ГГГГ', si.parseDateValue('05.11.2026'), '2026-11-05');    eq('дата ГГГГ-ММ-ДД', si.parseDateValue('2026-11-05'), '2026-11-05');
    eq('месяц словом', si.parseMonthValue('Ноябрь 2026'), '2026-11');
    eq('месяц точкой', si.parseMonthValue('11.2026'), '2026-11');

    // ИИ уточняет разбор, когда имена колонок ничего не говорят
    const originalFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '{"sheets":[{"source":"таблица","table":"places","confidence":0.9,' +
                  '"columns":{"A":"name","B":"address"}}],"advice":["Добавьте поле «Район»"]}',
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch;
    try {
      const vague = await si.readArchive(
        new TextEncoder().encode('A;B\nБаза Юг;Москва, Ленина 1'),
        'таблица.csv',
      );
      const rawPlan = si.buildPlan(vague);
      eq('без ИИ таблица не угадана', rawPlan.sheets[0].table, null);
      const refined = await si.refineWithAi(vague, rawPlan);
      eq('ИИ подставил таблицу', refined.sheets[0].table, 'places');
      eq('пометка источника — ИИ', refined.sheets[0].via, 'ИИ');
      check('совет ИИ добавлен', refined.advice.some((a) => a.includes('Район')));
      const vagueRes = si.applyPlan(vague, refined);
      eq('перенесено в места', vagueRes.inserted.places, 1);
      check('место создано', repo.refs.places().some((p) => p.name === 'База Юг'));
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }

    // Чужой архив с запятыми: разделитель подбирается по самому файлу,
    // иначе вся строка становится одной колонкой и всё уезжает в «Автомобили»
    const commaSheets = await si.readArchive(
      new TextEncoder().encode(
        'Дата,Машина,Откуда,Куда,Вес,Сумма\n05.11.2026,Volvo FH,Склад А,Склад Б,18500,42000',
      ),
      'Лист1.csv',
    );
    eq(
      'запятая как разделитель разобрана',
      commaSheets[0].columns.join('|'),
      'Дата|Машина|Откуда|Куда|Вес|Сумма',
    );
    eq('перевозки не ушли в автомобили', si.buildPlan(commaSheets).sheets[0].table, 'trips');
    const { summarizePlan } = await import('../pages/SmartImport');
    const summary = summarizePlan(si.buildPlan(commaSheets));
    eq('итог по таблицам посчитан', `${summary[0][0]}:${summary[0][1]}`, 'Перевозки:1');

    // Строка без разделителей: одна колонка со всеми словами — таблица не угадана
    const oneCol = await si.readArchive(
      new TextEncoder().encode(
        'Дата Машина Откуда Куда Вес Сумма\n05.11.2026 Volvo Склад А Склад Б 18500 42000',
      ),
      'данные.csv',
    );
    eq('одна колонка не свалилась в автомобили', si.buildPlan(oneCol).sheets[0].table, null);

    // Перенос можно отменить: журнал помнит добавленные записи
    const undoBefore = repo.countRows('places');
    const undoSheets = await si.readArchive(
      new TextEncoder().encode('Дата;Место;Вес\n05.11.2026;Карьер Юг;18000'),
      'Места.csv',
    );
    const undoRes = si.applyPlan(undoSheets, si.buildPlan(undoSheets));
    eq('перенос отдал список записей', undoRes.ids.places?.length, 1);
    check('журнал запомнил место', repo.countRows('places') === undoBefore + 1);
    eq('отмена убрала запись', repo.softDeleteMany('places', undoRes.ids.places ?? []), 1);
    eq('после отмены записей столько же', repo.countRows('places'), undoBefore);

    // Фильтр по месяцам показывает только месяцы с данными
    const { monthChoices, fmtDateTime } = await import('../lib/format');
    const choices = monthChoices(['2026-03', '2024-01'], '2019-07');
    check('месяц с данными в списке', choices.includes('2026-03'));
    check('пустые месяцы не показаны', !choices.includes('2022-05'));
    check('выбранный месяц сохранён', choices.includes('2019-07'));
    check('месяцы идут по убыванию', choices.join('|') === [...choices].sort((a, b) => b.localeCompare(a)).join('|'));
    eq('пустой список — только текущий месяц', monthChoices().length, 1);

    // Понятная подсказка вместо «Failed to fetch»
    const { urlProblem } = await import('../lib/supabase');
    check('адрес сайта распознан как ошибка', urlProblem('https://supabase.com').includes('сайта Supabase'));
    eq('правильный адрес без замечаний', urlProblem('https://abcd1234.supabase.co'), '');
    check('адрес без схемы распознан', urlProblem('abcd1234.supabase.co').includes('https://'));
    eq('пустой адрес без замечаний', urlProblem('   '), '');
    const months = repo.usedMonths();
    check('месяцы с данными найдены', months.length > 0);
    check('формат месяцев верный', months.every((m) => /^\d{4}-\d{2}$/.test(m)));

    // Чужой архив из 11 файлов с английскими именами и camelCase-колонками
    const archiveZip = new JSZip();
    archiveZip.file(
      '01-vehicles.csv',
      'id,name,brand,model,plate,vin,year,fuelNorm,type,notes\n' +
        'v1,Volvo FH,Volvo,FH,А123ВС777,X1Y2Z3,2019,32,tractor,\n' +
        'v2,Schmitz,Schmitz,SCB,ВЕ4567,ZZZ,2020,,trailer,',
    );
    archiveZip.file(
      '02-companies.csv',
      'id,name,typicalCargoId,existingLogoUrl,internetLogoUrl,hostingLogoUrl\n' +
        'c1,ООО Ромашка,k1,,,',
    );
    archiveZip.file(
      '03-cargos.csv',
      'id,name,existingLogoUrl,internetLogoUrl,hostingLogoUrl\nk1,Песок,,,\nk2,Щебень гранитный,,,',
    );
    archiveZip.file(
      '04-places.csv',
      'id,name,contact,coordinates,address,loadType,notes,companyId,typicalCargoId\n' +
        'p1,Карьер Архив,Иван 900,"55.75, 37.61",Москва,rear,,c1,k1',
    );
    archiveZip.file(
      '05-periods.csv',
      'id,name,startDate,endDate,vehicleId\npr1,2019 год,01.01.2019,31.12.2019,v1',
    );
    archiveZip.file(
      '06-waybills.csv',
      'id,name,departureDate,returnDate,odometerOut,odometerIn,fuelOut,fuelIn,notes,periodId,vehicleId,trailerId\n' +
        'w1,Лист 1,05.11.2026,06.11.2026,100000,100500,300,250,,pr1,v1,v2',
    );
    archiveZip.file(
      '07-trips.csv',
      'id,name,cargo,weightKg,loadingType,accrual,notes,waybillId\n' +
        't1,Рейс с песком,Песок,20000,rear,12000,,w1\n' +
        // У второй перевозки груз не указан: название не должно превратиться в груз
        't2,08.05.2026 · МО_СОЛНЕЧНОГОРСК → Шушары,,4097,rear,11500,,w1',
    );
    archiveZip.file(
      '08-stops.csv',
      'id,name,order,date,plannedDate,arrivedAt,placeName,direction,tripId,placeId,companyId\n' +
        's1,Погрузка,1,05.11.2026,05.11.2026,05.11.2026,Карьер Архив,load,t1,p1,c1\n' +
        's2,Выгрузка,2,06.11.2026,06.11.2026,06.11.2026,Склад Юг,unload,t1,,c1\n' +
        's3,Погрузка,1,07.11.2026,07.11.2026,07.11.2026,Карьер Архив,load,t2,p1,c1\n' +
        's4,Выгрузка,2,08.11.2026,08.11.2026,08.11.2026,Склад Юг,unload,t2,,c1',
    );
    archiveZip.file('09-gas-stations.csv', 'id,name,notes,existingLogoUrl,internetLogoUrl,hostingLogoUrl\ng1,Лукойл-Тест,,,,\n');
    archiveZip.file(
      '10-fuels.csv',
      'id,name,unknownTime,liters,source,dateTime,waybillId,gasStationId\n' +
        'f1,Заправка,,250,station,05.11.2026 08:30,w1,g1',
    );
    archiveZip.file(
      '11-finances.csv',
      'id,name,type,date,amount,month,description,reconciliationStatus,tripId,waybillId\n' +
        'fi1,Начисление,charge,06.11.2026,12000,11.2026,За рейс,done,t1,w1\n' +
        'fi2,Оплата,Оплачено,07.11.2026,12000,2026-11-01T00:00:00.000Z,Получено,done,,w1',
    );
    const archiveSheets = await si.readArchive(await archiveZip.generateAsync({ type: 'uint8array' }), 'avtobaza.zip');
    const archivePlan = si.buildPlan(archiveSheets);
    const tableOf = (file: string) => archivePlan.sheets.find((s) => s.source === file)?.table ?? null;
    eq('файлов в чужом архиве', archiveSheets.length, 11);
    eq('01-vehicles → автомобили', tableOf('01-vehicles'), 'vehicles');
    eq('02-companies → фирмы', tableOf('02-companies'), 'companies');
    eq('03-cargos → грузы', tableOf('03-cargos'), 'cargo_types');
    eq('04-places → места', tableOf('04-places'), 'places');
    eq('05-periods → периоды', tableOf('05-periods'), 'vehicle_periods');
    eq('06-waybills → листы', tableOf('06-waybills'), 'waybills');
    eq('07-trips → перевозки', tableOf('07-trips'), 'trips');
    eq('08-stops → точки', tableOf('08-stops'), 'trip_points');
    eq('09-gas-stations → АЗС', tableOf('09-gas-stations'), 'fuel_stations');
    eq('10-fuels → заправки', tableOf('10-fuels'), 'refuelings');
    eq('11-finances → финансы', tableOf('11-finances'), 'finance_ops');

    const linkOf = (file: string, column: string) =>
      archivePlan.sheets.find((s) => s.source === file)?.links.find((l) => l.from === column);
    eq('06-waybills.vehicleId — ссылка на автомобиль', linkOf('06-waybills', 'vehicleId')?.fk?.target, 'vehicles');
    eq('07-trips.waybillId — ссылка на лист', linkOf('07-trips', 'waybillId')?.fk?.target, 'waybills');
    eq('08-stops.tripId — ссылка на перевозку', linkOf('08-stops', 'tripId')?.fk?.target, 'trips');
    eq('10-fuels.gasStationId — ссылка на АЗС', linkOf('10-fuels', 'gasStationId')?.fk?.target, 'fuel_stations');
    eq('колонка id — ключ записи', archivePlan.sheets.find((s) => s.source === '07-trips')?.idColumn, 'id');
    eq('camelCase departureDate → date_out', linkOf('06-waybills', 'departureDate')?.to, 'date_out');
    eq('camelCase odometerIn → odometer_in', linkOf('06-waybills', 'odometerIn')?.to, 'odometer_in');
    eq('accrual → начислено', linkOf('07-trips', 'accrual')?.to, 'amount');
    eq('weightKg → вес', linkOf('07-trips', 'weightKg')?.to, 'weight');
    eq('arrivedAt → фактическая дата', linkOf('08-stops', 'arrivedAt')?.to, 'fact_date');
    eq('direction → тип точки', linkOf('08-stops', 'direction')?.to, 'kind');
    eq('liters → количество', linkOf('10-fuels', 'liters')?.to, 'volume');
    eq('month → месяц оплаты', linkOf('11-finances', 'month')?.to, 'pay_month');
    check('название перевозки не стало грузом', !linkOf('07-trips', 'name'));
    check('название точки не стало местом', !linkOf('08-stops', 'name'));
    check('название заправки не стало АЗС', !linkOf('10-fuels', 'name'));
    check('служебная колонка unknownTime пропущена', !linkOf('10-fuels', 'unknownTime'));
    check(
      'служебные логотипы не мешают',
      !(archivePlan.sheets.find((s) => s.source === '03-cargos')?.unknown ?? []).some((c) =>
        c.toLowerCase().includes('logo'),
      ),
    );

    const archiveZipResult = si.applyPlan(archiveSheets, archivePlan);
    eq('автомобилей перенесено', archiveZipResult.inserted.vehicles, 2);
    eq('фирм перенесено', archiveZipResult.inserted.companies, 1);
    eq('грузов перенесено', archiveZipResult.inserted.cargo_types, 2);
    eq('мест из файла перенесено', archiveZipResult.inserted.places, 1);
    eq('периодов перенесено', archiveZipResult.inserted.vehicle_periods, 1);
    eq('листов перенесено', archiveZipResult.inserted.waybills, 1);
    eq('перевозок перенесено', archiveZipResult.inserted.trips, 2);
    eq('точек перенесено', archiveZipResult.inserted.trip_points, 4);
    eq('заправок перенесено', archiveZipResult.inserted.refuelings, 1);
    eq('финансов перенесено', archiveZipResult.inserted.finance_ops, 2);

    // Связи между таблицами должны восстановиться по старым идентификаторам
    const mine = (table: string, id: string | undefined) => (archiveZipResult.ids[table] ?? []).includes(id ?? '');
    const newVehicle = repo.refs.vehicles().find((v) => v.name === 'Volvo FH' && mine('vehicles', v.id));
    const newWaybill = repo.waybillRepo.list().find((w) => mine('waybills', w.id));
    const newTrip = repo.tripRepo.get((archiveZipResult.ids.trips ?? [])[0] ?? '');
    const newPlace = repo.refs.places().find((p) => p.name === 'Карьер Архив' && mine('places', p.id));
    eq('лист связан с автомобилем', newWaybill?.vehicle_id, newVehicle?.id);
    eq('одометр листа перенесён', newWaybill?.odometer_out, 100000);
    eq('тоннаж листа перенесён', newWaybill?.odometer_in, 100500);
    eq('лист с датой приезда закрыт', newWaybill?.status, 'closed');
    eq('перевозка связана с листом', newTrip?.waybill_id, newWaybill?.id);
    eq('вес перевозки перенесён', newTrip?.weight, 20000);
    const points = newTrip ? repo.tripRepo.points(newTrip.id) : [];
    eq('точек у перевозки из чужого архива', points.length, 2);
    eq('точка погрузки связана с местом', points[0]?.place_id, newPlace?.id);
    eq('тип точки из direction', points[0]?.kind, 'load');
    eq('тип второй точки из direction', points[1]?.kind, 'unload');
    eq('выполненная точка отмечена', points[0]?.status, 'done');
    eq('перевозка с начислением — «начислена»', newTrip?.status, 'charged');
    const secondTrip = repo.tripRepo.get((archiveZipResult.ids.trips ?? [])[1] ?? '');
    eq('выполненная перевозка без начисления — «выполнена»', secondTrip?.status, 'done');
    check(
      'название перевозки без груза не стало грузом',
      !repo.refs.cargoTypes().some((c) => c.name.includes('МО_СОЛНЕЧН')),
    );
    const newStation = repo.refs.fuelStations().find((s) => s.name === 'Лукойл-Тест' && mine('fuel_stations', s.id));
    const fuelRow = repo.refuelRepo.list().find((f) => mine('refuelings', f.id));
    eq('заправка связана с АЗС', fuelRow?.station_id, newStation?.id);
    eq('заправка связана с листом', fuelRow?.waybill_id, newWaybill?.id);
    eq('дата заправки из dateTime', fuelRow?.date, '2026-11-05');
    eq('тип заправки из source', fuelRow?.kind, 'station');
    eq('количество литров перенесено', fuelRow?.volume, 250);
    const fin = repo.financeRepo.get((archiveZipResult.ids.finance_ops ?? [])[0] ?? '');
    eq('финансы связаны с перевозкой', fin?.trip_id, newTrip?.id);
    eq('месяц оплаты перенесён', fin?.pay_month, '2026-11');
    eq('тип операции из type', fin?.kind, 'charge');
    eq('сумма финансов перенесена', fin?.amount, 12000);
    const pay = repo.financeRepo.get((archiveZipResult.ids.finance_ops ?? [])[1] ?? '');
    eq('«Оплачено» — это поступление', pay?.kind, 'payment');
    eq('месяц оплаты из момента времени', pay?.pay_month, '2026-11');
    const place = repo.refs.place((archiveZipResult.ids.places ?? [])[0] ?? null);
    eq('координаты разобраны', place?.lat, 55.75);
    eq('долгота разобрана', place?.lon, 37.61);
    eq('фирма места связана', place?.company_id, repo.refs.companies().find((c) => c.name === 'ООО Ромашка')?.id);
    eq('груз места связан', place?.cargo_type_id, repo.refs.cargoTypes().find((c) => c.name === 'Песок' && mine('cargo_types', c.id))?.id);
    eq('тип загрузки места перенесён', place?.load_type, 'rear');
    eq('название места перенесено', place?.name, 'Карьер Архив');
    const periodVehicle = repo.vehicleRepo.periods(newVehicle?.id ?? '');
    eq('период связан с автомобилем', periodVehicle.length, 1);
    eq('дата начала периода перенесена', periodVehicle[0]?.start_date, '2019-01-01');
    eq('дата конца периода перенесена', periodVehicle[0]?.end_date, '2019-12-31');
    check('место выгрузки создано по названию', repo.refs.places().some((p) => p.name === 'Склад Юг'));
    check('связи между таблицами посчитаны', archiveZipResult.message.includes('связей между таблицами'));

    // Повторный перенос того же архива не должен плодить справочники
    const cargosBefore = repo.refs.cargoTypes().length;
    const repeat = si.applyPlan(archiveSheets, archivePlan);
    eq('грузы не задвоились', repeat.inserted.cargo_types ?? 0, 0);
    eq('автомобили не задвоились', repeat.inserted.vehicles ?? 0, 0);
    eq('фирмы не задвоились', repeat.inserted.companies ?? 0, 0);
    eq('АЗС не задвоились', repeat.inserted.fuel_stations ?? 0, 0);
    eq('места не задвоились', repeat.inserted.places ?? 0, 0);
    eq('справочник грузов не вырос', repo.refs.cargoTypes().length, cargosBefore);
    check('в итоге сказано про уже бывшие записи', repeat.message.includes('уже были в базе'));

    // Даты и месяцы из чужого архива: местная полночь записана как момент времени в UTC
    eq('полночь МСК → тот же день', si.parseDateValue('2026-11-10T21:00:00.000Z'), '2026-11-11');
    eq('момент времени → местная дата', si.parseDateValue('2026-11-11T12:37:00.000Z'), '2026-11-11');
    eq('месяц из момента времени', si.parseMonthValue('2026-11-01T00:00:00.000Z'), '2026-11');
    eq('месяц из полной даты', si.parseMonthValue('2026-11-12'), '2026-11');
    eq('дата без времени — без лишних часов', fmtDateTime('2026-11-11'), '11.11.2026');
    eq('дата со временем показывает часы', fmtDateTime('2026-11-11T15:37:00'), '11.11.2026, 15:37');
  }

  console.log('\n19. Текущая поездка: статусы, порядок и навигация');
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

  console.log('\n20. Заявка из файлов: разбор, справочники и поездка');
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

    check('за раз принимается несколько файлов', ord.MAX_FILES >= 3);

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
    }
  }

  console.log(`\nПроверок пройдено: ${passed}, ошибок: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('\nСбой проверки:', e);
  process.exit(1);
});

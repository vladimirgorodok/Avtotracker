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
  eq('вес по точкам', summary.totalWeight, 40000);
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

  const backup = JSON.stringify({ app: 'avtotracker', version: 1, tables: dump, settings: [] });
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
  check('системная подсказка описывает роль', sys.includes('Автотрекер'));
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
    check('системное сообщение содержит данные', lastSent.messages[0].content.includes('Автотрекер'));
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
    check('понятная ошибка при неверном ключе', errorText.includes('Неверный ключ') && errorText.includes('bad key'), errorText);
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

  console.log(`\nПроверок пройдено: ${passed}, ошибок: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('\nСбой проверки:', e);
  process.exit(1);
});

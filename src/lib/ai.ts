/**
 * ИИ-помощник.
 *
 * Три части:
 * 1) сводка по своим данным — она уходит модели как контекст;
 * 2) запрос к OpenAI-совместимому API (адрес, ключ и модель задаются в настройках);
 * 3) ответы на частые вопросы прямо на устройстве — работают без ключа и без интернета.
 */

import { refs, tripRepo, waybillRepo } from '../db/repo';
import { fmtDate, fmtMoney, fmtNumber, monthKey, plural, todayIso } from './format';
import { summarizeFinance, summarizeTrip, summarizeWaybill } from './calc';
import { deleteBlob, getBlob, putBlob } from './files';
import { useApp } from '../store';

export interface AiConfig {
  baseUrl: string;
  key: string;
  model: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StoredMessage {
  role: 'user' | 'assistant';
  text: string;
  at: string;
  /** Ответ получен без обращения к сервису */
  offline?: boolean;
}

export interface Answer {
  text: string;
  /** true — ответ собран на устройстве, запрос к сервису не отправлялся */
  offline: boolean;
}

const CHAT_KEY = 'chat-assistant.json';
const HISTORY_LIMIT = 40;
const HISTORY_FOR_MODEL = 12;
const PLACES_IN_CONTEXT = 40;

/* ------------------------------------------------------------------ */
/* Настройки                                                          */
/* ------------------------------------------------------------------ */

/** Приводит адрес API к виду https://хост/v1 */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, '');
  try {
    const parsed = new URL(url);
    if (parsed.pathname === '' || parsed.pathname === '/') {
      parsed.pathname = '/v1';
      url = parsed.toString().replace(/\/+$/, '');
    }
  } catch {
    /* неверный адрес проявится при запросе */
  }
  return url;
}

export function readAiConfig(): AiConfig | null {
  const s = useApp.getState().settings;
  const baseUrl = normalizeBaseUrl(s.ai_base_url);
  const key = s.ai_api_key.trim();
  if (!baseUrl || !key) return null;
  return { baseUrl, key, model: s.ai_model.trim() };
}

/** Ключ указан и выбрана модель */
export function isAiReady(): boolean {
  const cfg = readAiConfig();
  return cfg !== null && cfg.model !== '';
}

/* ------------------------------------------------------------------ */
/* Сводка по данным                                                   */
/* ------------------------------------------------------------------ */

function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split('-').map(Number);
  if (!y || !m) return key;
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function km(v: number | null): string {
  return v === null ? '—' : `${fmtNumber(v)} км`;
}

function liters(v: number | null): string {
  return v === null ? '—' : `${fmtNumber(v)} л`;
}

/** Короткая, но полезная сводка по базе — уходит модели вместе с вопросом */
export function buildDataContext(): string {
  const settings = useApp.getState().settings;
  const out: string[] = [];

  out.push(`Сегодня: ${fmtDate(todayIso())}.`);
  out.push(
    `Ставки: ${fmtNumber(settings.base_amount)} за первые ${settings.base_points} точки, ` +
      `плюс ${fmtNumber(settings.extra_point_amount)} за каждую следующую точку.`,
  );

  const waybills = waybillRepo.list();
  const open = waybills.filter((w) => w.status === 'open');
  const closed = waybills.filter((w) => w.status === 'closed');
  const trips = tripRepo.all();
  const places = refs.places();
  out.push(
    `Всего: путевых листов ${waybills.length} (открытых ${open.length}), перевозок ${trips.length}, ` +
      `мест в справочнике ${places.length}, автомобилей ${refs.vehicles().length}.`,
  );

  if (open.length > 0) {
    out.push('Открытые путевые листы:');
    for (const w of open.slice(0, 5)) {
      const t = summarizeWaybill(w);
      out.push(
        `- от ${fmtDate(w.date_out)}, ${t.vehicleTitle || 'без автомобиля'}, одометр на выезде ${km(
          w.odometer_out,
        )}, топливо ${liters(w.fuel_out)}, перевозок ${t.tripsCount}, заправлено ${liters(t.refueled)}.`,
      );
    }
  }

  if (closed.length > 0) {
    out.push('Последние закрытые путевые листы:');
    for (const w of closed.slice(0, 5)) {
      const t = summarizeWaybill(w);
      const tail: string[] = [];
      if (t.avgConsumption !== null) tail.push(`расход ${fmtNumber(t.avgConsumption, 1)} л/100 км`);
      if (t.normConsumption !== null) tail.push(`норма ${liters(t.normConsumption)}`);
      if (t.charged > 0) tail.push(`начислено ${fmtMoney(t.charged, settings.currency)}`);
      if (t.errors.length > 0) tail.push(`ошибки: ${t.errors.join('; ')}`);
      out.push(
        `- ${fmtDate(w.date_out)}—${fmtDate(w.date_in)}, ${t.vehicleTitle || 'без автомобиля'}, пробег ${km(
          t.mileage,
        )}, перевозок ${t.tripsCount}${tail.length > 0 ? ', ' + tail.join(', ') : ''}.`,
      );
    }
  }

  const thisMonth = monthKey(todayIso());
  for (const m of [shiftMonth(thisMonth, -1), thisMonth]) {
    const f = summarizeFinance(m);
    out.push(
      `${m}: начислено ${fmtMoney(f.charged, settings.currency)}, получено ${fmtMoney(
        f.paid,
        settings.currency,
      )}, остаток ${fmtMoney(f.balance, settings.currency)}.`,
    );
  }
  const allTime = summarizeFinance(null);
  out.push(
    `За всё время: начислено ${fmtMoney(allTime.charged, settings.currency)}, получено ${fmtMoney(
      allTime.paid,
      settings.currency,
    )}, остаток ${fmtMoney(allTime.balance, settings.currency)}.`,
  );

  if (trips.length > 0) {
    out.push('Последние перевозки:');
    for (const t of trips.slice(0, 8).map(summarizeTrip)) {
      out.push(
        `- ${fmtDate(t.dateLoad)} ${t.title}, точек ${t.pointsCount} (выполнено ${t.doneCount}), ` +
          `вес ${fmtNumber(t.totalWeight)} кг, начислено ${fmtMoney(t.amount, settings.currency)}, статус ${t.status}.`,
      );
    }
  }

  const vehicles = refs.vehicles();
  if (vehicles.length > 0) {
    out.push(
      `Автомобили: ${vehicles
        .map((v) => `${v.name}${v.plate ? ' (' + v.plate + ')' : ''}`)
        .join(', ')}.`,
    );
  }
  const cargo = refs.cargoTypes();
  if (cargo.length > 0) out.push(`Грузы: ${cargo.map((c) => c.name).join(', ')}.`);
  const companies = refs.companies();
  if (companies.length > 0) out.push(`Фирмы: ${companies.map((c) => c.name).join(', ')}.`);
  if (places.length > 0) {
    out.push(`Места (первые ${Math.min(places.length, PLACES_IN_CONTEXT)}): ${places.slice(0, PLACES_IN_CONTEXT).map((p) => p.name).join(', ')}.`);
  }

  return out.join('\n');
}

export function systemPrompt(): string {
  return [
    'Ты помощник водителя грузовика в приложении «Автотрекер» (путевые листы, перевозки, топливо, финансы).',
    'Отвечай по-русски, коротко и по делу, без вступлений и извинений.',
    'Опирайся только на данные ниже. Не выдумывай цифры: если данных нет, скажи об этом прямо и подскажи, что заполнить.',
    'Ты считаешь и советуешь, но сам ничего не записываешь в базу — предложи, что и где заполнить.',
    '',
    'Данные приложения:',
    buildDataContext(),
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Запросы к сервису                                                  */
/* ------------------------------------------------------------------ */

async function describeError(res: Response): Promise<string> {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text) as { error?: { message?: string }; message?: string };
      detail = json.error?.message ?? json.message ?? text;
    } catch {
      detail = text;
    }
  } catch {
    /* тело недоступно */
  }
  detail = detail.replace(/\s+/g, ' ').trim().slice(0, 300);
  const byStatus: Record<number, string> = {
    401: 'Неверный ключ доступа',
    403: 'Доступ к модели запрещён',
    404: 'Адрес API или название модели указаны неверно',
    422: 'Сервис не принял запрос',
    429: 'Слишком много запросов, попробуйте позже',
    500: 'Сбой на стороне сервиса',
    502: 'Сервис недоступен',
    503: 'Сервис перегружен',
  };
  const base = byStatus[res.status] ?? `Ошибка сервиса (${res.status})`;
  return detail ? `${base}: ${detail}` : base;
}

function headerLines(cfg: AiConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.key}`,
  };
}

/** Список доступных моделей — чтобы выбрать нужную в настройках */
export async function listModels(cfg: AiConfig): Promise<string[]> {
  const res = await fetch(`${cfg.baseUrl}/models`, { headers: headerLines(cfg) });
  if (!res.ok) throw new Error(await describeError(res));
  const json = (await res.json()) as { data?: unknown; models?: unknown };
  const raw = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
  const ids = raw
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        const o = item as { id?: unknown; name?: unknown };
        return String(o.id ?? o.name ?? '');
      }
      return '';
    })
    .filter((id) => id !== '');
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/** Разбор потока SSE: ответ приходит кусками по мере готовности */
async function readStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: string, full: string) => void,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return full;
      try {
        const json = JSON.parse(payload) as {
          choices?: { delta?: { content?: unknown }; message?: { content?: unknown } }[];
        };
        const choice = json.choices?.[0];
        const chunk = choice?.delta?.content ?? choice?.message?.content;
        if (typeof chunk === 'string' && chunk) {
          full += chunk;
          onDelta(chunk, full);
        }
      } catch {
        /* неполный кусок JSON — пропускаем, он придёт в следующей порции */
      }
    }
  }
  return full;
}

/** Запрос к модели. Если передан onDelta — ответ читается потоком */
export async function askModel(
  cfg: AiConfig,
  messages: ChatMessage[],
  onDelta?: (delta: string, full: string) => void,
): Promise<string> {
  if (!cfg.model) throw new Error('Выберите модель в настройках ИИ');

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: headerLines(cfg),
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: 0.2,
      stream: Boolean(onDelta),
    }),
  });
  if (!res.ok) throw new Error(await describeError(res));

  if (onDelta && res.body) {
    const text = await readStream(res.body, onDelta);
    if (!text.trim()) throw new Error('Сервис вернул пустой ответ');
    return text;
  }

  const json = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('Сервис вернул пустой ответ');
  return content;
}

/* ------------------------------------------------------------------ */
/* Ответы без ключа: частые вопросы                                   */
/* ------------------------------------------------------------------ */

function financeBlock(): string {
  const settings = useApp.getState().settings;
  const thisMonth = monthKey(todayIso());
  const rows: string[] = [];
  for (const m of [thisMonth, shiftMonth(thisMonth, -1)]) {
    const f = summarizeFinance(m);
    rows.push(`${m}: начислено ${fmtMoney(f.charged, settings.currency)}, получено ${fmtMoney(f.paid, settings.currency)}, остаток ${fmtMoney(f.balance, settings.currency)}.`);
  }
  const all = summarizeFinance(null);
  rows.push(`За всё время: начислено ${fmtMoney(all.charged, settings.currency)}, получено ${fmtMoney(all.paid, settings.currency)}, остаток ${fmtMoney(all.balance, settings.currency)}.`);
  return rows.join('\n');
}

function fuelBlock(): string {
  const closed = waybillRepo.list().filter((w) => w.status === 'closed').slice(0, 5);
  if (closed.length === 0) return 'Закрытых путевых листов пока нет — расход посчитать не из чего.';
  const rows: string[] = [];
  let mileages = 0;
  let fuel = 0;
  for (const w of closed) {
    const t = summarizeWaybill(w);
    if (t.mileage === null || t.consumed === null) {
      rows.push(`${fmtDate(w.date_out)}: данных мало (нужны одометр и топливо при выезде и сдаче).`);
      continue;
    }
    mileages += t.mileage;
    fuel += t.consumed;
    rows.push(
      `${fmtDate(w.date_out)}—${fmtDate(w.date_in)}: пробег ${fmtNumber(t.mileage)} км, израсходовано ${fmtNumber(
        t.consumed,
      )} л, средний расход ${fmtNumber(t.avgConsumption, 1)} л/100 км${t.avgConsumption !== null && t.normConsumption !== null && t.consumed > t.normConsumption ? ' — перерасход к норме' : ''}.`,
    );
  }
  if (mileages > 0) {
    rows.push(
      `По ${plural(closed.length, 'листу', 'листам', 'листам')} всего: ${fmtNumber(mileages)} км, ${fmtNumber(
        fuel,
      )} л, средний расход ${fmtNumber((fuel / mileages) * 100, 1)} л/100 км.`,
    );
  }
  return rows.join('\n');
}

function openWaybillsBlock(): string {
  const open = waybillRepo.open();
  if (open.length === 0) {
    const last = waybillRepo.list()[0];
    return last
      ? `Открытых листов нет. Последний лист — от ${fmtDate(last.date_out)}, ${last.status === 'closed' ? 'закрыт' : last.status}.`
      : 'Путевых листов пока нет.';
  }
  const rows = open.map((w) => {
    const t = summarizeWaybill(w);
    const pending = t.trips.filter((x) => x.pointsCount > 0 && x.doneCount < x.pointsCount);
    return `- от ${fmtDate(w.date_out)}, ${t.vehicleTitle || 'без автомобиля'}: перевозок ${t.tripsCount}, не завершено точек — ${pending.length === 0 ? 'нет' : pending.map((x) => x.title).join('; ')}.`;
  });
  return ['Открытых листов: ' + open.length + '.', ...rows].join('\n');
}

function errorsBlock(): string {
  const rows: string[] = [];
  for (const w of waybillRepo.list().slice(0, 15)) {
    const t = summarizeWaybill(w);
    if (t.errors.length === 0 && t.warnings.length === 0) continue;
    const parts: string[] = [];
    if (t.errors.length > 0) parts.push(`ошибки: ${t.errors.join('; ')}`);
    if (t.warnings.length > 0) parts.push(`внимание: ${t.warnings.join('; ')}`);
    rows.push(`- лист от ${fmtDate(w.date_out)}: ${parts.join(' | ')}`);
  }
  if (rows.length === 0) return 'Проверено последние 15 листов — ошибок и замечаний нет.';
  return ['Нашёл замечания:', ...rows].join('\n');
}

function refsBlock(): string {
  const places = refs.places();
  const vehicles = refs.vehicles();
  return [
    `Мест в справочнике: ${places.length}.`,
    `Автомобилей: ${vehicles.length}${vehicles.length > 0 ? ' — ' + vehicles.map((v) => `${v.name}${v.plate ? ' (' + v.plate + ')' : ''}`).join(', ') : ''}.`,
    `Фирм: ${refs.companies().length}, грузов: ${refs.cargoTypes().length}, АЗС: ${refs.fuelStations().length}.`,
  ].join('\n');
}

function tripsBlock(): string {
  const trips = tripRepo.all().slice(0, 8);
  if (trips.length === 0) return 'Перевозок пока нет.';
  return [
    'Последние перевозки:',
    ...trips.map((t) => {
      const s = summarizeTrip(t);
      return `- ${fmtDate(s.dateLoad)} ${s.title}, точек ${s.pointsCount}, вес ${fmtNumber(s.totalWeight)} кг, начислено ${fmtMoney(s.amount)}.`;
    }),
  ].join('\n');
}

const OFFLINE_HINT = [
  'Ключ ИИ-сервиса не задан, поэтому отвечаю только на простые вопросы по вашим данным.',
  'Попробуйте спросить про итоги месяца, расход топлива, открытые листы, перевозки, замечания или справочники.',
  'Чтобы задавать любые вопросы, укажите адрес API, ключ и модель в настройках ИИ.',
].join('\n');

/** Ответ на частый вопрос без обращения к сервису. null — вопрос не распознан. */
export function localAnswer(question: string): string | null {
  const q = question.toLowerCase();
  const has = (...words: string[]) => words.some((w) => q.includes(w));

  if (has('привет', 'здравствуй', 'добрый день', 'добрый вечер', 'доброе утро')) {
    return [
      'Здравствуйте. Могу показать итоги месяца, расход топлива, открытые листы, перевозки и замечания.',
      'Спросите, например: «сколько начислено за этот месяц».',
    ].join('\n');
  }
  if (has('расход', 'топлив', 'солярк', 'заправ', 'л/100', 'норма')) return fuelBlock();
  if (has('пробег', 'одометр', 'сколько проехал', 'километр')) return fuelBlock();
  if (has('ошибк', 'ошибку', 'замечан', 'проверь', 'провер', 'правильно ли')) return errorsBlock();
  if (has('начисл', 'заработал', 'заработ', 'опла', 'оплат', 'поступил', 'доход', 'итог', 'остаток', 'деньг', 'финанс', 'долг', 'зарплат')) {
    return financeBlock();
  }
  if (has('открыт', 'незакрыт', 'текущ')) return openWaybillsBlock();
  if (has('лист', 'путев')) return openWaybillsBlock();
  if (has('перевозк', 'поездк', 'рейс', 'маршрут')) return tripsBlock();
  if (has('мест', 'справочник', 'адрес', 'фирм', 'груз', 'автомобил', 'машин')) return refsBlock();
  return null;
}

/* ------------------------------------------------------------------ */
/* Единая точка входа                                                 */
/* ------------------------------------------------------------------ */

/**
 * Ответ на вопрос: через сервис, если ключ задан, иначе из данных прямо на устройстве.
 * `history` — предыдущие сообщения (без текущего вопроса).
 */
export async function answer(
  question: string,
  history: StoredMessage[],
  onDelta?: (delta: string, full: string) => void,
): Promise<Answer> {
  const cfg = readAiConfig();
  if (!cfg || !cfg.model) {
    const local = localAnswer(question);
    return { text: local ?? OFFLINE_HINT, offline: true };
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt() },
    ...history.slice(-HISTORY_FOR_MODEL).map((m) => ({ role: m.role, content: m.text }) as ChatMessage),
    { role: 'user', content: question },
  ];
  const text = await askModel(cfg, messages, onDelta);
  return { text, offline: false };
}

/* ------------------------------------------------------------------ */
/* История переписки (хранится на устройстве)                         */
/* ------------------------------------------------------------------ */

export async function loadChat(): Promise<StoredMessage[]> {
  const bytes = await getBlob(CHAT_KEY);
  if (!bytes) return [];
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as StoredMessage[];
    return Array.isArray(parsed) ? parsed.filter((m) => m && typeof m.text === 'string') : [];
  } catch {
    return [];
  }
}

export async function saveChat(messages: StoredMessage[]): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(messages.slice(-HISTORY_LIMIT)));
  await putBlob(CHAT_KEY, bytes);
}

export async function clearChat(): Promise<void> {
  await deleteBlob(CHAT_KEY);
}

export const CHAT_SUGGESTIONS = [
  'Сколько начислено за этот месяц?',
  'Какой расход топлива по последним листам?',
  'Есть ли ошибки в заполнении листов?',
  'Что сейчас в открытых листах?',
  'Покажи последние перевозки',
];

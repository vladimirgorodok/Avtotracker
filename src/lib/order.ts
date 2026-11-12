/**
 * Заявка из файлов.
 *
 * Помощник читает приложенные фото и текстовые файлы (несколько сразу), собирает
 * из них перевозку: груз, вес, даты и точки маршрута. Похожие фирмы и места
 * сопоставляются со справочником: приложение предлагает либо добавить новое,
 * либо использовать существующее и дополнить его данными из заявки.
 */

import { askModel, isAiReady, readAiConfig, type AiMessage, type AiPart } from './ai';
import { autoTripAmount } from './calc';
import { insertRow, refs, uid, updateRow, waybillRepo } from '../db/repo';
import { parseCoords, todayIso } from './format';
import { bytesToDataUrl, downscaleImage } from './files';
import { decodeText } from './backup';
import type { AppSettings, Company, Id, Place, TripPointKind } from '../types';

/* ------------------------------------------------------------------ */
/* Что получилось из файлов                                            */
/* ------------------------------------------------------------------ */

export interface OrderPoint {
  kind: TripPointKind;
  /** Дата в виде ГГГГ-ММ-ДД или пустая строка */
  date: string;
  company: string;
  place: string;
  address: string;
  contact: string;
  coords: string;
  cargo: string;
  weight: number | null;
  note: string;
}

export interface ParsedOrder {
  title: string;
  cargo: string;
  weight: number | null;
  amount: number | null;
  vehicle: string;
  note: string;
  points: OrderPoint[];
  /** Чего в заявке не нашлось — это придётся заполнить руками */
  missing: string[];
  comment: string;
}

export interface AttachedFile {
  name: string;
  /** image — фото, text — прочитанный текст файла */
  kind: 'image' | 'text';
  /** Для фото — data-ссылка, для текста — сам текст */
  data: string;
  size: number;
}

const MAX_TEXT = 20000;
const MAX_FILES = 8;

/* ------------------------------------------------------------------ */
/* Чтение приложенных файлов                                           */
/* ------------------------------------------------------------------ */

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'bmp', 'gif'];
const SHEET_EXT = ['xlsx', 'xls', 'ods'];

function extension(name: string): string {
  const parts = name.split('.');
  return parts.length > 1 ? (parts.pop() ?? '').toLowerCase() : '';
}

/** Таблица Excel → текст CSV: модель читает его как обычный текст */
async function sheetToText(bytes: Uint8Array): Promise<string> {
  const XLSX = await import('xlsx');
  const book = XLSX.read(bytes, { type: 'array' });
  const sheetName = book.SheetNames[0];
  if (!sheetName) return '';
  return XLSX.utils.sheet_to_csv(book.Sheets[sheetName]).slice(0, MAX_TEXT);
}

/** Один выбранный файл → то, что уйдёт помощнику */
export async function fileToAttachment(file: File): Promise<AttachedFile> {
  const name = file.name || 'файл';
  const ext = extension(name);
  const type = (file.type || '').toLowerCase();

  if (type.startsWith('image/') || IMAGE_EXT.includes(ext)) {
    const { full } = await downscaleImage(file, 1400, 0.8);
    return { name, kind: 'image', data: bytesToDataUrl(full, 'image/jpeg'), size: full.length };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (SHEET_EXT.includes(ext)) {
    const text = await sheetToText(bytes);
    return { name, kind: 'text', data: text, size: bytes.length };
  }
  const text = decodeText(bytes).slice(0, MAX_TEXT);
  if (!text.trim()) throw new Error(`Файл «${name}» пустой или не читается как текст`);
  return { name, kind: 'text', data: text, size: bytes.length };
}

/* ------------------------------------------------------------------ */
/* Запрос к модели                                                     */
/* ------------------------------------------------------------------ */

const ORDER_SYSTEM = [
  'Ты разбираешь заявку на перевозку груза и отвечаешь строго одним JSON без пояснений и без markdown.',
  'Отвечай по-русски. Ничего не выдумывай: чего нет в файлах — пустая строка или null.',
].join('\n');

const ORDER_INSTRUCTION = [
  'Разбери заявку и верни ТОЛЬКО такой JSON:',
  '{',
  '  "title": "короткое название рейса, например «Москва → Казань»",',
  '  "cargo": "груз",',
  '  "weight": вес в килограммах числом или null,',
  '  "amount": сумма начисления числом или null,',
  '  "vehicle": "машина, прицеп или требование к транспорту",',
  '  "note": "важное из заявки: время, пропуск, особые условия",',
  '  "points": [',
  '    {',
  '      "kind": "load" или "unload",',
  '      "date": "ГГГГ-ММ-ДД или пустая строка",',
  '      "company": "фирма",',
  '      "place": "название места, склада или терминала",',
  '      "address": "адрес",',
  '      "contact": "телефон или контактное лицо",',
  '      "coords": "широта, долгота",',
  '      "cargo": "груз этой точки",',
  '      "weight": вес этой точки числом или null,',
  '      "note": "примечание к точке"',
  '    }',
  '  ],',
  '  "missing": ["чего не хватает в заявке"],',
  '  "comment": "одно короткое предложение для водителя"',
  '}',
  '',
  'Правила:',
  '- погрузка — "load", выгрузка — "unload"; если в заявке не сказано, первая точка погрузка, остальные выгрузки;',
  '- даты переводи в ГГГГ-ММ-ДД; если год не указан, бери текущий;',
  '- порядок точек — как в заявке;',
  '- в "missing" перечисли, чего в заявке нет: например «дата выгрузки», «вес», «контакт на погрузке»;',
  '- если в файлах несколько заявок — разбери первую и напиши об этом в "comment".',
].join('\n');

/** Сообщение для модели: инструкция, тексты файлов и фотографии */
export function buildOrderMessages(files: AttachedFile[]): AiMessage[] {
  const parts: AiPart[] = [{ type: 'text', text: ORDER_INSTRUCTION }];
  for (const f of files) {
    if (f.kind === 'image') {
      parts.push({ type: 'text', text: `Фото заявки «${f.name}»:` });
      parts.push({ type: 'image_url', image_url: { url: f.data } });
    } else {
      parts.push({ type: 'text', text: `Файл «${f.name}»:\n${f.data.slice(0, MAX_TEXT)}` });
    }
  }
  return [
    { role: 'system', content: ORDER_SYSTEM },
    { role: 'user', content: parts },
  ];
}

/** Разобрать заявку: ключ и модель должны быть заданы в настройках */
export async function extractOrder(files: AttachedFile[]): Promise<{ order: ParsedOrder; raw: string }> {
  const cfg = readAiConfig();
  if (!cfg || !cfg.model) {
    throw new Error('Сначала укажите адрес, ключ и модель ИИ в настройках');
  }
  if (files.length === 0) throw new Error('Прикрепите хотя бы один файл');
  const raw = await askModel(cfg, buildOrderMessages(files));
  return { order: parseOrderJson(raw), raw };
}

export function canReadFiles(): boolean {
  return isAiReady();
}

/* ------------------------------------------------------------------ */
/* Разбор ответа модели                                                */
/* ------------------------------------------------------------------ */

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = str(v).replace(/\s|\u00a0/g, '').replace(',', '.');
  if (!s) return null;
  const cleaned = s.replace(/[^\d.-]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const RU_MONTHS = [
  'янв',
  'фев',
  'мар',
  'апр',
  'мая',
  'июн',
  'июл',
  'авг',
  'сен',
  'окт',
  'ноя',
  'дек',
];

/** Дата из ответа модели: ISO, 12.11.2026, 12 ноября */
export function orderDate(v: unknown): string {
  const s = str(v);
  if (!s) return '';
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dotted = s.match(/(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})/);
  if (dotted) {
    const year = dotted[3].length === 2 ? `20${dotted[3]}` : dotted[3];
    return `${year}-${dotted[2].padStart(2, '0')}-${dotted[1].padStart(2, '0')}`;
  }
  const lower = s.toLowerCase();
  const month = RU_MONTHS.findIndex((m) => lower.includes(m));
  const day = lower.match(/\b(\d{1,2})\b/);
  const year = lower.match(/\b(20\d{2})\b/);
  if (month >= 0 && day) {
    return `${year ? year[1] : todayIso().slice(0, 4)}-${String(month + 1).padStart(2, '0')}-${day[1].padStart(2, '0')}`;
  }
  return '';
}

export function orderKind(v: unknown, index: number): TripPointKind {
  const s = str(v).toLowerCase();
  if (/unload|выгруз|разгруз|доставк/.test(s)) return 'unload';
  if (/load|погруз|загруз|затар/.test(s)) return 'load';
  if (/^1$|^true$/.test(s)) return 'unload';
  if (/^0$|^false$/.test(s)) return 'load';
  return index === 0 ? 'load' : 'unload';
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Текст ответа → объект заявки. Бросает понятную ошибку, если разобрать не вышло. */
export function parseOrderJson(raw: string): ParsedOrder {
  const text = String(raw ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Помощник не нашёл в файлах заявку');
  const slice = text.slice(start, end + 1);
  let data: Record<string, unknown> | null = null;
  try {
    data = JSON.parse(slice) as Record<string, unknown>;
  } catch {
    try {
      data = JSON.parse(slice.replace(/,\s*([}\]])/g, '$1')) as Record<string, unknown>;
    } catch {
      throw new Error('Не удалось разобрать ответ помощника — попробуйте ещё раз');
    }
  }
  if (!data || typeof data !== 'object') throw new Error('Помощник не нашёл в файлах заявку');

  const points = asArray(data.points).map((item, index) => {
    const p = (item ?? {}) as Record<string, unknown>;
    return {
      kind: orderKind(p.kind ?? p.type, index),
      date: orderDate(p.date ?? p.plan_date ?? p.planDate ?? p['дата']),
      company: str(p.company ?? p['фирма']),
      place: str(p.place ?? p.name ?? p['место']),
      address: str(p.address ?? p['адрес']),
      contact: str(p.contact ?? p.phone ?? p['контакт']),
      coords: str(p.coords ?? p['координаты']),
      cargo: str(p.cargo ?? p['груз']),
      weight: num(p.weight ?? p['вес']),
      note: str(p.note ?? p['примечание']),
    } satisfies OrderPoint;
  });

  if (points.length === 0) {
    throw new Error('В файлах не нашлось ни одной точки маршрута');
  }

  return {
    title: str(data.title ?? data.name),
    cargo: str(data.cargo),
    weight: num(data.weight),
    amount: num(data.amount),
    vehicle: str(data.vehicle),
    note: str(data.note),
    points,
    missing: asArray(data.missing).map(str).filter(Boolean),
    comment: str(data.comment),
  };
}

/* ------------------------------------------------------------------ */
/* Сопоставление со справочниками                                      */
/* ------------------------------------------------------------------ */

/** Название без регистра, кавычек, «ООО» и лишних знаков */
export function normalizeName(raw: string): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[«»"'`]/g, ' ')
    .replace(/\b(ооо|оао|зао|ип|пао|ао|гк|тд|тк|лтд|llc|ltd|inc|гмбх)\b/g, ' ')
    .replace(/[.,()\-–—/\\+№#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Похожесть названий: 1 — одинаковые, 0 — ничего общего */
export function nameScore(a: string, b: string): number {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length > 3 && y.length > 3 && (x.includes(y) || y.includes(x))) return 0.9;
  const tx = new Set(x.split(' ').filter((w) => w.length > 2));
  const ty = new Set(y.split(' ').filter((w) => w.length > 2));
  if (tx.size === 0 || ty.size === 0) return 0;
  let common = 0;
  for (const w of tx) if (ty.has(w)) common++;
  return (common / (tx.size + ty.size - common)) * 0.85;
}

/** Расстояние в метрах (приблизительно, для ближних точек) */
function metersBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * 111320;
  const dLon = (lon2 - lon1) * 111320 * Math.cos((lat1 * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

export interface PlaceMatch {
  place: Place;
  score: number;
  reasons: string[];
}

/**
 * Похоже ли место из заявки на что-то из справочника.
 * Учитываются название, адрес, координаты и привязка к той же фирме.
 */
export function matchPlace(
  draft: { name: string; address: string; coords: string },
  places: Place[],
  companyId: Id | null = null,
): PlaceMatch | null {
  const coords = parseCoords(draft.coords);
  let best: PlaceMatch | null = null;
  // При равном счёте выигрывает то место, где совпало название
  let bestName = 0;

  for (const place of places) {
    const reasons: string[] = [];
    let score = 0;

    const byName = nameScore(draft.name, place.name);
    if (byName >= 0.99) {
      score = Math.max(score, byName);
      reasons.push('совпадает название');
    } else if (byName > 0.45) {
      score = Math.max(score, byName);
      reasons.push('похоже название');
    }

    const byAddress = nameScore(draft.address, place.address);
    if (byAddress >= 0.99) {
      score = Math.max(score, byAddress);
      reasons.push('совпадает адрес');
    } else if (byAddress > 0.45) {
      score = Math.max(score, byAddress * 0.95);
      reasons.push('похож адрес');
    }

    if (coords && place.lat !== null && place.lon !== null) {
      const m = metersBetween(coords.lat, coords.lon, place.lat, place.lon);
      if (m < 300) {
        score = Math.max(score, 0.96);
        reasons.push(`координаты рядом (${Math.round(m)} м)`);
      } else if (m < 3000) {
        score = Math.max(score, 0.7);
        reasons.push(`координаты в ${(m / 1000).toFixed(1)} км`);
      }
    }

    if (companyId && place.company_id === companyId && score > 0) {
      score = Math.min(1, score + 0.08);
      reasons.push('та же фирма');
    }

    if (score > 0 && (!best || score > best.score || (score === best.score && byName > bestName))) {
      best = { place, score, reasons };
      bestName = byName;
    }
  }

  return best && best.score >= 0.3 ? best : null;
}

export interface CompanyMatch {
  company: Company;
  score: number;
  reasons: string[];
}

export function matchCompany(name: string, companies: Company[]): CompanyMatch | null {
  let best: CompanyMatch | null = null;
  for (const company of companies) {
    const score = nameScore(name, company.name);
    if (score >= 0.3 && (!best || score > best.score)) {
      best = { company, score, reasons: [score >= 0.99 ? 'такое название уже есть' : 'похожее название'] };
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Черновик: что показать пользователю                                 */
/* ------------------------------------------------------------------ */

export interface OrderPlaceDraft {
  key: string;
  name: string;
  address: string;
  contact: string;
  coords: string;
  company: string;
  note: string;
  /** add — добавить новое, link — использовать найденное, skip — не трогать */
  action: 'add' | 'link' | 'skip';
  linkId: Id | null;
  linkName: string;
  score: number;
  reasons: string[];
  /** Чего не хватает у найденного места — этим и дополним */
  fill: string[];
  fillEnabled: boolean;
  /** Индексы точек заявки, которые ссылаются на это место */
  points: number[];
}

export interface OrderCompanyDraft {
  key: string;
  name: string;
  action: 'add' | 'link' | 'skip';
  linkId: Id | null;
  linkName: string;
  score: number;
  reasons: string[];
}

export interface OrderDraftPoint {
  kind: TripPointKind;
  date: string;
  note: string;
  cargo: string;
  placeKey: string;
}

export interface OrderDraft {
  title: string;
  cargo: string;
  vehicle: string;
  note: string;
  weight: number | null;
  amount: number | null;
  comment: string;
  missing: string[];
  points: OrderDraftPoint[];
  places: OrderPlaceDraft[];
  companies: OrderCompanyDraft[];
}

/** Ключ места: одинаковые места из разных точек объединяются */
function placeKeyOf(name: string, address: string, coords: string): string {
  const n = normalizeName(name);
  const a = normalizeName(address);
  return n || a || normalizeName(coords) || 'место';
}

/** Что можно дописать в найденное место из заявки */
function missingFields(place: Place, draft: { address: string; contact: string; coords: string }): string[] {
  const out: string[] = [];
  if (draft.address && !place.address.trim()) out.push('Адрес');
  if (draft.contact && !place.contact.trim()) out.push('Контакт');
  if (draft.coords && (place.lat === null || place.lon === null)) out.push('Координаты');
  return out;
}

/** Ответ модели → черновик с предложениями по справочникам */
export function buildDraft(order: ParsedOrder): OrderDraft {
  const places = refs.places();
  const companies = refs.companies();
  const placeDrafts = new Map<string, OrderPlaceDraft>();

  order.points.forEach((point, index) => {
    const key = placeKeyOf(point.place, point.address, point.coords);
    let item = placeDrafts.get(key);
    if (!item) {
      item = {
        key,
        name: point.place,
        address: point.address,
        contact: point.contact,
        coords: point.coords,
        company: point.company,
        note: '',
        action: point.place || point.address || point.coords ? 'add' : 'skip',
        linkId: null,
        linkName: '',
        score: 0,
        reasons: [],
        fill: [],
        fillEnabled: true,
        points: [],
      };
      placeDrafts.set(key, item);
    }
    item.points.push(index);
    if (!item.address && point.address) item.address = point.address;
    if (!item.contact && point.contact) item.contact = point.contact;
    if (!item.company && point.company) item.company = point.company;
    if (!item.coords && point.coords) item.coords = point.coords;
  });

  for (const item of placeDrafts.values()) {
    if (item.action === 'skip') continue;
    const match = matchPlace(item, places);
    if (match && match.score >= 0.75) {
      item.action = 'link';
      item.linkId = match.place.id;
      item.linkName = match.place.name;
      item.score = match.score;
      item.reasons = match.reasons;
      item.fill = missingFields(match.place, item);
    }
  }

  const companyDrafts = new Map<string, OrderCompanyDraft>();
  for (const item of placeDrafts.values()) {
    const name = item.company.trim();
    if (!name) continue;
    const key = normalizeName(name);
    if (!key || companyDrafts.has(key)) continue;
    const match = matchCompany(name, companies);
    companyDrafts.set(key, {
      key,
      name,
      action: match && match.score >= 0.75 ? 'link' : 'add',
      linkId: match?.company.id ?? null,
      linkName: match?.company.name ?? '',
      score: match?.score ?? 0,
      reasons: match?.reasons ?? [],
    });
  }

  const missing = [...order.missing];
  if (order.weight === null) missing.push('вес груза');
  order.points.forEach((p, i) => {
    if (!p.date) missing.push(`дата точки ${i + 1}`);
    if (!p.place && !p.address) missing.push(`место точки ${i + 1}`);
  });

  return {
    title: order.title,
    cargo: order.cargo,
    vehicle: order.vehicle,
    note: order.note,
    weight: order.weight,
    amount: order.amount,
    comment: order.comment,
    missing: [...new Set(missing)],
    points: order.points.map((p) => ({
      kind: p.kind,
      date: p.date,
      note: p.note,
      cargo: p.cargo,
      placeKey: placeKeyOf(p.place, p.address, p.coords),
    })),
    places: [...placeDrafts.values()],
    companies: [...companyDrafts.values()],
  };
}

/** Пересчитать предложение по месту после ручной правки названия или адреса */
export function recheckPlace(item: OrderPlaceDraft): OrderPlaceDraft {
  const match = matchPlace(item, refs.places());
  if (!match || match.score < 0.75) {
    return {
      ...item,
      action: item.action === 'link' ? 'add' : item.action,
      linkId: null,
      linkName: '',
      score: match?.score ?? 0,
      reasons: match?.reasons ?? [],
      fill: [],
    };
  }
  return {
    ...item,
    action: 'link',
    linkId: match.place.id,
    linkName: match.place.name,
    score: match.score,
    reasons: match.reasons,
    fill: missingFields(match.place, item),
  };
}

/* ------------------------------------------------------------------ */
/* Применение: справочники и поездка                                   */
/* ------------------------------------------------------------------ */

export interface ApplyOrderResult {
  tripId: Id;
  companiesAdded: number;
  placesAdded: number;
  placesFilled: number;
  cargoAdded: boolean;
  pointsCount: number;
}

/** Создать поездку по черновику: сначала справочники, потом сама перевозка */
export function applyDraft(draft: OrderDraft, settings: AppSettings): ApplyOrderResult {
  const companyIds = new Map<string, Id>();
  let companiesAdded = 0;
  for (const c of draft.companies) {
    if (c.action === 'skip') continue;
    if (c.action === 'link' && c.linkId) {
      companyIds.set(c.key, c.linkId);
      continue;
    }
    const id = uid();
    insertRow('companies', { id, name: c.name, cargo_type_id: null, logo: '', note: 'Из заявки' });
    companyIds.set(c.key, id);
    companiesAdded++;
  }

  const placeIds = new Map<string, Id>();
  let placesAdded = 0;
  let placesFilled = 0;
  for (const p of draft.places) {
    if (p.action === 'skip') continue;
    if (p.action === 'link' && p.linkId) {
      placeIds.set(p.key, p.linkId);
      if (p.fillEnabled && p.fill.length > 0) {
        const coords = parseCoords(p.coords);
        const patch: Record<string, unknown> = {};
        if (p.fill.includes('Адрес') && p.address) patch.address = p.address;
        if (p.fill.includes('Контакт') && p.contact) patch.contact = p.contact;
        if (p.fill.includes('Координаты') && coords) {
          patch.lat = coords.lat;
          patch.lon = coords.lon;
        }
        if (Object.keys(patch).length > 0) {
          updateRow('places', p.linkId, patch);
          placesFilled++;
        }
      }
      continue;
    }
    const coords = parseCoords(p.coords);
    const companyKey = normalizeName(p.company);
    const id = uid();
    insertRow('places', {
      id,
      name: p.name || p.address || 'Место из заявки',
      company_id: companyKey ? companyIds.get(companyKey) ?? null : null,
      address: p.address,
      lat: coords?.lat ?? null,
      lon: coords?.lon ?? null,
      contact: p.contact,
      load_type: null,
      cargo_type_id: null,
      note: p.note,
    });
    placeIds.set(p.key, id);
    placesAdded++;
  }

  const cargoName = draft.cargo.trim();
  let cargoId: Id | null = null;
  let cargoAdded = false;
  if (cargoName) {
    const found = refs.cargoTypes().find((c) => normalizeName(c.name) === normalizeName(cargoName));
    if (found) {
      cargoId = found.id;
    } else {
      cargoId = uid();
      insertRow('cargo_types', { id: cargoId, name: cargoName, icon: '', note: 'Из заявки' });
      cargoAdded = true;
    }
  }

  const openWaybill = waybillRepo.open()[0] ?? waybillRepo.list()[0] ?? null;
  const amount = draft.amount ?? autoTripAmount(settings, draft.points.length);
  const tripId = uid();
  insertRow('trips', {
    id: tripId,
    waybill_id: openWaybill?.id ?? '',
    cargo_type_id: cargoId,
    weight: draft.weight,
    amount,
    note: [draft.title, draft.vehicle ? `Автомобиль: ${draft.vehicle}` : '', draft.note, draft.comment]
      .filter(Boolean)
      .join(' · '),
    status: 'planned',
  });

  draft.points.forEach((p, index) => {
    const placeId = p.placeKey ? placeIds.get(p.placeKey) ?? null : null;
    const place = placeId ? refs.place(placeId) : null;
    insertRow('trip_points', {
      trip_id: tripId,
      seq: index + 1,
      kind: p.kind,
      place_id: placeId,
      plan_date: p.date || null,
      fact_date: null,
      load_type: place?.load_type ?? null,
      cargo_type_id: place?.cargo_type_id ?? null,
      weight: null,
      status: 'planned',
      note: p.note,
    });
  });

  return {
    tripId,
    companiesAdded,
    placesAdded,
    placesFilled,
    cargoAdded,
    pointsCount: draft.points.length,
  };
}

/** Итог словами: что сделали со справочниками и поездкой */
export function describeOrderResult(res: ApplyOrderResult): string {
  const parts: string[] = [`точек ${res.pointsCount}`];
  if (res.placesAdded > 0) parts.push(`новых мест ${res.placesAdded}`);
  if (res.companiesAdded > 0) parts.push(`новых фирм ${res.companiesAdded}`);
  if (res.placesFilled > 0) parts.push(`дополнено мест ${res.placesFilled}`);
  if (res.cargoAdded) parts.push('груз добавлен в справочник');
  return `Поездка создана: ${parts.join(', ')}`;
}

export { MAX_FILES };

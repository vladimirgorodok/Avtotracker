/**
 * Подбор логотипов и значков по названию.
 *
 * Ключ и аккаунт не нужны — картинки берутся из открытых источников:
 *   • Iconify — значки и фирменные логотипы (наборы logos, thesvg, simple-icons, arcticons…);
 *   • Викисклад (Wikimedia Commons) — настоящие логотипы и фотографии;
 *   • Викиданные (Wikidata) — официальный сайт и логотип фирмы: так находятся
 *     российские фирмы, которых нет в зарубежных наборах значков;
 *   • значки сайтов (Яндекс, Google, DuckDuckGo, Clearbit) — когда известен адрес фирмы.
 *
 * ИИ-помощник, если он настроен, готовит варианты названия: убирает и добавляет
 * «ООО», «АО» и подобные формы, пишет название латиницей, подсказывает адрес сайта
 * и английские слова для груза. Без ключа варианты строятся на устройстве, поэтому
 * поиск работает и сам по себе.
 */

import { askModel, readAiConfig, type AiConfig } from './ai';
import { imageToDataUrl } from './files';

export type PictureKind = 'company' | 'cargo' | 'station' | 'vehicle';

export const PICTURE_KINDS: { value: PictureKind; label: string; hint: string }[] = [
  { value: 'company', label: 'Фирма', hint: 'логотип фирмы' },
  { value: 'cargo', label: 'Груз', hint: 'значок груза' },
  { value: 'station', label: 'АЗС', hint: 'значок заправки' },
  { value: 'vehicle', label: 'Автомобиль', hint: 'значок техники' },
];

export function kindLabel(kind: PictureKind): string {
  return PICTURE_KINDS.find((k) => k.value === kind)?.label ?? 'Название';
}

/** Найденная картинка */
export interface PictureHit {
  id: string;
  /** Подпись: что на картинке */
  title: string;
  /** Откуда взялась: «Значок · mdi», «Викисклад», «Значок сайта · Яндекс» */
  source: string;
  /** Ссылка на саму картинку — её и сохраняем */
  url: string;
  /** Уменьшенная копия для списка */
  thumb: string;
  kind: 'icon' | 'logo' | 'photo';
  /** Адрес сайта, если он известен */
  site?: string;
}

/** Что искать: запросы для значков и для поиска картинок в интернете */
export interface PictureQuery {
  icon: string[];
  web: string[];
  /** Адрес сайта фирмы (без http и www), иначе пустая строка */
  domain: string;
  /** Короткое пояснение, что понял помощник */
  note: string;
  /** Варианты подобрал ИИ-помощник */
  byAi: boolean;
}

export interface PictureProgress {
  stage: 'variants' | 'icons' | 'logos' | 'sites' | 'done';
  text: string;
  found?: number;
}

export interface PictureSearchResult {
  hits: PictureHit[];
  /** Что ответил каждый источник — видно, если что-то недоступно */
  notes: string[];
  query: PictureQuery;
}

/** Сколько картинок показываем за раз */
export const MAX_HITS = 30;
const TIMEOUT_MS = 9000;

/* ------------------------------------------------------------------ */
/* Название: чистка, формы, латиница                                  */
/* ------------------------------------------------------------------ */

/** Организационные формы — их убираем и добавляем при поиске */
export const LEGAL_FORMS = [
  'ООО',
  'ОАО',
  'ЗАО',
  'ПАО',
  'АО',
  'ИП',
  'ТОО',
  'ЧП',
  'ГУП',
  'МУП',
  'ФГУП',
  'КФХ',
  'НКО',
  'АНО',
  'LLC',
  'LTD',
  'LIMITED',
  'INC',
  'GMBH',
  'SA',
  'BV',
];

const TRANSLIT: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

/** Русское слово латиницей — по нему ищутся зарубежные наборы значков */
export function translit(text: string): string {
  return text
    .split('')
    .map((ch) => {
      const lower = ch.toLowerCase();
      const mapped = TRANSLIT[lower];
      if (mapped === undefined) return ch;
      return ch === lower ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1);
    })
    .join('');
}

/** Убирает кавычки, скобки и лишние знаки */
export function cleanName(raw: string): string {
  return raw
    .replace(/[«»"'“”„()[\],.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Название без организационной формы: «ООО «Ромашка»» → «Ромашка» */
export function stripLegalForm(raw: string): string {
  const clean = cleanName(raw);
  const words = clean.split(' ').filter((w) => w !== '');
  const left = words.filter((w) => !LEGAL_FORMS.includes(w.toUpperCase()));
  const out = left.join(' ').trim();
  return out === '' ? clean : out;
}

/** Слова, по которым ищутся значки грузов (английский понятен всем наборам) */
const WORD_HINTS: Record<string, string> = {
  кирпич: 'brick',
  цемент: 'cement',
  песок: 'sand',
  щебень: 'crushed stone',
  гравий: 'gravel',
  зерно: 'grain',
  пшеница: 'wheat',
  ячмень: 'barley',
  кукуруза: 'corn',
  мука: 'flour',
  сахар: 'sugar',
  лес: 'timber',
  пиломатериал: 'lumber',
  доска: 'wood plank',
  брус: 'timber beam',
  металл: 'steel',
  арматура: 'rebar',
  труба: 'pipe',
  уголь: 'coal',
  руда: 'ore',
  бетон: 'concrete',
  плита: 'concrete slab',
  стекло: 'glass',
  бумага: 'paper roll',
  картон: 'cardboard',
  удобрение: 'fertilizer',
  молоко: 'milk',
  мясо: 'meat',
  рыба: 'fish',
  овощ: 'vegetables',
  картофель: 'potato',
  яблоко: 'apple',
  вода: 'water',
  напиток: 'drink',
  мебель: 'furniture',
  обувь: 'shoes',
  одежда: 'clothes',
  игрушка: 'toys',
  запчасть: 'spare parts',
  шина: 'tire',
  склад: 'warehouse',
  база: 'warehouse',
  терминал: 'terminal',
  порт: 'port',
  элеватор: 'grain elevator',
  завод: 'factory',
  комбинат: 'plant',
  ферма: 'farm',
  рынок: 'market',
  магазин: 'shop',
  тягач: 'truck tractor',
  прицеп: 'trailer',
  фура: 'truck',
  самосвал: 'dump truck',
  рефрижератор: 'refrigerated truck',
  цистерна: 'tanker truck',
  азс: 'gas station',
  заправка: 'gas station',
  топливо: 'fuel',
};

/** Что подставляем, когда по названию ничего не понятно */
const KIND_WORD: Record<PictureKind, string> = {
  company: 'factory building',
  cargo: 'cargo box',
  station: 'gas station',
  vehicle: 'truck',
};

/** Английские (или понятные всем наборам) слова для поиска */
export function englishWords(raw: string, kind: PictureKind): string[] {
  const words = cleanName(raw).toLowerCase().split(' ');
  const out: string[] = [];
  for (const w of words) {
    const hint = WORD_HINTS[w];
    if (hint && !out.includes(hint)) out.push(hint);
  }
  if (out.length === 0 && kind === 'cargo') out.push('cargo');
  return out.slice(0, 3);
}

/**
 * Варианты названия для поиска: как есть, без организационной формы, с формой,
 * латиницей и по первому слову. Для фирм — то, о чём просил пользователь:
 * если по одному написанию не нашлось, пробуем «ООО Название» и «Название ООО».
 */
export function nameVariants(raw: string, kind: PictureKind): string[] {
  const clean = cleanName(raw);
  if (clean === '') return [];
  const base = stripLegalForm(clean);
  const out: string[] = [clean];
  const add = (v: string) => {
    const t = v.trim();
    if (t.length >= 2 && !out.includes(t)) out.push(t);
  };
  if (base !== clean) add(base);
  if (kind === 'company' && /[а-яё]/i.test(base)) {
    // «ООО Название» и «Название ООО» — так ищутся логотипы российских фирм
    for (const form of ['ООО', 'АО', 'ПАО']) {
      add(`${form} ${base}`);
      add(`${base} ${form}`);
    }
  }
  const latin = translit(base).trim();
  if (latin !== base) add(latin);
  const first = base.split(' ')[0] ?? '';
  if (first.length >= 4 && first !== base) add(first);
  return out.slice(0, 8);
}

/** Догадка об адресе сайта по названию (показывается как предположение) */
export function guessDomain(name: string): string {
  const slug = translit(stripLegalForm(name))
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return slug.length >= 4 ? `${slug}.ru` : '';
}

/** Варианты без ИИ: работают всегда, даже без ключа */
export function localQuery(raw: string, kind: PictureKind): PictureQuery {
  const clean = cleanName(raw);
  const base = stripLegalForm(clean);
  const variants = nameVariants(raw, kind);
  const words = englishWords(raw, kind);
  const latin = translit(base).trim();
  const uniq = (list: string[], cap: number) =>
    [...new Set(list.map((v) => v.trim()).filter((v) => v !== ''))].slice(0, cap);
  // Значки: сначала латиница и английские слова — только их понимают наборы значков
  const icon = uniq([latin, ...words, ...variants, KIND_WORD[kind]], 5);
  // Картинки в интернете: сначала «название + logo», потом название как есть
  const web =
    kind === 'company'
      ? uniq([`${base} logo`, `${base} логотип`, ...variants.map((v) => `${v} logo`), ...variants], 4)
      : uniq([...variants, ...words, KIND_WORD[kind]], 4);
  return {
    icon,
    web,
    domain: kind === 'company' ? guessDomain(base) : '',
    note: '',
    byAi: false,
  };
}

/* ------------------------------------------------------------------ */
/* Разбор ответа помощника                                            */
/* ------------------------------------------------------------------ */

/** Приводит адрес сайта к виду example.ru */
export function cleanDomain(raw: string): string {
  const d = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '');
  const host = d.split('/')[0]?.split('?')[0]?.split('#')[0] ?? '';
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(host) ? host : '';
}

/** Разбирает ответ помощника: только JSON, без пояснений */
export function parsePictureQuery(text: string): PictureQuery | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const obj = data as { icon?: unknown; web?: unknown; domain?: unknown; note?: unknown };
  const list = (v: unknown): string[] =>
    Array.isArray(v)
      ? v
          .map((x) => String(x).trim())
          .filter((x) => x !== '' && x.length <= 80)
          .slice(0, 4)
      : [];
  const icon = list(obj.icon);
  const web = list(obj.web);
  const domain = cleanDomain(String(obj.domain ?? ''));
  if (icon.length === 0 && web.length === 0 && domain === '') return null;
  return {
    icon,
    web,
    domain,
    note: String(obj.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
    byAi: true,
  };
}

const PICTURE_SYSTEM = [
  'Ты подбираешь картинки для приложения «АвтоБаза»: логотипы фирм и значки для справочника.',
  'Ответь ТОЛЬКО JSON без пояснений:',
  '{"icon":["до 4 коротких запросов для поиска значков"],"web":["до 3 запросов для поиска логотипа или картинки"],"domain":"адрес сайта фирмы без http и www, иначе пустая строка","note":"одна короткая фраза, что ты понял"}',
  'Правила: у фирмы убери организационную форму и добавь её обратно в другом порядке (ООО, АО, ОАО, ЗАО, ПАО, ИП),',
  'а также напиши название латиницей; для груза дай короткие английские слова (brick, cement, grain…);',
  'для места, АЗС и техники — короткие русские и английские слова.',
  'Адрес сайта указывай, только если уверен; при сомнении — пустая строка.',
].join('\n');

/** Варианты от помощника: организационные формы, латиница и адрес сайта */
export async function aiQuery(cfg: AiConfig, raw: string, kind: PictureKind): Promise<PictureQuery | null> {
  const text = await askModel(cfg, [
    { role: 'system', content: PICTURE_SYSTEM },
    { role: 'user', content: `Что ищем: ${kindLabel(kind)}\nНазвание: ${raw}` },
  ]);
  return parsePictureQuery(text);
}

function mergeQueries(local: PictureQuery, ai: PictureQuery): PictureQuery {
  const uniq = (first: string[], second: string[], cap: number) =>
    [...new Set([...first, ...second])].slice(0, cap);
  return {
    icon: uniq(ai.icon, local.icon, 5),
    web: uniq(ai.web, local.web, 4),
    domain: ai.domain !== '' ? ai.domain : local.domain,
    note: ai.note !== '' ? ai.note : local.note,
    byAi: true,
  };
}

/** Варианты поиска: на устройстве, плюс помощник, если он настроен */
export async function resolveQuery(
  raw: string,
  kind: PictureKind,
  cfg: AiConfig | null,
): Promise<PictureQuery> {
  const local = localQuery(raw, kind);
  if (!cfg || cfg.model === '') return local;
  try {
    const ai = await aiQuery(cfg, raw, kind);
    return ai ? mergeQueries(local, ai) : local;
  } catch {
    // помощник недоступен — ищем по вариантам, собранным на устройстве
    return local;
  }
}

/* ------------------------------------------------------------------ */
/* Источники картинок                                                 */
/* ------------------------------------------------------------------ */

const ICONIFY = 'https://api.iconify.design';
/** Наборы, где лежат фирменные логотипы */
export const BRAND_SETS = 'logos,simple-icons,thesvg,thesvg-color,arcticons,skill-icons';
const BRAND_PREFIXES = new Set([
  'logos',
  'simple-icons',
  'thesvg',
  'thesvg-color',
  'arcticons',
  'skill-icons',
  'cib',
  'fa6-brands',
  'devicon',
]);

async function fetchWithTimeout(url: string, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function iconUrl(name: string, height: number): string {
  const cut = name.indexOf(':');
  const prefix = name.slice(0, cut);
  const icon = name.slice(cut + 1);
  return `${ICONIFY}/${prefix}/${icon}.svg?height=${height}&color=%23334155`;
}

/** Разбор ответа Iconify: список имён значков */
export function parseIconify(payload: unknown): PictureHit[] {
  const icons = (payload as { icons?: unknown } | null)?.icons;
  if (!Array.isArray(icons)) return [];
  const out: PictureHit[] = [];
  for (const raw of icons) {
    const name = String(raw);
    const cut = name.indexOf(':');
    if (cut <= 0) continue;
    const prefix = name.slice(0, cut);
    const icon = name.slice(cut + 1);
    const brand = BRAND_PREFIXES.has(prefix);
    out.push({
      id: `iconify:${name}`,
      title: icon.replace(/-/g, ' '),
      source: brand ? `Логотип · ${prefix}` : `Значок · ${prefix}`,
      url: iconUrl(name, 256),
      thumb: iconUrl(name, 96),
      kind: brand ? 'logo' : 'icon',
    });
  }
  return out;
}

/** Значки и фирменные логотипы: сначала фирменные наборы, потом все остальные */
export async function searchIconify(query: string, limit = 24): Promise<PictureHit[]> {
  const common = `query=${encodeURIComponent(query)}&limit=${limit}`;
  const urls = [
    `${ICONIFY}/search?${common}&prefixes=${BRAND_SETS}`,
    `${ICONIFY}/search?${common}`,
  ];
  const found: PictureHit[] = [];
  for (const url of urls) {
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`Значки недоступны (${res.status})`);
    found.push(...parseIconify(await res.json()));
    if (found.length >= limit) break;
  }
  return found;
}

/** Разбор ответа Викисклада */
export function parseCommons(payload: unknown): PictureHit[] {
  const pages = (payload as { query?: { pages?: Record<string, unknown> } } | null)?.query?.pages;
  if (!pages || typeof pages !== 'object') return [];
  const out: PictureHit[] = [];
  for (const page of Object.values(pages)) {
    const p = page as { title?: unknown; imageinfo?: unknown };
    const first = Array.isArray(p.imageinfo) ? (p.imageinfo[0] as Record<string, unknown> | undefined) : undefined;
    if (!first) continue;
    const mime = String(first.mime ?? '');
    if (mime !== '' && !mime.startsWith('image/')) continue;
    const url = String(first.thumburl ?? first.url ?? '');
    if (!/^https?:/.test(url)) continue;
    const width = Number(first.width ?? 0);
    if (width > 0 && width < 60) continue;
    const title = String(p.title ?? '')
      .replace(/^File:/, '')
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/_/g, ' ');
    out.push({
      id: `commons:${title}`,
      title,
      source: 'Викисклад',
      url,
      thumb: String(first.thumburl ?? url),
      kind: /logo|логотип|emblem|brand|знак/i.test(title) ? 'logo' : 'photo',
    });
  }
  return out;
}

/** Логотипы и картинки из Викисклада */
export async function searchCommons(query: string, limit = 10): Promise<PictureHit[]> {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    origin: '*',
    generator: 'search',
    gsrsearch: `filetype:bitmap|drawing ${query}`,
    gsrnamespace: '6',
    gsrlimit: String(limit),
    prop: 'imageinfo',
    iiprop: 'url|size|mime',
    iiurlwidth: '256',
  });
  const res = await fetchWithTimeout(`https://commons.wikimedia.org/w/api.php?${params.toString()}`);
  if (!res.ok) throw new Error(`Викисклад недоступен (${res.status})`);
  return parseCommons(await res.json());
}

/** Значки сайта: по адресу фирмы видно её логотип */
export function faviconHits(domain: string): PictureHit[] {
  if (domain === '') return [];
  return [
    {
      id: `clearbit:${domain}`,
      title: `Логотип ${domain}`,
      source: 'Логотип сайта · Clearbit',
      url: `https://logo.clearbit.com/${domain}`,
      thumb: `https://logo.clearbit.com/${domain}`,
      kind: 'logo',
      site: domain,
    },
    {
      id: `yandex:${domain}`,
      title: `Значок ${domain}`,
      source: 'Значок сайта · Яндекс',
      url: `https://favicon.yandex.net/favicon/${domain}?size=128`,
      thumb: `https://favicon.yandex.net/favicon/${domain}?size=128`,
      kind: 'logo',
      site: domain,
    },
    {
      id: `google:${domain}`,
      title: `Значок ${domain}`,
      source: 'Значок сайта · Google',
      url: `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
      thumb: `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
      kind: 'logo',
      site: domain,
    },
    {
      id: `duckduckgo:${domain}`,
      title: `Значок ${domain}`,
      source: 'Значок сайта · DuckDuckGo',
      url: `https://icons.duckduckgo.com/ip3/${domain}.ico`,
      thumb: `https://icons.duckduckgo.com/ip3/${domain}.ico`,
      kind: 'logo',
      site: domain,
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Викиданные: официальный сайт и логотип фирмы                       */
/* ------------------------------------------------------------------ */

const WIKIDATA = 'https://www.wikidata.org/w/api.php';

/** Разбор поиска Викиданных: подходящие записи (Q-номера) */
export function parseWikidataSearch(payload: unknown): { id: string; title: string }[] {
  const list = (payload as { search?: unknown } | null)?.search;
  if (!Array.isArray(list)) return [];
  const out: { id: string; title: string }[] = [];
  for (const raw of list) {
    const item = raw as { id?: unknown; label?: unknown };
    const id = String(item.id ?? '');
    if (!/^Q\d+$/.test(id)) continue;
    out.push({ id, title: String(item.label ?? id).trim() || id });
  }
  return out;
}

/** Ссылка на файл логотипа из Викисклада по имени файла («File:Logo.svg») */
export function commonsFileUrl(file: string, width = 256): string {
  const name = file
    .replace(/^File:/i, '')
    .replace(/_/g, ' ')
    .trim();
  if (name === '') return '';
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=${width}`;
}

/** Разбор записи Викиданных: адрес сайта (P856) и файл логотипа (P154) */
export function parseWikidataEntity(payload: unknown, id: string): { domain: string; logo: string } {
  const entities = (payload as { entities?: Record<string, unknown> } | null)?.entities;
  const entity = entities?.[id] as { claims?: Record<string, unknown> } | undefined;
  const claims = entity?.claims;
  if (!claims) return { domain: '', logo: '' };
  const first = (prop: string): string => {
    const list = claims[prop];
    if (!Array.isArray(list)) return '';
    for (const raw of list) {
      const snak = (raw as { mainsnak?: { datavalue?: { value?: unknown } } }).mainsnak;
      const value = snak?.datavalue?.value;
      if (typeof value === 'string' && value !== '') return value;
    }
    return '';
  };
  return { domain: cleanDomain(first('P856')), logo: first('P154') };
}

/**
 * Ищет фирму в Викиданных и возвращает её официальный сайт и логотип.
 * Открытый API, без ключа: `origin=*` разрешает запрос из приложения.
 */
export async function searchWikidata(name: string): Promise<{ domain: string; hits: PictureHit[] }> {
  const clean = stripLegalForm(name);
  if (clean.length < 2) return { domain: '', hits: [] };

  const search = new URLSearchParams({
    action: 'wbsearchentities',
    search: clean,
    language: 'ru',
    uselang: 'ru',
    limit: '3',
    format: 'json',
    origin: '*',
  });
  const found = await fetchWithTimeout(`${WIKIDATA}?${search.toString()}`);
  if (!found.ok) throw new Error(`Викиданные недоступны (${found.status})`);
  const items = parseWikidataSearch(await found.json());
  if (items.length === 0) return { domain: '', hits: [] };

  const entities = new URLSearchParams({
    action: 'wbgetentities',
    ids: items.map((i) => i.id).join('|'),
    props: 'claims',
    format: 'json',
    origin: '*',
  });
  const res = await fetchWithTimeout(`${WIKIDATA}?${entities.toString()}`);
  if (!res.ok) throw new Error(`Викиданные недоступны (${res.status})`);
  const payload = await res.json();

  const hits: PictureHit[] = [];
  let domain = '';
  for (const item of items) {
    const info = parseWikidataEntity(payload, item.id);
    if (domain === '' && info.domain !== '') domain = info.domain;
    const logo = commonsFileUrl(info.logo);
    if (logo !== '') {
      hits.push({
        id: `wikidata:${item.id}`,
        title: item.title,
        source: 'Логотип · Викиданные',
        url: logo,
        thumb: commonsFileUrl(info.logo, 96),
        kind: 'logo',
      });
    }
  }
  return { domain, hits: hits.slice(0, 6) };
}

/** Одинаковые картинки из разных источников показываем один раз */
export function dedupeHits(hits: PictureHit[]): PictureHit[] {
  const seen = new Set<string>();
  const out: PictureHit[] = [];
  for (const h of hits) {
    const key = h.url.replace(/^https?:\/\//, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

/** Сначала логотипы, потом значки, потом фотографии; значки сайтов — в конце своей группы */
export function sortHits(hits: PictureHit[]): PictureHit[] {
  const weight = (h: PictureHit) => {
    const base = h.kind === 'logo' ? 0 : h.kind === 'icon' ? 1 : 2;
    return base + (h.site ? 0.5 : 0);
  };
  return [...hits].sort((a, b) => weight(a) - weight(b));
}

async function collect(jobs: (() => Promise<PictureHit[]>)[]): Promise<{ items: PictureHit[]; failed: number }> {
  const results = await Promise.allSettled(jobs.map((run) => run()));
  const items: PictureHit[] = [];
  let failed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') items.push(...r.value);
    else failed++;
  }
  return { items, failed };
}

/* ------------------------------------------------------------------ */
/* Общий поиск                                                        */
/* ------------------------------------------------------------------ */

/**
 * Ищет логотипы и значки по названию: варианты названия → значки → логотипы
 * в интернете → значки сайта. Что не ответило — видно в notes, поиск не падает.
 */
export async function searchPictures(opts: {
  name: string;
  kind: PictureKind;
  cfg?: AiConfig | null;
  onProgress?: (p: PictureProgress) => void;
}): Promise<PictureSearchResult> {
  const { name, kind, onProgress } = opts;
  const cfg = opts.cfg === undefined ? readAiConfig() : opts.cfg;

  onProgress?.({ stage: 'variants', text: 'Собираю варианты названия' });
  const query = await resolveQuery(name, kind, cfg);

  const hits: PictureHit[] = [];
  const notes: string[] = [];

  onProgress?.({ stage: 'icons', text: 'Ищу значки и фирменные логотипы', found: 0 });
  // Наборы значков понимают только латиницу — запросы кириллицей не тратим
  const latinQueries = query.icon.filter((q) => /[a-z]/i.test(q));
  const iconQueries = (latinQueries.length > 0 ? latinQueries : query.icon).slice(0, 4);
  const icons = await collect(iconQueries.map((q) => () => searchIconify(q, 24)));
  hits.push(...icons.items);
  if (icons.failed > 0) notes.push('Наборы значков не ответили — проверьте интернет');
  onProgress?.({ stage: 'icons', text: 'Значки найдены', found: dedupeHits(hits).length });

  onProgress?.({ stage: 'logos', text: 'Ищу логотипы и картинки в интернете' });
  const web = await collect(query.web.slice(0, 3).map((q) => () => searchCommons(q, 10)));
  hits.push(...web.items);
  if (web.failed > 0) notes.push('Викисклад не ответил — проверьте интернет');
  onProgress?.({ stage: 'logos', text: 'Логотипы и картинки найдены', found: dedupeHits(hits).length });

  /*
    Викиданные знают официальный сайт и логотип фирмы — по ним находятся
    российские фирмы, которых нет в зарубежных наборах значков. Для груза
    эта проверка бессмысленна, поэтому её пропускаем.
  */
  let siteDomain = query.domain;
  if (kind !== 'cargo') {
    onProgress?.({ stage: 'sites', text: 'Ищу фирму в Викиданных' });
    try {
      const wiki = await searchWikidata(name);
      hits.push(...wiki.hits);
      if (wiki.domain !== '' && wiki.domain !== query.domain) {
        siteDomain = wiki.domain;
        notes.push(`Официальный сайт: ${wiki.domain}`);
      }
    } catch {
      // Викиданные не ответили — ищем по догадке об адресе
    }
  }

  if (siteDomain !== '') {
    onProgress?.({ stage: 'sites', text: `Смотрю значки сайта ${siteDomain}` });
    hits.push(...faviconHits(siteDomain));
  }

  const result = sortHits(dedupeHits(hits)).slice(0, MAX_HITS);
  notes.push(
    result.length === 0
      ? 'Ничего не нашлось — попробуйте другое название'
      : `Найдено картинок: ${result.length}`,
  );
  onProgress?.({ stage: 'done', text: 'Готово', found: result.length });
  return { hits: result, notes, query };
}

/** Скачивает картинку и готовит её для хранения в справочнике */
export async function pictureToDataUrl(hit: PictureHit, maxSize = 256): Promise<string> {
  const res = await fetchWithTimeout(hit.url, 15000);
  if (!res.ok) throw new Error(`Картинка недоступна (${res.status})`);
  const blob = await res.blob();
  if (blob.size === 0) throw new Error('Пустой файл картинки');
  if (blob.size > 8 * 1024 * 1024) throw new Error('Картинка слишком большая');
  return await imageToDataUrl(blob, maxSize);
}

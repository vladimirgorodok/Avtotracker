/**
 * Логотипы из открытого каталога Trace Logos (github.com/rafael-mansurov/trace-logos).
 *
 * Зачем: у набора значков Iconify нет российских фирм, а тут лежит большой каталог
 * (шесть с лишним сотен марок) с настоящими логотипами в SVG и PNG. Каталог — один
 * файл `logos.json`: его скачиваем один раз за запуск, держим в памяти и ищем уже
 * на устройстве, без лишних обращений в сеть.
 *
 * Картинки берём прямо с сайта каталога: у него открыт CORS, а значки скачиваются
 * к нам в базу (как и остальные логотипы), поэтому в списках они не зависят от сети.
 *
 * Источник берём по порядку: сначала сайт каталога, потом GitHub. Один из них
 * обычно доступен, и поиск работает.
 */

import { cleanName, LEGAL_FORMS, nameVariants, translit, type PictureHit } from './pictures';

/** Где лежит каталог и картинки */
const SITE = 'https://trace-logos.ru';
const RAW = 'https://raw.githubusercontent.com/rafael-mansurov/trace-logos/main';

/** Ссылка на репозиторий — показываем её в подсказке */
export const TRACE_REPO = 'https://github.com/rafael-mansurov/trace-logos';

const TIMEOUT_MS = 12000;

/** Одна марка из каталога */
export interface TraceLogo {
  name: string;
  nameEn: string;
  /** Слова, по которым марку ищут (в том числе адрес сайта) */
  tags: string;
  /** Категория: «Банки», «Автомобили», «Маркетплейсы и ритейл» и т.д. */
  category: string;
  categorySlug: string;
  /** Картинка в SVG, если есть */
  svg: string;
  /** Картинка в PNG, если есть */
  png: string;
  /** Ещё не готова: в каталоге только заглушка */
  soon: boolean;
}

/** Кэш каталога на время работы приложения */
let cache: TraceLogo[] | null = null;
let loading: Promise<TraceLogo[]> | null = null;

function fetchWithTimeout(url: string, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

/** Достаёт имя файла без папок и расширения: `.../svgs/sber.svg` → `sber` */
function stem(url: string, folder: string): string {
  const m = url.match(new RegExp(`assets/logos/${folder}/(.+)\\.(?:svg|png)$`, 'i'));
  return m ? m[1]! : '';
}

/** Разбор каталога: чужие поля не ломают показ */
export function parseCatalog(payload: unknown): TraceLogo[] {
  const list = (payload as { logos?: unknown } | null)?.logos;
  if (!Array.isArray(list)) return [];
  const out: TraceLogo[] = [];
  for (const raw of list) {
    const o = raw as Record<string, unknown>;
    const svg = String(o.svgUrl ?? '');
    const png = String(o.pngUrl ?? '');
    // Заглушка каталога — не картинка, её показывать нельзя
    const soon = o.comingSoon === true || /placeholder\.svg$/i.test(svg);
    out.push({
      name: String(o.name ?? '').trim(),
      nameEn: String(o.name_en ?? '').trim(),
      tags: String(o.tags ?? '').trim(),
      category: String(o.categoryName ?? '').trim(),
      categorySlug: String(o.categorySlug ?? '').trim(),
      svg: soon ? '' : svg,
      png: soon ? '' : png,
      soon,
    });
  }
  return out;
}

/** Основная картинка марки: предпочитаем SVG — он тянется без потерь */
export function logoImage(logo: TraceLogo): string {
  return logo.svg || logo.png;
}

/** Лёгкая копия для сетки: уменьшенный PNG каталога, иначе сама картинка */
export function logoThumb(logo: TraceLogo): string {
  if (logo.svg !== '') {
    const s = stem(logo.svg, 'svgs');
    if (s !== '') return `${SITE}/assets/logos/search/${s}.png`;
  }
  return logoImage(logo);
}

/** Ищет каталог: сначала сайт, потом GitHub. Пусто — значит не вышло */
async function loadFromNetwork(): Promise<TraceLogo[]> {
  const urls = [`${SITE}/logos.json`, `${RAW}/logos.json`];
  let lastError: unknown = null;
  for (const url of urls) {
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error(`каталог недоступен (${res.status})`);
      const logos = parseCatalog(await res.json());
      if (logos.length > 0) return logos;
      lastError = new Error('каталог пуст');
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Не удалось загрузить каталог');
}

/**
 * Каталог целиком: скачиваем один раз и держим в памяти.
 * Повторные вызовы, в том числе одновременно, используют одну загрузку.
 */
export async function loadCatalog(): Promise<TraceLogo[]> {
  if (cache) return cache;
  if (!loading) {
    loading = loadFromNetwork()
      .then((logos) => {
        cache = logos;
        return logos;
      })
      .finally(() => {
        loading = null;
      });
  }
  return await loading;
}

/** Каталог уже загружен — можно показать список без ожидания сети */
export function catalogReady(): boolean {
  return cache !== null;
}

/**
 * Подборка каталога — готовый набор марок: «Логотипы российских банков»,
 * «Маркетплейсы», «Нейросети» и т.п. Это те самые «папки», по которым удобно
 * смотреть каталог, когда не знаешь точного названия.
 */
export interface TraceCollection {
  slug: string;
  title: string;
  /** Значок подборки: эмодзи из каталога */
  icon: string;
  /** Слова, по которым подборка набирает марки */
  match: string[];
}

let collectionsCache: TraceCollection[] | null = null;
let collectionsLoading: Promise<TraceCollection[]> | null = null;

/** Разбор подборок: чужие поля не ломают показ */
export function parseCollections(payload: unknown): TraceCollection[] {
  const list = (payload as { collections?: unknown } | null)?.collections;
  if (!Array.isArray(list)) return [];
  const out: TraceCollection[] = [];
  for (const raw of list) {
    const o = raw as Record<string, unknown>;
    const title = String(o.title ?? o.h1 ?? '').trim();
    const slug = String(o.slug ?? '').trim();
    const match = Array.isArray(o.match) ? o.match.map((m) => String(m).trim()).filter((m) => m !== '') : [];
    if (slug === '' || title === '' || match.length === 0) continue;
    out.push({ slug, title, icon: String(o.icon ?? '📁').trim() || '📁', match });
  }
  return out;
}

/** Подборки каталога: качаем один раз и держим в памяти, как и сам каталог */
export async function loadCollections(): Promise<TraceCollection[]> {
  if (collectionsCache) return collectionsCache;
  if (!collectionsLoading) {
    collectionsLoading = (async () => {
      const urls = [`${SITE}/collections.json`, `${RAW}/collections.json`];
      let lastError: unknown = null;
      for (const url of urls) {
        try {
          const res = await fetchWithTimeout(url);
          if (!res.ok) throw new Error(`подборки недоступны (${res.status})`);
          const list = parseCollections(await res.json());
          if (list.length > 0) return list;
          lastError = new Error('подборки пусты');
        } catch (e) {
          lastError = e;
        }
      }
      throw lastError instanceof Error ? lastError : new Error('Не удалось загрузить подборки');
    })()
      .then((list) => {
        collectionsCache = list;
        return list;
      })
      .finally(() => {
        collectionsLoading = null;
      });
  }
  return await collectionsLoading;
}

/**
 * Марки подборки, по алфавиту. Сверяем слова подборки с названием и словами
 * марки — так «СберСпасибо» и «СберТех» попадают в подборку банков.
 */
export function collectionLogos(catalog: TraceLogo[], collection: TraceCollection): TraceLogo[] {
  const words = collection.match.map((m) => norm(m)).filter((w) => w !== '');
  return catalog
    .filter((l) => {
      if (l.soon || logoImage(l) === '') return false;
      const hay = norm(`${l.name} ${l.nameEn} ${l.tags}`);
      return words.some((w) => hay.includes(w));
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

/* ------------------------------------------------------------------ */
/* Поиск по контексту                                                 */
/* ------------------------------------------------------------------ */

/** Приводит текст к сравнимому виду: нижний регистр, ё→е, без знаков */
function norm(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .trim();
}

/** Слова в придачу к норме, но без организационных форм: «АО» ничего не решает */
function tokens(text: string): string[] {
  return norm(text)
    .split(' ')
    .filter((t) => t.length >= 3 && !LEGAL_FORMS.includes(t.toUpperCase()));
}

/**
 * Насколько марка подходит названию. Считаем по имени, английскому имени и
 * словам-подсказкам: точное совпадение выше частичного, слово в словах-подсказках
 * тоже идёт в зачёт. Организационные формы («ООО», «АО») не считаем: иначе
 * «АО Газпром» цеплялось бы за «ксиАОми». Короткие слова в подсказках сверяем
 * словом целиком, а не подстрокой, — так в выдачу не лезет случайное.
 */
export function scoreLogo(logo: TraceLogo, query: string): number {
  const q = norm(query);
  if (q === '') return 0;
  const qt = tokens(query);
  const name = norm(logo.name);
  const en = norm(logo.nameEn);
  const tags = norm(logo.tags);
  const tagWords = tags.split(' ');
  let s = 0;

  if (name === q) s += 120;
  if (name.startsWith(q)) s += 60;
  else if (name.includes(q)) s += 40;
  if (en && (en === q || en.includes(q))) s += 35;
  if (tagWords.includes(q)) s += 25;

  for (const t of qt) {
    if (name === t) s += 30;
    else if (name.includes(t)) s += 14;
    else if (en.includes(t)) s += 9;
    if (tagWords.includes(t)) s += 10;
    else if (t.length >= 5 && tags.includes(t)) s += 3;
  }
  return s;
}

/** Ниже этого порога совпадение случайное — в выдачу не берём */
const MIN_SCORE = 8;

/**
 * Поиск по контексту: по названию записи с учётом организационных форм и латиницы.
 * Слабые случайные совпадения отсекаем, а когда есть явный лидер — показываем
 * только близкие к нему, чтобы рядом с «Газпромом» не мелькали чужие марки.
 */
export function searchCatalog(catalog: TraceLogo[], query: string, limit = 30): TraceLogo[] {
  const variants = [cleanName(query), ...nameVariants(query, 'company')];
  const scored = new Map<TraceLogo, number>();
  for (const v of variants) {
    for (const logo of catalog) {
      if (logo.soon) continue;
      const s = scoreLogo(logo, v);
      if (s <= 0) continue;
      const prev = scored.get(logo) ?? 0;
      if (s > prev) scored.set(logo, s);
    }
  }
  // Латинское написание — запасной ход для фирм, записанных по-русски
  if (scored.size === 0) {
    const latin = translit(cleanName(query));
    for (const logo of catalog) {
      if (logo.soon) continue;
      const s = scoreLogo(logo, latin);
      if (s > 0) scored.set(logo, s);
    }
  }
  const ranked = [...scored.entries()]
    .filter(([, s]) => s >= MIN_SCORE)
    .sort((a, b) => b[1] - a[1]);
  const best = ranked[0]?.[1] ?? 0;
  // Явный лидер: держим только то, что рядом с ним по весу
  const cutoff = best >= 40 ? Math.max(MIN_SCORE, best * 0.25) : MIN_SCORE;
  return ranked
    .filter(([, s]) => s >= cutoff)
    .slice(0, limit)
    .map(([logo]) => logo);
}

/* ------------------------------------------------------------------ */
/* Каталог целиком — для экрана «Значки и логотипы»                    */
/* ------------------------------------------------------------------ */

/** Категории, что есть в каталоге: для выбора «показать всё такое-то» */
export function catalogCategories(catalog: TraceLogo[]): { slug: string; name: string; count: number }[] {
  const map = new Map<string, { slug: string; name: string; count: number }>();
  for (const logo of catalog) {
    if (logo.soon || logo.categorySlug === '') continue;
    const cur = map.get(logo.categorySlug);
    if (cur) cur.count++;
    else map.set(logo.categorySlug, { slug: logo.categorySlug, name: logo.category, count: 1 });
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/** Все марки раздела, по алфавиту */
export function catalogByCategory(catalog: TraceLogo[], slug: string): TraceLogo[] {
  return catalog
    .filter((l) => !l.soon && l.categorySlug === slug)
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

/** Все марки каталога, по алфавиту — для окна «все картинки» */
export function catalogAll(catalog: TraceLogo[]): TraceLogo[] {
  return catalog
    .filter((l) => !l.soon && logoImage(l) !== '')
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

/**
 * Марка каталога → плитка выбора. Отдаём в том же виде, что и остальные
 * источники: сетка выбора и сохранение картинки работают с ней одинаково.
 */
export function toHit(logo: TraceLogo): PictureHit {
  return {
    id: `trace:${logo.categorySlug}:${logo.name}`,
    title: logo.name,
    // Показываем марку и русский раздел каталога — по нему понятнее, что это
    source: `Trace Logos${logo.category ? ` · ${logo.category}` : ''}`,
    url: logoImage(logo),
    thumb: logoThumb(logo),
    kind: 'logo',
    site: SITE,
  };
}

/** Часть каталога → плитки выбора */
export function toHits(logos: TraceLogo[]): PictureHit[] {
  return logos.map(toHit);
}

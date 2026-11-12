/** Форматирование и разбор значений: даты, числа, расстояния. */

export function todayIso(): string {
  return toIsoDate(new Date());
}

export function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 'ГГГГ-ММ-ДД' → 'ДД.ММ.ГГГГ' */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = String(iso).slice(0, 10);
  const [y, m, d] = s.split('-');
  if (!y || !m || !d) return String(iso);
  return `${d}.${m}.${y}`;
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${fmtDate(toIsoDate(d))}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Значение для input type="datetime-local" */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function monthKey(iso: string | null | undefined): string {
  return (iso ?? '').slice(0, 7);
}

const MONTHS = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
];

export function monthLabel(key: string): string {
  if (!key || key.length < 7) return 'Все месяцы';
  const y = key.slice(0, 4);
  const m = Number(key.slice(5, 7));
  const name = MONTHS[m - 1] ?? '';
  return `${name} ${y} г.`;
}

export function monthOptions(fromYear = 2020, toYear?: number): string[] {
  const end = toYear ?? new Date().getFullYear() + 1;
  const out: string[] = [];
  for (let y = end; y >= fromYear; y--) {
    for (let m = 12; m >= 1; m--) out.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return out;
}

/**
 * Месяцы для фильтра: только те, где есть данные, плюс текущий и выбранный.
 * Пустые месяцы прошлых лет в списке не нужны.
 */
export function monthChoices(withData: string[] = [], selected = ''): string[] {
  const now = new Date();
  const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const set = new Set(withData.filter((m) => /^\d{4}-\d{2}$/.test(m)));
  set.add(cur);
  if (/^\d{4}-\d{2}$/.test(selected)) set.add(selected);
  return [...set].sort((a, b) => b.localeCompare(a));
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return toIsoDate(d);
}

export function fmtNumber(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(v);
}

export function fmtMoney(v: number | null | undefined, currency = ''): string {
  const n = fmtNumber(v, Number.isInteger(v ?? 0) ? 0 : 2);
  return currency ? `${n} ${currency}` : n;
}

export function parseNumber(v: string): number | null {
  if (v === null || v === undefined) return null;
  const cleaned = String(v).replace(/\s/g, '').replace(',', '.');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** '56.001765,37.531211' → координаты */
export function parseCoords(v: string): { lat: number; lon: number } | null {
  const m = String(v)
    .trim()
    .match(/^(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1].replace(',', '.'));
  const lon = Number(m[2].replace(',', '.'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

export function fmtCoords(lat: number | null, lon: number | null): string {
  if (lat === null || lon === null) return '';
  return `${lat.toFixed(6)},${lon.toFixed(6)}`;
}

/** Ссылка на карту для навигатора */
export function mapLink(lat: number | null, lon: number | null, address?: string): string {
  if (lat !== null && lon !== null) return `https://yandex.ru/maps/?rtext=~${lat},${lon}&rtt=auto`;
  return `https://yandex.ru/maps/?text=${encodeURIComponent(address ?? '')}`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

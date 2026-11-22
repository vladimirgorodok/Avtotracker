import type { TableName } from '../types';

/**
 * Сравнение названий записей справочников.
 *
 * У фирм, грузов и АЗС название — это и есть лицо записи: «Ромашка», «РОМАШКА» и
 * «ООО «Ромашка»» должны считаться одной и той же записью. По этому правилу
 * приложение подбирает записи из заявки и сливает то, что заведено на двух
 * устройствах, поэтому правило живёт отдельно и в одном месте.
 */

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

/**
 * Название как есть: без регистра, кавычек и лишних знаков, но с формой
 * «ООО»/«ИП» — для фирм, где «ИП Иванов» и «ООО Иванов» разные записи.
 */
export function plainName(raw: string): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[«»"'`]/g, ' ')
    .replace(/[.,()\-–—/\\+№#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Таблицы, где название и есть лицо записи: «АБК» и «абк» — одна запись.
 *
 * По этому правилу обмен сливает записи, заведённые на двух устройствах, и по
 * нему же «Проверка данных» ищет дубли. Список живёт здесь, чтобы правило было
 * одно на всё приложение: у фирм так нельзя — «ИП Иванов» и «ООО Иванов» разные.
 */
export const SAME_BY_NAME: TableName[] = ['cargo_types', 'fuel_stations'];

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

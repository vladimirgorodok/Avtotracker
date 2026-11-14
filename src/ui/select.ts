/**
 * Общее для полей выбора из списка: сами записи и отбор по набранным буквам.
 * Держим отдельно от компонентов, чтобы поиск можно было проверить без экрана.
 */

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
  /** Логотип или значок записи: data URL либо ссылка */
  logo?: string;
}

/** С какого числа записей в списке выбора появляется поиск по набору букв */
export const SELECT_SEARCH_FROM = 6;

/** Отбор записей списка по набранным буквам: ищем и в названии, и в подсказке */
export function filterOptions<T extends string>(
  options: SelectOption<T>[],
  query: string,
): SelectOption<T>[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return options;
  return options.filter((o) => `${o.label} ${o.hint ?? ''}`.toLowerCase().includes(needle));
}

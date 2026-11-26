/**
 * Проверка обновлений приложения на GitHub.
 *
 * Приложение смотрит на страницу последней сборки в репозитории: GitHub отдаёт
 * номер версии, заметки к сборке и файл APK вместе с его контрольной суммой.
 * Если версия новее установленной, её можно скачать и передать системному
 * установщику — установку всегда подтверждает человек.
 *
 * Проверка идёт при запуске (не чаще раза в сутки) и кнопкой на экране
 * «Обновление». В браузере установить сборку нельзя — там проверка тоже
 * работает, а на месте установки открывается страница сборки.
 */

import { Capacitor, registerPlugin } from '@capacitor/core';
import { useApp } from '../store';
import { fmtDateTime } from './format';

/* ------------------------------------------------------------------ */
/* Версия, зашитая при сборке                                          */
/* ------------------------------------------------------------------ */

/** Имя версии: совпадает с versionName сборки APK */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
/** Номер сборки: совпадает с versionCode сборки APK */
export const APP_VERSION_CODE: number =
  typeof __APP_VERSION_CODE__ === 'string' ? Number(__APP_VERSION_CODE__) || 0 : 0;
/** Репозиторий, откуда приходили сборки */
export const UPDATE_REPO: string = typeof __UPDATE_REPO__ === 'string' ? __UPDATE_REPO__ : 'vladimirgorodok/Avtotracker';

/**
 * Версия установленного приложения.
 *
 * На телефоне её надёжнее спросить у самой системы: она знает точный номер
 * установленной сборки, даже если код собрали без номера версии. Зашитое при
 * сборке значение остаётся запасным — для браузера и на случай ошибки запроса.
 */
export async function installedVersion(): Promise<{ version: string; code: number }> {
  const fallback = { version: APP_VERSION, code: APP_VERSION_CODE };
  if (!Capacitor.isNativePlatform()) return fallback;
  try {
    const { App: CapApp } = await import('@capacitor/app');
    const info = await CapApp.getInfo();
    const version = String(info?.version ?? '').trim();
    const code = Number(info?.build ?? 0) || 0;
    return version ? { version, code } : fallback;
  } catch {
    return fallback;
  }
}

/** Адрес страницы последней сборки (для браузера и подсказки) */
export function releasePageUrl(): string {
  return `https://github.com/${UPDATE_REPO}/releases/latest`;
}

/* ------------------------------------------------------------------ */
/* Сравнение версий                                                    */
/* ------------------------------------------------------------------ */

/**
 * Какая версия новее: положительное число — `a` новее `b`, отрицательное — старее,
 * ноль — одинаковые. Сравниваем по частям, потому что 1.0.10 новее 1.0.9.
 */
export function compareVersions(a: string, b: string): number {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* Разбор ответа GitHub                                                */
/* ------------------------------------------------------------------ */

/** Что известно про последнюю сборку */
export interface ReleaseInfo {
  /** Имя версии, например 1.0.50 */
  version: string;
  /** Короткое имя коммита, если его удалось прочитать из заметок */
  commit: string;
  /** Когда сборка выложена */
  publishedAt: string;
  /** Прямая ссылка на файл APK */
  apkUrl: string;
  /** Размер файла в байтах */
  size: number;
  /** Контрольная сумма SHA-256 файла (может быть пустой) */
  sha256: string;
}

interface GitHubAsset {
  name?: string;
  browser_download_url?: string;
  size?: number;
  digest?: string | null;
}

interface GitHubRelease {
  tag_name?: string;
  name?: string;
  body?: string;
  published_at?: string;
  assets?: GitHubAsset[];
}

/** Вытащить номер версии из заметок к сборке: там есть готовая строка «версия 1.0.50» */
function versionFromNotes(body: string, fallback: string): string {
  const m = /версия\s+([0-9]+(?:\.[0-9]+)*)/i.exec(body ?? '');
  return m ? m[1] : fallback;
}

/** Вытащить короткое имя коммита из заметок: «коммит 36eb275» */
function commitFromNotes(body: string): string {
  const m = /коммит\s+([0-9a-f]{6,40})/i.exec(body ?? '');
  return m ? m[1].slice(0, 7) : '';
}

/** Разобрать ответ GitHub в понятный вид; возвращает null, если сборки нет */
export function parseRelease(release: GitHubRelease): ReleaseInfo | null {
  const asset = (release.assets ?? []).find((a) => (a.name ?? '').toLowerCase().endsWith('.apk'));
  if (!asset || !asset.browser_download_url) return null;
  const digest = String(asset.digest ?? '');
  return {
    version: versionFromNotes(String(release.body ?? ''), String(release.tag_name ?? '')),
    commit: commitFromNotes(String(release.body ?? '')),
    publishedAt: String(release.published_at ?? ''),
    apkUrl: asset.browser_download_url,
    size: Number(asset.size ?? 0),
    // digest приходит в виде «sha256:...» — оставляем только саму сумму
    sha256: digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : '',
  };
}

/** Запросить у GitHub сведения о последней сборке */
export async function fetchLatestRelease(): Promise<ReleaseInfo> {
  const url = `https://api.github.com/repos/${UPDATE_REPO}/releases/tags/latest`;
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (res.status === 404) throw new Error('Сборок пока нет: страница обновлений ещё не создана');
  if (!res.ok) throw new Error(`GitHub ответил ${res.status}`);
  const release = (await res.json()) as GitHubRelease;
  const info = parseRelease(release);
  if (!info) throw new Error('В последней сборке нет файла приложения');
  return info;
}

/* ------------------------------------------------------------------ */
/* Состояние проверки                                                  */
/* ------------------------------------------------------------------ */

export interface UpdateState {
  /** Установленная версия */
  current: string;
  /** Последняя версия на GitHub */
  latest: string;
  /** Доступна новая версия */
  available: boolean;
  /** Сборка на GitHub новее, чем можно поставить (номер сборки больше) */
  info: ReleaseInfo;
}

/** Нужно ли ставить сборку: версия на GitHub новее установленной */
export function isNewer(info: ReleaseInfo, current = APP_VERSION): boolean {
  if (!info.version) return false;
  return compareVersions(info.version, current) > 0;
}

/** Полная проверка: спрашиваем GitHub и сравниваем с установленной версией */
export async function checkForUpdate(): Promise<UpdateState> {
  const info = await fetchLatestRelease();
  const current = (await installedVersion()).version;
  useApp.getState().saveSetting('update_last_at', new Date().toISOString());
  return {
    current,
    latest: info.version,
    available: isNewer(info, current),
    info,
  };
}

/* ------------------------------------------------------------------ */
/* Нативное скачивание и установка                                     */
/* ------------------------------------------------------------------ */

interface AppUpdateNative {
  canInstall(): Promise<{ allowed: boolean }>;
  openInstallSettings(): Promise<void>;
  download(options: { url: string; sha256?: string }): Promise<{ path: string; size: number }>;
  install(options: { path: string }): Promise<void>;
  addListener(
    eventName: 'progress',
    listener: (data: { bytes: number; total: number; percent: number }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

const AppUpdate = registerPlugin<AppUpdateNative>('AppUpdate');

/** Есть ли родной обработчик установки: в браузере его нет */
export function nativeUpdateReady(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('AppUpdate');
  } catch {
    return false;
  }
}

/** Скачанная сборка ждёт установки — держим путь, чтобы не качать дважды */
let downloadedPath = '';
let downloadedVersion = '';

export function pendingInstall(): { path: string; version: string } | null {
  return downloadedPath ? { path: downloadedPath, version: downloadedVersion } : null;
}

/** Разрешено ли приложению ставить сборки поверх себя */
export async function canInstall(): Promise<boolean> {
  if (!nativeUpdateReady()) return false;
  const res = await AppUpdate.canInstall();
  return Boolean(res?.allowed);
}

/** Открыть системный экран разрешения установки */
export async function openInstallSettings(): Promise<void> {
  await AppUpdate.openInstallSettings();
}

/**
 * Скачать сборку в память приложения и проверить контрольную сумму.
 * `onProgress` зовут по ходу загрузки — по нему идёт полоса на экране.
 */
export async function downloadUpdate(
  info: ReleaseInfo,
  onProgress?: (percent: number) => void,
): Promise<string> {
  if (!nativeUpdateReady()) throw new Error('Установка доступна только в приложении на телефоне');
  let handle: { remove: () => Promise<void> } | null = null;
  if (onProgress) {
    handle = await AppUpdate.addListener('progress', (p) => onProgress(Math.max(0, Math.min(100, p.percent))));
  }
  try {
    const res = await AppUpdate.download({ url: info.apkUrl, sha256: info.sha256 || undefined });
    downloadedPath = res.path;
    downloadedVersion = info.version;
    onProgress?.(100);
    return res.path;
  } finally {
    await handle?.remove().catch(() => undefined);
  }
}

/** Передать скачанную сборку системному установщику */
export async function installUpdate(path = downloadedPath): Promise<void> {
  if (!path) throw new Error('Сборка ещё не скачана');
  await AppUpdate.install({ path });
}

/** Человеческая надпись о размере файла */
export function fileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

/* ------------------------------------------------------------------ */
/* Проверка при запуске                                                */
/* ------------------------------------------------------------------ */

/** Не чаще раза в сутки: чаще незачем, а GitHub ограничивает число запросов */
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

/** Пора ли проверять обновления при запуске */
export function autoUpdateWanted(): boolean {
  try {
    const s = useApp.getState().settings;
    if (Number(s.update_auto) !== 1) return false;
    const last = Date.parse(String(s.update_last_at ?? '')) || 0;
    return Date.now() - last > CHECK_EVERY_MS;
  } catch {
    return false;
  }
}

/**
 * Тихая проверка при запуске. О новых сборках говорим один раз — всплывающей
 * весточкой, а не окном: работа водителя важнее.
 */
export async function checkUpdateQuietly(): Promise<ReleaseInfo | null> {
  if (!autoUpdateWanted()) return null;
  try {
    const state = await checkForUpdate();
    if (!state.available) return null;
    useApp.getState().notify(`Вышла версия ${state.latest} — обновить можно на экране «Обновление»`, 'info');
    return state.info;
  } catch {
    // Нет сети или GitHub недоступен — молчим, это не ошибка приложения
    return null;
  }
}

/** Когда последний раз проверяли обновления, готовой строкой */
export function lastCheckText(): string {
  const at = String(useApp.getState().settings.update_last_at ?? '');
  return at ? fmtDateTime(at) : 'ещё не проверяли';
}

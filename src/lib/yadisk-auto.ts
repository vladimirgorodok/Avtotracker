/**
 * Автоматический обмен с Яндекс Диском.
 *
 * Порядок (в облаке всегда одна свежая копия):
 *  - при запуске: если есть невыгруженные изменения — выгружаем их,
 *    иначе забираем свежую копию, если она появилась на другом устройстве.
 *    Этот первый обмен идёт на виду — на экране запуска (startSync);
 *  - после изменений: через несколько секунд выгружаем новую копию;
 *  - при уходе приложения в фон: выгружаем, если есть что.
 *
 * Ошибки в тихом режиме не показываются сообщениями — они остаются на экране
 * «Яндекс Диск», чтобы не мешать работе.
 */

import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { useApp } from '../store';
import {
  cloudConfigured,
  cloudState,
  listDataFiles,
  markDirty,
  noteError,
  pullFromDisk,
  pushToDisk,
  type CloudPushResult,
  type PushReporter,
} from './yadisk';

/** Пауза после изменений перед выгрузкой */
const PUSH_DELAY_MS = 12000;
/** Пока идёт обмен, изменения данных считаем своими */
const QUIET_MS = 10000;

let started = false;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let busy = false;
let quietUntil = 0;
let lastRevision = -1;

/** Есть ли смысл что-то делать */
function active(): boolean {
  return cloudConfigured() && cloudState().auto;
}

/**
 * Нужен ли обмен при запуске: облако настроено и автобмен не выключен.
 * По этому признаку приложение решает, показывать ли окно обмена после заставки.
 */
export function autoSyncWanted(): boolean {
  try {
    return active();
  } catch {
    return false;
  }
}

/**
 * Что сейчас происходит с данными. По этому в шапке видно, всё ли сохранено
 * на устройстве и ушло ли в облако.
 */
export type SavePhase = 'off' | 'saved' | 'pending' | 'busy' | 'error';

export interface SaveStatus {
  /** Облако настроено и автобмен включён */
  on: boolean;
  /** off — облако выключено; saved — всё в облаке; pending — ждём выгрузку;
   *  busy — выгружаем; error — выгрузить не удалось */
  phase: SavePhase;
  /** Сколько осталось до выгрузки, мс — по этому идёт отсчёт в шапке */
  waitMs: number;
  /** Сколько ждём после изменений перед выгрузкой, мс */
  delayMs: number;
  /** Время последнего удачного обмена, ISO */
  lastAt: string;
  /** Текст последней ошибки обмена */
  error: string;
}

let phase: SavePhase = 'saved';
let pushAt = 0;

/** Как сейчас обстоят дела с сохранением и обменом — для шапки приложения */
export function saveStatus(): SaveStatus {
  let on = false;
  let lastAt = '';
  let error = '';
  try {
    const state = cloudState();
    on = state.configured && state.auto;
    lastAt = state.lastAt;
    error = state.lastError;
  } catch {
    /* база ещё не открыта — считаем, что сохранять нечего */
  }
  return {
    on,
    phase: on ? phase : 'off',
    waitMs: Math.max(0, pushAt - Date.now()),
    delayMs: PUSH_DELAY_MS,
    lastAt,
    error,
  };
}

function schedulePush(): void {
  if (pushTimer !== null) clearTimeout(pushTimer);
  phase = 'pending';
  pushAt = Date.now() + PUSH_DELAY_MS;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void quiet('push');
  }, PUSH_DELAY_MS);
}

/**
 * Обмен слил дубли записей справочников — говорим об этом.
 *
 * Случается это один раз: дальше дублей в списке уже нет. Молчать нельзя —
 * записи убрались без спроса, а вернуть их можно на экране «Проверка данных».
 */
function noteMerged(count: number): void {
  if (count <= 0) return;
  useApp.getState().notify(`Дубли в справочниках слиты: ${count}. Вернуть — «Проверка данных»`);
}

/** Дописать в надпись про слитые дубли, если они были */
function mergedText(count: number): string {
  return count > 0 ? `, слито дублей: ${count}` : '';
}

/**
 * Тихий обмен: изменения выгружаем, свежую чужую копию забираем.
 * Смысл: на устройстве не должно остаться данных новее, чем в облаке.
 */
async function quiet(kind: 'push' | 'pull' | 'any'): Promise<void> {
  if (busy || !active()) return;
  const state = cloudState();
  if (kind === 'push' && !state.dirty) return;
  busy = true;
  phase = 'busy';
  pushAt = 0;
  quietUntil = Date.now() + QUIET_MS;
  let failed = false;
  try {
    if (state.dirty) {
      const res = await pushToDisk();
      noteMerged(res.mergedDuplicates);
      return;
    }
    if (kind === 'push') return;
    const files = await listDataFiles();
    const newest = files[0];
    if (!newest) {
      const res = await pushToDisk();
      noteMerged(res.mergedDuplicates);
      return;
    }
    if (newest.name === state.lastData) return;
    const res = await pullFromDisk(false);
    noteMerged(res.mergedDuplicates);
  } catch (error) {
    failed = true;
    noteError(error instanceof Error ? error.message : 'Ошибка обмена с Яндекс Диском');
  } finally {
    quietUntil = Date.now() + QUIET_MS;
    busy = false;
    phase = failed ? 'error' : 'saved';
    pushAt = 0;
  }
}

/** Обмен по требованию: им пользуется кнопка на экране «Яндекс Диск» */
export async function autoSyncNow(): Promise<string> {
  if (!cloudConfigured()) throw new Error('Заполните логин Яндекс и пароль приложения');
  const state = cloudState();
  phase = 'busy';
  pushAt = 0;
  try {
    if (state.dirty) {
      const res = await pushToDisk();
      return `Выгружено в облако: ${res.dataName}`;
    }
    const files = await listDataFiles();
    const newest = files[0];
    if (!newest) {
      const res = await pushToDisk();
      return `В облаке копий не было — выгружено: ${res.dataName}`;
    }
    if (newest.name === state.lastData) return 'Обмен не нужен: на устройстве и в облаке одно и то же';
    const res = await pullFromDisk(false);
    return `Загружено из облака: ${res.dataName}`;
  } catch (error) {
    phase = 'error';
    throw error;
  } finally {
    if (phase === 'busy') phase = 'saved';
    pushAt = 0;
  }
}

/** Включить слежение за изменениями. Первый обмен делает экран запуска. */
export function startAutoSync(): void {
  if (started) return;
  started = true;
  lastRevision = useApp.getState().revision;

  useApp.subscribe((state) => {
    if (state.revision === lastRevision) return;
    lastRevision = state.revision;
    if (Date.now() < quietUntil) return;
    if (!active()) return;
    markDirty();
    schedulePush();
  });

  if (Capacitor.isNativePlatform()) {
    void CapApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) void quiet('push');
    }).catch(() => undefined);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void quiet('push');
    });
  }
}

/** Что сделал обмен при запуске */
export interface StartSyncResult {
  /** sent — выгрузили, got — забрали из облака, none — обмениваться нечем, off — обмен выключен */
  action: 'sent' | 'got' | 'none' | 'off';
  /** Готовая надпись для экрана запуска */
  text: string;
}

/**
 * Обмен при запуске приложения — с рассказом о ходе.
 *
 * Тем же порядком, что и тихий обмен: сначала выгружаем свои изменения, иначе
 * забираем свежую копию, если она появилась на другом устройстве. Отличается
 * тем, что экран запуска показывает ход и потому ждёт конца работы.
 *
 * Ошибку записываем в заметку для экрана «Яндекс Диск» и отдаём наверх:
 * экран запуска покажет причину и не станет держать приложение закрытым.
 */
export async function startSync(report?: PushReporter): Promise<StartSyncResult> {
  if (!active()) return { action: 'off', text: 'Обмен с облаком выключен' };

  // Дожидаемся тихого обмена, если он уже идёт: иначе выгрузки пошли бы вразнобой
  const deadline = Date.now() + 15000;
  while (busy && Date.now() < deadline) await pause(150);
  busy = true;
  phase = 'busy';
  pushAt = 0;
  quietUntil = Date.now() + QUIET_MS;
  try {
    const state = cloudState();
    if (state.dirty) {
      const res = await pushToDisk(report);
      return { action: 'sent', text: `Выгружено: ${res.dataName}${mergedText(res.mergedDuplicates)}` };
    }

    report?.({ step: 'data', text: 'Смотрю, нет ли свежей копии' });
    const files = await listDataFiles();
    const newest = files[0];
    if (!newest) {
      const res = await pushToDisk(report);
      return {
        action: 'sent',
        text: `В облаке копий не было — выгружено: ${res.dataName}${mergedText(res.mergedDuplicates)}`,
      };
    }
    if (newest.name === state.lastData) {
      return { action: 'none', text: 'На устройстве и в облаке одно и то же' };
    }
    const res = await pullFromDisk(false, report);
    return {
      action: 'got',
      text: `Загружено из облака: ${res.dataName}${mergedText(res.mergedDuplicates)}`,
    };
  } catch (error) {
    phase = 'error';
    noteError(error instanceof Error ? error.message : 'Ошибка обмена с Яндекс Диском');
    throw error;
  } finally {
    quietUntil = Date.now() + QUIET_MS;
    busy = false;
    if (phase === 'busy') phase = 'saved';
    pushAt = 0;
  }
}

/**
 * Выгрузка перед закрытием приложения.
 *
 * Дожидается тихого обмена, если он уже идёт: иначе два прохода выгрузили бы
 * данные дважды и оставили в облаке две почти одинаковые копии.
 */
export async function pushOnExit(report?: PushReporter): Promise<CloudPushResult> {
  const deadline = Date.now() + 15000;
  while (busy && Date.now() < deadline) await pause(150);
  busy = true;
  phase = 'busy';
  pushAt = 0;
  quietUntil = Date.now() + QUIET_MS;
  try {
    return await pushToDisk(report);
  } catch (error) {
    phase = 'error';
    throw error;
  } finally {
    quietUntil = Date.now() + QUIET_MS;
    busy = false;
    if (phase === 'busy') phase = 'saved';
    pushAt = 0;
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

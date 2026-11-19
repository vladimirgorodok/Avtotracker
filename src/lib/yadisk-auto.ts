/**
 * Автоматический обмен с Яндекс Диском.
 *
 * Порядок (в облаке всегда одна свежая копия):
 *  - при запуске: если есть невыгруженные изменения — выгружаем их,
 *    иначе забираем свежую копию, если она появилась на другом устройстве;
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

function schedulePush(): void {
  if (pushTimer !== null) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void quiet('push');
  }, PUSH_DELAY_MS);
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
  quietUntil = Date.now() + QUIET_MS;
  try {
    if (state.dirty) {
      await pushToDisk();
      return;
    }
    if (kind === 'push') return;
    const files = await listDataFiles();
    const newest = files[0];
    if (!newest) {
      await pushToDisk();
      return;
    }
    if (newest.name === state.lastData) return;
    await pullFromDisk(false);
  } catch (error) {
    noteError(error instanceof Error ? error.message : 'Ошибка обмена с Яндекс Диском');
  } finally {
    quietUntil = Date.now() + QUIET_MS;
    busy = false;
  }
}

/** Обмен по требованию: им пользуется кнопка на экране «Яндекс Диск» */
export async function autoSyncNow(): Promise<string> {
  if (!cloudConfigured()) throw new Error('Заполните логин Яндекс и пароль приложения');
  const state = cloudState();
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
}

/** Включить слежение за изменениями и запустить обмен при старте */
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

  void quiet('any');
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
  quietUntil = Date.now() + QUIET_MS;
  try {
    return await pushToDisk(report);
  } finally {
    quietUntil = Date.now() + QUIET_MS;
    busy = false;
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

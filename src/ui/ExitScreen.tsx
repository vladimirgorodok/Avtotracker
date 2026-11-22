/**
 * Экран закрытия приложения.
 *
 * Перед выходом по порядку: база пишется на устройство, обновляется её копия,
 * затем данные уходят в облако, если есть невыгруженные изменения. Оформление
 * повторяет заставку: та же фура, дорога и полоса прогресса.
 *
 * Если что-то не удалось, выход не навязывается: видно причину и есть выбор —
 * всё равно закрыть или вернуться в приложение.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { getDb } from '../db';
import { fmtDateTime, plural } from '../lib/format';
import { cloudState } from '../lib/yadisk';
import { pushOnExit } from '../lib/yadisk-auto';
import { applyStatusBarLightIcons, applyStatusBarTheme, useApp } from '../store';
import { Icon, type IconName } from './components';
import { TruckMark } from './Splash';

type StepState = 'wait' | 'run' | 'done' | 'skip' | 'err';

interface Step {
  key: string;
  title: string;
  icon: IconName;
  state: StepState;
  note?: string;
}

/** Что делаем по порядку. Ключи те же, что у put() ниже. */
const PLAN: { key: string; title: string; icon: IconName }[] = [
  { key: 'save', title: 'Записываю базу на устройство', icon: 'doc' },
  { key: 'copy', title: 'Обновляю копию базы', icon: 'copy' },
  { key: 'cloud', title: 'Обмен с Яндекс Диском', icon: 'upload' },
  { key: 'exit', title: 'Закрываю приложение', icon: 'power' },
];

function initialSteps(): Step[] {
  return PLAN.map((p) => ({ ...p, state: 'wait' as StepState }));
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Попросить систему закрыть приложение. Если она этого не сделала
 * (например, мы в браузере), остаётся кнопка «Вернуться в приложение».
 */
async function leaveApp(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await CapApp.exitApp().catch(() => undefined);
  await wait(1200);
}

export function ExitScreen({ onCancel }: { onCancel: () => void }) {
  const [steps, setSteps] = useState<Step[]>(initialSteps);
  const [sub, setSub] = useState('Сохраняю данные и проверяю облако');
  const [trouble, setTrouble] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [settled, setSettled] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const started = useRef(false);
  const cancelled = useRef(false);

  /** Счётчик времени: по нему видно, что обмен идёт, а не завис */
  useEffect(() => {
    if (settled || trouble) return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [settled, trouble]);

  const put = useCallback((key: string, state: StepState, note?: string) => {
    setSteps((prev) =>
      prev.map((s) => (s.key === key ? { ...s, state, ...(note !== undefined ? { note } : {}) } : s)),
    );
  }, []);

  /** Уход на тёмный фон: значки строки состояния делаем светлыми, потом возвращаем */
  useEffect(() => {
    applyStatusBarLightIcons();
    return () => applyStatusBarTheme(useApp.getState().settings.theme);
  }, []);

  useEffect(() => {
    // Строгий режим запускает эффект дважды — работу начинаем один раз
    if (started.current) return;
    started.current = true;

    void (async () => {
      let failed = '';

      // 1. База на устройстве
      put('save', 'run');
      try {
        const db = await getDb();
        await db.flush();
        const rows = db.rowCount();
        put(
          'save',
          'done',
          rows > 0
            ? `${rows} ${plural(rows, 'запись', 'записи', 'записей')}`
            : 'Записей пока нет',
        );

        // 2. Копия базы: по ней восстанавливаются данные, если файл не прочитается
        put('copy', 'run');
        const copied = await db.refreshBackup();
        put('copy', copied ? 'done' : 'skip', copied ? 'Копия обновлена' : 'Копировать нечего');
      } catch (e) {
        failed = reason(e);
        put('save', 'err', failed);
        put('copy', 'skip', 'Пропущено');
      }

      if (cancelled.current) return;

      // 3. Облако: выгружаем только если есть невыгруженные изменения
      const state = cloudState();
      if (!state.configured) {
        put('cloud', 'skip', 'Облако не настроено');
      } else if (!state.dirty) {
        put(
          'cloud',
          'skip',
          state.lastAt ? `Всё уже в облаке: ${fmtDateTime(state.lastAt)}` : 'Изменений нет',
        );
      } else {
        put('cloud', 'run', 'Выгружаю изменения');
        try {
          const res = await pushOnExit((stage) => put('cloud', 'run', stage.text));
          const files = res.filesUploaded > 0 ? `, файлов: ${res.filesUploaded}` : '';
          const gone = res.filesRemoved > 0 ? `, убрано лишних: ${res.filesRemoved}` : '';
          const dupes = res.mergedDuplicates > 0 ? `, слито дублей: ${res.mergedDuplicates}` : '';
          put(
            'cloud',
            'done',
            res.iconsFailed
              ? `Данные выгружены: ${res.dataName}. Значки и фотографии не ушли.`
              : `Выгружено: ${res.dataName}${files}${gone}${dupes}`,
          );
        } catch (e) {
          failed = failed || reason(e);
          put('cloud', 'err', reason(e));
        }
      }

      if (cancelled.current) return;

      // 4. Выход: при ошибке сначала спрашиваем, при успехе — просто закрываемся
      if (failed) {
        setTrouble(true);
        setSub('Не всё удалось сохранить — посмотрите причину');
        put('exit', 'wait', 'Жду решения');
        return;
      }

      put('exit', 'run', 'До встречи');
      setSub('Данные в порядке');
      setLeaving(true);
      await wait(950);
      if (cancelled.current) return;
      put('exit', 'done', 'Можно закрывать');
      setSub('Данные сохранены — приложение можно закрыть');
      setSettled(true);
      await leaveApp();
    })();
  }, [put]);

  const cancel = useCallback(() => {
    cancelled.current = true;
    onCancel();
  }, [onCancel]);

  const closeAnyway = useCallback(() => {
    cancelled.current = true;
    setTrouble(false);
    setSettled(true);
    setLeaving(true);
    setSub('Данные сохранены — приложение можно закрыть');
    void leaveApp();
  }, []);

  const finished = steps.filter((s) => s.state === 'done' || s.state === 'skip' || s.state === 'err').length;
  const percent = Math.round((finished / steps.length) * 100);

  return (
    <div className="exit-screen" role="dialog" aria-modal="true" aria-label="Закрытие приложения">
      <div className="splash-glow" />

      <div className="exit-stage">
        <div className={`exit-truck${leaving ? ' exit-truck-away' : ''}`}>
          <TruckMark />
        </div>

        <h1 className="exit-title">{trouble ? 'Не всё сохранилось' : 'Сохраняю и закрываю'}</h1>
        <p className="exit-sub">{sub}</p>

        <div
          className="exit-bar"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span style={{ width: `${percent}%` }} />
        </div>

        <ul className="exit-steps">
          {steps.map((s) => (
            <li key={s.key} className={`exit-step exit-step-${s.state}`}>
              <span className="exit-step-mark">
                {s.state === 'run' ? null : s.state === 'done' ? (
                  <Icon name="check" size={14} />
                ) : s.state === 'err' ? (
                  <Icon name="warning" size={14} />
                ) : s.state === 'skip' ? (
                  <Icon name="close" size={13} />
                ) : (
                  <Icon name={s.icon} size={13} />
                )}
              </span>
              <span className="exit-step-text">
                <span className="exit-step-title">{s.title}</span>
                {s.note ? <span className="exit-step-note">{s.note}</span> : null}
              </span>
            </li>
          ))}
        </ul>

        {seconds >= 5 && !settled && !trouble ? (
          <div className="exit-timer">
            {seconds >= 20
              ? `идёт ${seconds} с · значки и фотографии уходят дольше всего`
              : `идёт ${seconds} с`}
          </div>
        ) : null}

        {trouble ? (
          <div className="exit-actions">
            <button className="exit-btn" onClick={cancel}>
              Вернуться
            </button>
            <button className="exit-btn exit-btn-primary" onClick={closeAnyway}>
              Всё равно закрыть
            </button>
          </div>
        ) : settled ? (
          <div className="exit-actions">
            <button className="exit-btn" onClick={cancel}>
              Вернуться в приложение
            </button>
          </div>
        ) : (
          <button className="exit-cancel" onClick={cancel}>
            Отмена
          </button>
        )}
      </div>

      <div className="splash-road">
        <span className="splash-dash" />
      </div>
    </div>
  );
}

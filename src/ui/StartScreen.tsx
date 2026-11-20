/**
 * Окно обмена при запуске приложения.
 *
 * Показывается сразу после заставки, если облако настроено: база пишется на
 * устройство, затем идёт обмен — свои изменения выгружаем, чужую свежую копию
 * забираем. Оформление и шаги те же, что у экрана закрытия, поэтому окно
 * выглядит знакомо.
 *
 * Обмен не держит приложение закрытым: ошибку видно, можно повторить или
 * открыть приложение без обмена. И совсем долгий обмен окно не ждёт: через
 * 15 секунд приложение открывается само, а обмен дойдёт в фоне.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getDb } from '../db';
import { plural } from '../lib/format';
import { startSync } from '../lib/yadisk-auto';
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
  { key: 'base', title: 'Проверяю данные на устройстве', icon: 'doc' },
  { key: 'cloud', title: 'Обмен с Яндекс Диском', icon: 'download' },
  { key: 'open', title: 'Открываю приложение', icon: 'home' },
];

/** Сколько окно держится на виду: иначе при быстром обмене оно мигало бы */
const MIN_MS = 800;
/** Сколько фура уезжает перед показом приложения */
const LEAVE_MS = 800;
/** Дольше этого обмен не держим: приложение открываем, а обмен дойдёт в фоне */
const HOLD_MS = 15000;

function initialSteps(): Step[] {
  return PLAN.map((p) => ({ ...p, state: 'wait' as StepState }));
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function StartScreen({ onDone }: { onDone: () => void }) {
  const [steps, setSteps] = useState<Step[]>(initialSteps);
  const [sub, setSub] = useState('Смотрю, что нового в облаке');
  const [trouble, setTrouble] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [settled, setSettled] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const startedFor = useRef(-1);
  const cancelled = useRef(false);
  const opened = useRef(false);

  /** Открыть приложение — ровно один раз, каким бы путём мы ни пришли */
  const finish = useCallback(() => {
    if (opened.current) return;
    opened.current = true;
    onDone();
  }, [onDone]);

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
    if (startedFor.current === attempt) return;
    startedFor.current = attempt;

    cancelled.current = false;
    setSteps(initialSteps());
    setSub('Смотрю, что нового в облаке');
    setTrouble(false);
    setLeaving(false);
    setSettled(false);
    setSeconds(0);

    void (async () => {
      const at = Date.now();
      let failed = '';

      // Долгий обмен не должен запирать вход: окно уйдёт, а обмен дойдёт в фоне
      const hold = setTimeout(() => {
        put('cloud', 'run', 'Обмен продолжается в фоне');
        setSub('Открываю приложение — обмен закончится в фоне');
        finish();
      }, HOLD_MS);

      try {
        // 1. База на устройстве
        put('base', 'run');
        try {
          const db = await getDb();
          await db.flush();
          const rows = db.rowCount();
          put(
            'base',
            'done',
            rows > 0 ? `${rows} ${plural(rows, 'запись', 'записи', 'записей')}` : 'Записей пока нет',
          );
        } catch (e) {
          failed = reason(e);
          put('base', 'err', failed);
        }

        if (cancelled.current) return;

        // 2. Облако: свои изменения выгружаем, чужую свежую копию забираем
        put('cloud', 'run', 'Сверяюсь с облаком');
        try {
          const res = await startSync((stage) => put('cloud', 'run', stage.text));
          put('cloud', res.action === 'off' ? 'skip' : 'done', res.text);
        } catch (e) {
          failed = failed || reason(e);
          put('cloud', 'err', reason(e));
        }

        if (cancelled.current) return;

        // Обмен может пройти мгновенно — окно всё равно показываем чуть подольше
        const left = MIN_MS - (Date.now() - at);
        if (left > 0) await wait(left);
        if (cancelled.current) return;

        // 3. Приложение: при ошибке сначала спрашиваем, при успехе — просто открываем
        if (failed) {
          setTrouble(true);
          setSub('Обмен не удался — можно повторить или открыть приложение');
          put('open', 'wait', 'Жду решения');
          return;
        }

        put('open', 'run', 'Почти готово');
        setSub('Всё свежее — открываю приложение');
        setLeaving(true);
        await wait(LEAVE_MS);
        if (cancelled.current) return;
        put('open', 'done', 'Готово');
        setSettled(true);
        finish();
      } finally {
        clearTimeout(hold);
      }
    })();
  }, [attempt, put, finish]);

  /** Открыть приложение, не дожидаясь обмена */
  const skip = useCallback(() => {
    cancelled.current = true;
    finish();
  }, [finish]);

  const retry = useCallback(() => {
    setAttempt((a) => a + 1);
  }, []);

  const finished = steps.filter((s) => s.state === 'done' || s.state === 'skip' || s.state === 'err').length;
  const percent = Math.round((finished / steps.length) * 100);

  return (
    <div className="exit-screen" role="dialog" aria-modal="true" aria-label="Обмен при запуске">
      <div className="splash-glow" />

      <div className="exit-stage">
        <div className={`exit-truck${leaving ? ' exit-truck-away' : ''}`}>
          <TruckMark />
        </div>

        <h1 className="exit-title">{trouble ? 'Обмен не удался' : 'Проверяю и обновляю'}</h1>
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
            {seconds >= 10
              ? `идёт ${seconds} с · скоро открою приложение, обмен дойдёт в фоне`
              : `идёт ${seconds} с`}
          </div>
        ) : null}

        {trouble ? (
          <div className="exit-actions">
            <button className="exit-btn" onClick={retry}>
              Повторить
            </button>
            <button className="exit-btn exit-btn-primary" onClick={skip}>
              Открыть приложение
            </button>
          </div>
        ) : settled ? null : (
          <button className="exit-cancel" onClick={skip}>
            Пропустить
          </button>
        )}
      </div>

      <div className="splash-road">
        <span className="splash-dash" />
      </div>
    </div>
  );
}

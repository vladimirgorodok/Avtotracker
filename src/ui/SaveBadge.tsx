/**
 * Индикатор сохранения в шапке приложения.
 *
 * Показывает, что происходит с данными: запись на устройство, ожидание выгрузки
 * в облако (с отсчётом), сама выгрузка и её итог. По нажатию открывается экран
 * «Яндекс Диск», где всё подробно.
 *
 * Данные, которые сами уходят в облако, видно целиком: «Сохраняю…» → «В облако
 * 12 с» → «Выгружаю…» → «В облаке».
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { dbSync } from '../db';
import { saveStatus } from '../lib/yadisk-auto';
import { useApp } from '../store';
import { Icon, type IconName } from './components';

/** Изменения уже легли на диск? База может быть ещё не открыта */
function savedOnDevice(): boolean {
  try {
    return !dbSync().hasUnsaved();
  } catch {
    return true;
  }
}

/** Время последнего обмена — только часы и минуты */
function clockTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

export function SaveBadge() {
  useApp((s) => s.revision);
  const navigate = useNavigate();
  const [, tick] = useState(0);

  const status = saveStatus();
  const saving = !savedOnDevice();
  const counting = saving || status.phase === 'pending' || status.phase === 'busy';

  // Пока идёт запись или ожидание выгрузки, обновляем подпись раз в секунду:
  // так видно, что отсчёт идёт, а не всё замерло
  useEffect(() => {
    if (!counting) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [counting]);

  let text: string;
  let icon: IconName;
  let tone: 'neutral' | 'ok' | 'info' | 'warn' | 'err';
  let hint: string;
  let spinning = false;

  if (saving) {
    text = 'Сохраняю…';
    icon = 'refresh';
    tone = 'neutral';
    hint = 'Данные записываются на устройство';
    spinning = true;
  } else if (status.phase === 'busy') {
    text = 'Выгружаю…';
    icon = 'upload';
    tone = 'info';
    hint = 'Данные уходят в облако';
    spinning = true;
  } else if (status.phase === 'pending') {
    const left = Math.max(1, Math.ceil(status.waitMs / 1000));
    text = `В облако ${left} с`;
    icon = 'upload';
    tone = 'info';
    hint = `Сохранено. Через ${left} с данные сами уйдут в облако`;
  } else if (status.phase === 'error') {
    text = 'Не выгружено';
    icon = 'warning';
    tone = 'err';
    hint = status.error || 'Не удалось выгрузить данные в облако';
  } else if (status.on) {
    const at = clockTime(status.lastAt);
    text = at ? `В облаке ${at}` : 'В облаке';
    icon = 'check';
    tone = 'ok';
    hint = 'Данные сохранены и выгружены в облако';
  } else {
    text = 'Сохранено';
    icon = 'check';
    tone = 'ok';
    hint = 'Данные сохранены на устройстве. Обмен с облаком не настроен';
  }

  const open = () => navigate('/yadisk');
  const inner = (
    <>
      <Icon name={icon} size={13} />
      {text}
    </>
  );
  const cls = `badge${tone === 'neutral' ? '' : ` badge-${tone}`} save-badge${spinning ? ' save-badge-spin' : ''}`;

  if (status.on || status.phase === 'error') {
    return (
      <button type="button" className={cls} title={hint} onClick={open}>
        {inner}
      </button>
    );
  }

  return (
    <span className={cls} title={hint}>
      {inner}
    </span>
  );
}

/** Панель облачной синхронизации: вход, состояние, кнопка «Синхронизировать». */

import { useEffect, useState } from 'react';
import { Badge, Button, Field, Icon, TextInput } from './components';
import { useApp } from '../store';
import * as sb from '../lib/supabase';
import { pendingByTable, resetSyncMarkers, runSync, syncState } from '../lib/sync';
import { documentSummary } from '../lib/documents';
import { fmtDateTime, plural } from '../lib/format';

export function SyncPanel({ compact = false }: { compact?: boolean }) {
  const revision = useApp((s) => s.revision);
  const settings = useApp((s) => s.settings);
  const touch = useApp((s) => s.touch);
  const notify = useApp((s) => s.notify);

  const [email, setEmail] = useState(settings.supabase_email);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'in' | 'up' | 'sync' | ''>('');
  const [state, setState] = useState(() => syncState());

  useEffect(() => {
    setState(syncState());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, settings.supabase_url, settings.supabase_key, settings.supabase_user_id]);

  const ready = state.configured;
  const pendingTables = pendingByTable();
  const docs = documentSummary();

  async function doSignIn() {
    if (!ready) {
      notify('Сначала укажите адрес и ключ проекта', 'err');
      return;
    }
    if (!email.trim() || !password) {
      notify('Введите почту и пароль', 'err');
      return;
    }
    setBusy('in');
    try {
      await sb.signIn(email.trim(), password);
      setPassword('');
      touch();
      notify('Вход выполнен', 'ok');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Не удалось войти', 'err');
    } finally {
      setBusy('');
    }
  }

  async function doSignUp() {
    if (!ready) {
      notify('Сначала укажите адрес и ключ проекта', 'err');
      return;
    }
    if (!email.trim() || password.length < 6) {
      notify('Введите почту и пароль не короче 6 знаков', 'err');
      return;
    }
    setBusy('up');
    try {
      const msg = await sb.signUp(email.trim(), password);
      setPassword('');
      touch();
      notify(msg, 'ok');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Не удалось создать учётную запись', 'err');
    } finally {
      setBusy('');
    }
  }

  async function doSync() {
    setBusy('sync');
    try {
      const res = await runSync();
      touch();
      if (res.errors.length > 0) {
        notify(`Синхронизация с замечаниями: ${res.errors[0]}`, 'err');
      } else {
        notify(`Отправлено ${res.pushed}, принято ${res.pulled}, файлов ${res.files}`, 'ok');
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Не удалось синхронизироваться', 'err');
    } finally {
      setBusy('');
      setState(syncState());
    }
  }

  return (
    <div className="stack-sm">
      <div className="row wrap">
        <Badge tone={state.configured ? 'ok' : 'warn'}>
          {state.configured ? 'Проект указан' : 'Проект не указан'}
        </Badge>
        <Badge tone={state.signedIn ? 'ok' : 'neutral'}>{state.signedIn ? 'Вход выполнен' : 'Нет входа'}</Badge>
        <Badge tone={state.pending > 0 ? 'warn' : 'ok'}>
          {state.pending > 0 ? `Ожидают отправки: ${state.pending}` : 'Всё отправлено'}
        </Badge>
      </div>

      {state.lastSyncAt ? (
        <div className="small muted">
          Последняя синхронизация: {fmtDateTime(state.lastSyncAt)}
          {state.lastError ? ` · замечания: ${state.lastError}` : ''}
        </div>
      ) : (
        <div className="small muted">Синхронизация ещё не запускалась</div>
      )}

      {!state.configured ? (
        <div className="alert alert-warn">
          <Icon name="warning" />
          <span>
            Заполните «Адрес проекта» и «Ключ (anon)» ниже. Инструкция по настройке облака лежит в файле
            supabase/schema.sql в репозитории.
          </span>
        </div>
      ) : null}

      {state.configured && !state.signedIn ? (
        <>
          <Field label="Почта для входа в облако">
            <TextInput
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </Field>
          <Field label="Пароль" hint="Пароль хранится только на устройстве">
            <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <div className="row">
            <Button variant="primary" icon="check" disabled={busy !== ''} onClick={doSignIn}>
              Войти
            </Button>
            <Button icon="plus" disabled={busy !== ''} onClick={doSignUp}>
              Создать запись
            </Button>
          </div>
        </>
      ) : null}

      {state.signedIn ? (
        <>
          <Button variant="primary" block icon="refresh" disabled={busy !== ''} onClick={doSync}>
            {busy === 'sync' ? 'Синхронизация…' : 'Синхронизировать сейчас'}
          </Button>
          {pendingTables.length > 0 && !compact ? (
            <div className="pending-list">
              {pendingTables.map((t) => (
                <span key={t.table} className="small muted">
                  {t.table}: {t.count}
                </span>
              ))}
            </div>
          ) : null}
          <div className="row">
            <Button
              icon="close"
              onClick={() => {
                sb.signOut();
                touch();
                notify('Вы вышли из облака', 'info');
              }}
            >
              Выйти
            </Button>
            <span style={{ flex: 1 }} />
            <Button
              icon="refresh"
              onClick={() => {
                resetSyncMarkers();
                touch();
                notify('Отметки сброшены: следующая синхронизация отправит всё заново', 'info');
              }}
            >
              Полная сверка
            </Button>
          </div>
          <div className="small muted">
            Документов: {docs.count} · {plural(docs.count, 'файл', 'файла', 'файлов')},{' '}
            {Math.max(0, Math.round(docs.bytes / 1024))} КБ. Файлы уходят в облако при синхронизации.
          </div>
        </>
      ) : null}
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { App as CapApp } from '@capacitor/app';
import { Button, Card, Field, Icon, NumberInput, Page, Select, TextInput } from '../ui/components';
import { applyTheme, useApp } from '../store';
import { dbStats } from '../db/repo';
import { urlProblem } from '../lib/supabase';
import { SyncPanel } from '../ui/SyncPanel';
import { AiSettings } from '../ui/AiSettings';
import { loadDemoData } from '../db/seed';
import { getDb } from '../db';
import { applySettingsFile, exportSettingsFile } from '../lib/backup';
import { fileToText, pickFile } from '../db/storage';
import type { AppPalette } from '../types';

export default function SettingsPage() {
  const navigate = useNavigate();
  const settings = useApp((s) => s.settings);
  const saveSetting = useApp((s) => s.saveSetting);
  const touch = useApp((s) => s.touch);
  const notify = useApp((s) => s.notify);
  const revision = useApp((s) => s.revision);
  const [appInfo, setAppInfo] = useState<{ version: string; build: string } | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stats = useMemo(() => dbStats(), [revision]);

  useEffect(() => {
    void CapApp.getInfo()
      .then((info) => setAppInfo({ version: info.version, build: info.build }))
      .catch(() => setAppInfo(null));
  }, []);

  /** Настройки файлом: после переустановки не надо ничего вводить заново */
  async function saveSettingsToFile() {
    try {
      await exportSettingsFile();
      notify('Файл настроек готов — сохраните его', 'ok');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Не удалось сохранить настройки', 'err');
    }
  }

  async function loadSettingsFromFile() {
    const file = await pickFile('.json,application/json');
    if (!file) return;
    try {
      const applied = applySettingsFile(await fileToText(file));
      useApp.getState().init();
      const fresh = useApp.getState().settings;
      applyTheme(fresh.theme, fresh.palette);
      notify(`Настройки восстановлены: ${applied}`, 'ok');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Не удалось прочитать файл настроек', 'err');
    }
  }

  return (
    <Page title="Настройки" onBack={() => navigate('/more')}>
      <Card title="Расчёт начисления" actions={<Icon name="money" />}>
        <Field label="Базовая сумма за перевозку" hint="Начисляется за первые точки маршрута">
          <NumberInput value={settings.base_amount} onValue={(v) => saveSetting('base_amount', v ?? 0)} />
        </Field>
        <Field label="Доплата за каждую точку сверх базовых">
          <NumberInput
            value={settings.extra_point_amount}
            onValue={(v) => saveSetting('extra_point_amount', v ?? 0)}
          />
        </Field>
        <Field label="Базовое количество точек" hint="Обычно 2: одна погрузка и одна выгрузка">
          <NumberInput value={settings.base_points} onValue={(v) => saveSetting('base_points', v ?? 2)} />
        </Field>
        <div className="alert alert-info">
          <Icon name="ai" />
          <span>
            Пример: {settings.base_amount} за {settings.base_points} точки, плюс {settings.extra_point_amount} за
            каждую следующую. За 4 точки получится{' '}
            {settings.base_amount + Math.max(0, 4 - settings.base_points) * settings.extra_point_amount}.
          </span>
        </div>
      </Card>

      <Card title="Отображение" actions={<Icon name="settings" />}>
        <Field label="Тема">
          <Select
            value={settings.theme}
            onChange={(v) => {
              const theme = (v ?? 'light') as 'light' | 'dark';
              saveSetting('theme', theme);
              applyTheme(theme, settings.palette);
            }}
            options={[
              { value: 'light', label: 'Светлая' },
              { value: 'dark', label: 'Тёмная' },
            ]}
            placeholder="Светлая"
          />
        </Field>
        <Field label="Цветовая гамма" hint="Как на значке приложения или прежняя бирюзовая">
          <Select
            value={settings.palette}
            onChange={(v) => {
              const palette = (v ?? 'navy') as AppPalette;
              saveSetting('palette', palette);
              applyTheme(settings.theme, palette);
            }}
            options={[
              { value: 'navy', label: 'Тёмно-синяя' },
              { value: 'teal', label: 'Бирюзовая' },
            ]}
            placeholder="Тёмно-синяя"
          />
        </Field>
        <Field label="Обозначение валюты" hint="Оставьте пустым, чтобы показывать только числа">
          <TextInput
            value={settings.currency}
            onChange={(e) => saveSetting('currency', e.target.value)}
            placeholder="Например, ₽"
          />
        </Field>
      </Card>

      <Card title="ИИ-помощник" actions={<Icon name="ai" />}>
        <div className="small muted">
          Помощник видит сводку по вашим листам, перевозкам, топливу и деньгам. Ключ хранится только на
          устройстве, в коде приложения его нет.
        </div>
        <AiSettings />
        <Button icon="ai" onClick={() => navigate('/assistant')}>
          Открыть ИИ-помощника
        </Button>
      </Card>

      <Card title="Облачная синхронизация" actions={<Icon name="refresh" />}>
        <div className="small muted">
          Данные хранятся на телефоне и дублируются в ваш проект Supabase. Пока облако не настроено,
          приложение работает полностью офлайн.
        </div>

        <details className="guide">
          <summary>
            <Icon name="doc" size={16} />
            <span>Как настроить облако — подробная инструкция</span>
          </summary>
          <ol className="guide-steps">
            <li>
              Заведите бесплатную учётную запись:{' '}
              <a
                className="link"
                href="https://supabase.com/dashboard/sign-up"
                target="_blank"
                rel="noreferrer"
              >
                supabase.com — регистрация
              </a>
              . Подойдёт вход через GitHub или почту.
            </li>
            <li>
              В панели нажмите <b>New project</b>: любое имя, пароль базы (сохраните его), регион — ближе к
              вам.{' '}
              <a
                className="link"
                href="https://supabase.com/dashboard/projects"
                target="_blank"
                rel="noreferrer"
              >
                Список проектов
              </a>
            </li>
            <li>Дождитесь окончания создания проекта — это 1–2 минуты.</li>
            <li>
              Скопируйте два значения из раздела <b>Settings → API Keys</b>: <b>Project URL</b> и{' '}
              <b>anon public key</b>. Вставьте их в поля «Адрес проекта» и «Ключ (anon)» ниже.{' '}
              <a
                className="link"
                href="https://supabase.com/docs/guides/api/api-keys"
                target="_blank"
                rel="noreferrer"
              >
                Где взять ключи
              </a>
            </li>
            <li>
              Откройте <b>SQL Editor → New query</b>, вставьте содержимое файла{' '}
              <a
                className="link"
                href="https://github.com/vladimirgorodok/Avtotracker/blob/main/supabase/schema.sql"
                target="_blank"
                rel="noreferrer"
              >
                supabase/schema.sql
              </a>{' '}
              из репозитория и нажмите <b>Run</b>. Появятся таблицы и правила доступа к ним.
            </li>
            <li>
              В разделе <b>Authentication → Providers</b> включите поставщика <b>Email</b>. Чтобы при входе
              не требовалось подтверждать почту, выключите <b>Confirm email</b> (для личного пользования
              удобнее).
            </li>
            <li>
              Вернитесь в приложение, введите почту и пароль и нажмите <b>Создать запись</b>, затем{' '}
              <b>Войти</b>.
            </li>
            <li>
              Нажмите <b>Синхронизировать сейчас</b> — данные уедут в облако. Дальше отправлять изменения
              можно кнопкой «Отправить» на главной.
            </li>
          </ol>
          <div className="small muted">
            Ключ (anon) можно хранить в приложении: сам по себе он не открывает чужие данные — доступ
            ограничивают правила RLS из schema.sql. Пароль и токены входа хранятся только на телефоне.
          </div>
        </details>

        <Field label="Адрес проекта">
          <TextInput
            value={settings.supabase_url}
            onChange={(e) => saveSetting('supabase_url', e.target.value)}
            placeholder="https://xxxx.supabase.co"
          />
        </Field>
        {urlProblem(settings.supabase_url) ? (
          <div className="alert alert-warn">
            <Icon name="warning" />
            <span>{urlProblem(settings.supabase_url)}</span>
          </div>
        ) : null}
        <Field label="Ключ (anon)">
          <TextInput
            type="password"
            value={settings.supabase_key}
            onChange={(e) => saveSetting('supabase_key', e.target.value)}
          />
        </Field>
        <SyncPanel />
      </Card>

      <Card title="Настройки в файле" actions={<Icon name="doc" />}>
        <div className="small muted">
          В файл попадает всё, что вы вводили руками: ставки, оформление, адрес и ключ ИИ-помощника,
          адрес и ключ облака, вход в облако. Справочники и поездки — это данные, они сохраняются в
          «Обмене данными» (полная копия). Перед переустановкой приложения или при смене телефона
          сохраните настройки в файл, после — загрузите из него.
        </div>
        <Button icon="download" onClick={() => void saveSettingsToFile()}>
          Сохранить настройки в файл
        </Button>
        <Button icon="upload" onClick={() => void loadSettingsFromFile()}>
          Загрузить настройки из файла
        </Button>
        <Button icon="copy" onClick={() => navigate('/data')}>
          Полная копия: данные и настройки
        </Button>
      </Card>

      <Card title="Данные и диагностика" actions={<Icon name="warning" />}>
        <div className="grid-2">
          <div className="kv">
            <div className="kv-label">Хранилище</div>
            <div className="kv-value small">{stats.storage}</div>
          </div>
          <div className="kv">
            <div className="kv-label">Версия приложения</div>
            <div className="kv-value small">
              {appInfo ? `${appInfo.version} (сборка ${appInfo.build})` : '—'}
            </div>
          </div>
          <div className="kv">
            <div className="kv-label">Версия схемы</div>
            <div className="kv-value">{stats.schemaVersion}</div>
          </div>
          <div className="kv">
            <div className="kv-label">Записей</div>
            <div className="kv-value">{stats.total}</div>
          </div>
          <div className="kv">
            <div className="kv-label">Размер</div>
            <div className="kv-value">{Math.max(1, Math.round(stats.sizeBytes / 1024))} КБ</div>
          </div>
        </div>
        <Button
          icon="plus"
          onClick={() => {
            loadDemoData();
            touch();
            void getDb().then((db) => db.flush());
            notify('Пример данных загружен', 'ok');
          }}
        >
          Загрузить пример данных
        </Button>
        <Button icon="share" onClick={() => navigate('/data')}>
          Экспорт и импорт
        </Button>
        <Button
          icon="refresh"
          onClick={() => {
            void getDb().then((db) => db.flush());
            notify('База сохранена', 'ok');
          }}
        >
          Сохранить базу сейчас
        </Button>
        <div className="small muted">Обновлений данных: {revision}</div>
      </Card>
    </Page>
  );
}

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Field, Icon, NumberInput, Page, Select, TextInput } from '../ui/components';
import { applyTheme, useApp } from '../store';
import { dbStats } from '../db/repo';
import { SyncPanel } from '../ui/SyncPanel';
import { AiSettings } from '../ui/AiSettings';
import { loadDemoData } from '../db/seed';
import { getDb } from '../db';

export default function SettingsPage() {
  const navigate = useNavigate();
  const settings = useApp((s) => s.settings);
  const saveSetting = useApp((s) => s.saveSetting);
  const touch = useApp((s) => s.touch);
  const notify = useApp((s) => s.notify);
  const revision = useApp((s) => s.revision);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stats = useMemo(() => dbStats(), [revision]);

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
              applyTheme(theme);
            }}
            options={[
              { value: 'light', label: 'Светлая' },
              { value: 'dark', label: 'Тёмная' },
            ]}
            placeholder="Светлая"
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
        <Field label="Адрес проекта">
          <TextInput
            value={settings.supabase_url}
            onChange={(e) => saveSetting('supabase_url', e.target.value)}
            placeholder="https://xxxx.supabase.co"
          />
        </Field>
        <Field label="Ключ (anon)">
          <TextInput
            type="password"
            value={settings.supabase_key}
            onChange={(e) => saveSetting('supabase_key', e.target.value)}
          />
        </Field>
        <SyncPanel />
      </Card>

      <Card title="Данные и диагностика" actions={<Icon name="warning" />}>
        <div className="grid-2">
          <div className="kv">
            <div className="kv-label">Хранилище</div>
            <div className="kv-value small">{stats.storage}</div>
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

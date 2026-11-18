import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Confirm, Icon, IconButton, KV, MonthPicker, Page } from '../ui/components';
import { useApp } from '../store';
import { clearTable, countRows, dbStats } from '../db/repo';
import { fileToText, pickFile, type BackupInfo } from '../db/storage';
import { exportJson, exportPdfReport, exportXlsx, importJson, TABLE_TITLES } from '../lib/backup';
import { fmtDateTime, monthKey } from '../lib/format';
import { documentSummary } from '../lib/documents';
import { getDb } from '../db';
import type { TableName } from '../types';

/** Таблицы, которые можно чистить по отдельности (документы хранятся отдельно) */
const CLEARABLE: TableName[] = [
  'vehicles',
  'places',
  'companies',
  'cargo_types',
  'fuel_stations',
  'waybills',
  'trips',
  'trip_points',
  'refuelings',
  'finance_ops',
];

export default function DataPage() {
  const navigate = useNavigate();
  const revision = useApp((s) => s.revision);
  const settings = useApp((s) => s.settings);
  const touch = useApp((s) => s.touch);
  const notify = useApp((s) => s.notify);
  const [month, setMonth] = useState(() => monthKey(new Date().toISOString()));
  const [busy, setBusy] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [clearWhat, setClearWhat] = useState<TableName | null>(null);
  const dataWarning = useApp((s) => s.dataWarning);
  const setDataWarning = useApp((s) => s.setDataWarning);
  const [backup, setBackup] = useState<BackupInfo | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  async function refreshBackup() {
    try {
      const db = await getDb();
      setBackup(await db.backupInfo());
    } catch {
      setBackup(null);
    }
  }

  useEffect(() => {
    void refreshBackup();
  }, [revision]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stats = useMemo(() => dbStats(), [revision]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const docs = useMemo(() => documentSummary(), [revision]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const counts = useMemo(
    () => Object.fromEntries(CLEARABLE.map((t) => [t, countRows(t)])) as Record<TableName, number>,
    [revision],
  );

  async function run(name: string, fn: () => Promise<void>) {
    setBusy(name);
    try {
      await fn();
      notify('Готово', 'ok');
    } catch (e) {
      console.error(e);
      notify(e instanceof Error ? e.message : 'Ошибка', 'err');
    } finally {
      setBusy('');
    }
  }

  async function doImportJson() {
    const file = await pickFile('.json,application/json');
    if (!file) return;
    await run('import', async () => {
      const text = await fileToText(file);
      const res = importJson(text, overwrite);
      await getDb().then((db) => db.flush());
      touch();
      notify(res.message, 'ok');
    });
  }

  async function doSnapshot() {
    await run('snapshot', async () => {
      const db = await getDb();
      await db.snapshot();
      await refreshBackup();
      notify('Копия базы сохранена на устройстве', 'ok');
    });
  }

  async function doRestore() {
    setConfirmRestore(false);
    await run('restore', async () => {
      const db = await getDb();
      const ok = await db.restoreBackup();
      if (!ok) throw new Error('Копии базы на устройстве нет');
      notify('Копия возвращена — приложение перезапустится', 'ok');
      setTimeout(() => window.location.reload(), 700);
    });
  }

  async function doAcceptEmpty() {
    setConfirmEmpty(false);
    await run('empty', async () => {
      const db = await getDb();
      const parked = await db.acceptEmptyBase();
      setDataWarning(null);
      notify(
        parked ? `Продолжаем с пустой базой, старый файл отложен как ${parked}` : 'Продолжаем с пустой базой',
        'info',
      );
      touch();
    });
  }

  return (
    <Page title="Обмен данными" onBack={() => navigate('/more')}>
      <Card title="Состояние базы" actions={<Icon name="settings" />}>
        <div className="grid-2">
          <KV label="Размер базы" value={`${Math.max(1, Math.round(stats.sizeBytes / 1024))} КБ`} />
          <KV label="Всего записей" value={stats.total} />
          <KV label="Автомобили" value={countRows('vehicles')} />
          <KV label="Места" value={countRows('places')} />
          <KV label="Путевые листы" value={countRows('waybills')} />
          <KV label="Перевозки" value={countRows('trips')} />
          <KV label="Точки маршрута" value={countRows('trip_points')} />
          <KV label="Заправки" value={countRows('refuelings')} />
          <KV label="Финансы" value={countRows('finance_ops')} />
          <KV label="Документы" value={docs.count} />
          <KV label="Версия схемы" value={stats.schemaVersion} />
        </div>
        <div className="small muted">
          Хранилище: {stats.storage}. Фотографии документов ({docs.count} шт., {Math.max(0, Math.round(docs.bytes / 1024))} КБ)
          хранятся отдельно от базы и уезжают на Яндекс Диск отдельным архивом значков.
        </div>
      </Card>

      <Card title="Экспорт" actions={<Icon name="download" />}>
        <div className="small muted">Таблицы и отчёт — в файл на телефон</div>
        <Button block icon="download" disabled={busy !== ''} onClick={() => run('xlsx', exportXlsx)}>
          Скачать Excel (XLSX)
        </Button>
        <Button block icon="download" disabled={busy !== ''} onClick={() => run('json', exportJson)}>
          Скачать резервную копию (JSON)
        </Button>
        <div className="divider" />
        <MonthPicker value={month} onChange={setMonth} />
        <Button
          block
          icon="doc"
          disabled={busy !== ''}
          onClick={() => run('pdf', () => exportPdfReport(month, settings))}
        >
          Отчёт за месяц (PDF)
        </Button>
      </Card>

      <Card title="Импорт" actions={<Icon name="upload" />}>
        <div className="small muted">Совпадающие записи останутся без изменений</div>
        <Button variant="primary" block icon="upload" disabled={busy !== ''} onClick={doImportJson}>
          Выбрать резервную копию (JSON)
        </Button>
        <label className="row">
          <input
            type="checkbox"
            checked={overwrite}
            onChange={(e) => setOverwrite(e.target.checked)}
          />
          <span className="small">Обновлять совпадающие записи из JSON-копии</span>
        </label>
      </Card>

      <Card title="Записи по таблицам" actions={<Icon name="doc" />}>
        <div className="small muted">
          Лишнюю таблицу можно очистить по отдельности — остальные данные останутся на месте.
        </div>
        {CLEARABLE.map((t) => (
          <div key={t} className="list-item">
            <span className="li-main">
              <span className="li-title">{TABLE_TITLES[t]}</span>
              <span className="li-sub">{counts[t]} записей</span>
            </span>
            <IconButton
              icon="trash"
              title={`Очистить: ${TABLE_TITLES[t]}`}
              disabled={busy !== '' || counts[t] === 0}
              onClick={() => setClearWhat(t)}
            />
          </div>
        ))}
      </Card>

      <Card title="Защита данных" actions={<Icon name="undo" />}>
        {dataWarning ? (
          <div className="alert alert-err">
            <Icon name="warning" />
            <div>
              <b>База на устройстве не читается</b>
              <div className="small">{dataWarning}</div>
            </div>
          </div>
        ) : null}
        <div className="small muted">
          При запуске приложение оставляет копию базы на устройстве, а перед очисткой и загрузкой из
          облака обновляет её. Из копии можно вернуть данные, если что-то пошло не так. Надёжнее
          держать ещё и резервную копию файлом.
        </div>
        <KV
          label="Копия на устройстве"
          value={
            backup
              ? `${Math.max(1, Math.round(backup.size / 1024))} КБ${backup.at ? `, ${fmtDateTime(backup.at)}` : ''}`
              : 'пока нет'
          }
        />
        <div className="row">
          <Button block icon="copy" disabled={busy !== ''} onClick={doSnapshot}>
            Сделать копию сейчас
          </Button>
          <Button
            block
            icon="undo"
            disabled={busy !== '' || !backup}
            onClick={() => setConfirmRestore(true)}
          >
            Вернуть из копии
          </Button>
        </div>
        {dataWarning ? (
          <Button variant="danger" block icon="trash" disabled={busy !== ''} onClick={() => setConfirmEmpty(true)}>
            Продолжить с пустой базой
          </Button>
        ) : null}
      </Card>

      <Card title="Опасная зона" actions={<Icon name="warning" />}>
        <div className="small muted">
          Полная очистка удалит все данные на этом устройстве. Копия базы на устройстве сохранится —
          её можно вернуть в разделе «Защита данных».
        </div>
        <Button variant="danger" block icon="trash" onClick={() => setConfirmWipe(true)}>
          Очистить все данные
        </Button>
      </Card>

      <Confirm
        open={clearWhat !== null}
        title="Очистить таблицу"
        text={
          clearWhat
            ? `Все записи из таблицы «${TABLE_TITLES[clearWhat]}» (${counts[clearWhat]}) будут удалены. Связанные записи в других таблицах останутся и могут отображаться без ссылок.`
            : ''
        }
        confirmLabel="Очистить"
        onCancel={() => setClearWhat(null)}
        onConfirm={() => {
          const table = clearWhat;
          if (!table) return;
          void getDb().then(async (d) => {
            await d.snapshot().catch(() => undefined);
            clearTable(table);
            await d.flush();
            setClearWhat(null);
            touch();
            notify(`Таблица «${TABLE_TITLES[table]}» очищена`, 'info');
          });
        }}
      />

      <Confirm
        open={confirmRestore}
        title="Вернуть базу из копии"
        text="Текущие данные заменятся копией, сделанной при запуске приложения. Приложение перезапустится."
        confirmLabel="Вернуть"
        onCancel={() => setConfirmRestore(false)}
        onConfirm={doRestore}
      />

      <Confirm
        open={confirmEmpty}
        title="Продолжить с пустой базой"
        text="Непрочитанный файл базы останется на устройстве под другим именем. Работа продолжится с пустой базой."
        confirmLabel="Продолжить"
        onCancel={() => setConfirmEmpty(false)}
        onConfirm={doAcceptEmpty}
      />

      <Confirm
        open={confirmWipe}
        title="Очистить все данные"
        text="Все автомобили, листы, перевозки, заправки и финансы будут удалены безвозвратно."
        confirmLabel="Очистить"
        onCancel={() => setConfirmWipe(false)}
        onConfirm={() => {
          const db = getDb();
          void db.then(async (d) => {
            // Перед полной очисткой оставляем копию: вернуть её можно в «Защите данных»
            await d.snapshot().catch(() => undefined);
            d.tx(() => {
              for (const t of [
                'vehicles',
                'vehicle_periods',
                'vehicle_links',
                'companies',
                'cargo_types',
                'fuel_stations',
                'places',
                'waybills',
                'trips',
                'trip_points',
                'refuelings',
                'finance_ops',
              ]) {
                d.run(`DELETE FROM ${t}`);
              }
            });
            void d.flush();
            touch();
            notify('Данные очищены', 'info');
          });
          setConfirmWipe(false);
        }}
      />

      <div className="small muted" style={{ textAlign: 'center' }}>
        Строка revision: {revision}
      </div>
    </Page>
  );
}

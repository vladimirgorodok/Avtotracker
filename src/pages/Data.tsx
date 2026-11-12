import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Confirm, Icon, KV, MonthPicker, Page } from '../ui/components';
import { useApp } from '../store';
import { countRows, dbStats } from '../db/repo';
import { fileToBytes, fileToText, pickFile } from '../db/storage';
import {
  exportCsvZip,
  exportJson,
  exportPdfReport,
  exportXlsx,
  importCsvZip,
  importJson,
} from '../lib/backup';
import { monthKey } from '../lib/format';
import { documentSummary } from '../lib/documents';
import { getDb } from '../db';

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

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stats = useMemo(() => dbStats(), [revision]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const docs = useMemo(() => documentSummary(), [revision]);

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

  async function doImportZip() {
    const file = await pickFile('.zip,application/zip');
    if (!file) return;
    await run('import', async () => {
      const bytes = await fileToBytes(file);
      const res = await importCsvZip(bytes);
      touch();
      notify(res.message, 'ok');
    });
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
          хранятся отдельно от базы и уходят в облако при синхронизации.
        </div>
      </Card>

      <Card title="Экспорт" actions={<Icon name="download" />}>
        <div className="small muted">11 таблиц · CSV UTF-8</div>
        <Button
          variant="primary"
          block
          icon="download"
          disabled={busy !== ''}
          onClick={() => run('zip', exportCsvZip)}
        >
          Скачать ZIP-архив (CSV)
        </Button>
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
        <Button block icon="upload" disabled={busy !== ''} onClick={doImportZip}>
          Выбрать ZIP-архив (CSV)
        </Button>
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

      <Card title="Опасная зона" actions={<Icon name="warning" />}>
        <div className="small muted">
          Полная очистка удалит все данные на этом устройстве. Перед очисткой сделайте резервную копию.
        </div>
        <Button variant="danger" block icon="trash" onClick={() => setConfirmWipe(true)}>
          Очистить все данные
        </Button>
      </Card>

      <Confirm
        open={confirmWipe}
        title="Очистить все данные"
        text="Все автомобили, листы, перевозки, заправки и финансы будут удалены безвозвратно."
        confirmLabel="Очистить"
        onCancel={() => setConfirmWipe(false)}
        onConfirm={() => {
          const db = getDb();
          void db.then((d) => {
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

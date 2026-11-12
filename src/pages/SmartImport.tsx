/**
 * Умный импорт: разбираем чужой архив, показываем план переноса и подсказки,
 * каких полей не хватает в базе.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, Confirm, Icon, Page } from '../ui/components';
import { useApp } from '../store';
import { fileToBytes, pickFile } from '../db/storage';
import { getDb } from '../db';
import { deleteMeta, getMeta, putMeta, softDeleteMany } from '../db/repo';
import { isAiReady } from '../lib/ai';
import { TABLE_TITLES } from '../lib/backup';
import {
  applyPlan,
  buildPlan,
  readArchive,
  refineWithAi,
  type ApplyResult,
  type ArchiveSheet,
  type ImportPlan,
} from '../lib/smart-import';

const JOURNAL_KEY = 'import_journal';

interface Journal {
  at: string;
  fileName: string;
  ids: Record<string, string[]>;
  counts: Record<string, number>;
}

function loadJournal(): Journal | null {
  try {
    const raw = getMeta(JOURNAL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Journal;
    const hasIds = Object.values(parsed.ids ?? {}).some((list) => list.length > 0);
    return hasIds ? parsed : null;
  } catch {
    return null;
  }
}

function journalTotal(journal: Journal): number {
  return Object.values(journal.ids).reduce((acc, list) => acc + list.length, 0);
}

/** Сколько строк уйдёт в каждую таблицу — по убыванию */
export function summarizePlan(plan: ImportPlan): [string, number][] {
  const byTable = new Map<string, number>();
  for (const sheet of plan.sheets) {
    if (!sheet.table) continue;
    byTable.set(sheet.tableTitle, (byTable.get(sheet.tableTitle) ?? 0) + sheet.rows);
  }
  return [...byTable.entries()].sort((a, b) => b[1] - a[1]);
}

export default function SmartImport() {
  const navigate = useNavigate();
  const touch = useApp((s) => s.touch);
  const notify = useApp((s) => s.notify);
  const [fileName, setFileName] = useState('');
  const [sheets, setSheets] = useState<ArchiveSheet[]>([]);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [busy, setBusy] = useState('');
  const [journal, setJournal] = useState<Journal | null>(() => loadJournal());
  const [confirmUndo, setConfirmUndo] = useState(false);
  const aiReady = isAiReady();

  async function choose() {
    const file = await pickFile('.zip,.xlsx,.xls,.csv,.json,application/zip');
    if (!file) return;
    setBusy('read');
    setResult(null);
    try {
      const bytes = await fileToBytes(file);
      const parsed = await readArchive(bytes, file.name);
      if (parsed.length === 0) {
        notify('В архиве не нашлось таблиц с данными', 'err');
        setSheets([]);
        setPlan(null);
      } else {
        setSheets(parsed);
        setPlan(buildPlan(parsed));
        notify(`Разобрано файлов: ${parsed.length}`, 'ok');
      }
      setFileName(file.name);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Не удалось прочитать архив', 'err');
    } finally {
      setBusy('');
    }
  }

  async function askAi() {
    if (!plan) return;
    setBusy('ai');
    try {
      const refined = await refineWithAi(sheets, plan);
      setPlan(refined);
      notify(refined.aiNote, refined.aiUsed ? 'ok' : 'info');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Сервис ИИ не ответил', 'err');
    } finally {
      setBusy('');
    }
  }

  async function run() {
    if (!plan) return;
    setBusy('import');
    try {
      const res = applyPlan(sheets, plan);
      await getDb().then((db) => db.flush());
      setResult(res);
      const entry: Journal = {
        at: new Date().toISOString(),
        fileName: fileName || 'архив',
        ids: res.ids,
        counts: res.inserted,
      };
      try {
        putMeta(JOURNAL_KEY, JSON.stringify(entry));
        void getDb().then((db) => db.flush());
        setJournal(entry);
      } catch {
        // журнал не критичен для переноса
      }
      touch();
      notify(res.message, res.total > 0 ? 'ok' : 'info');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Ошибка переноса', 'err');
    } finally {
      setBusy('');
    }
  }

  /** Откат последнего переноса: помечаем добавленные записи удалёнными */
  async function undo() {
    if (!journal) return;
    setBusy('undo');
    try {
      let removed = 0;
      for (const [table, list] of Object.entries(journal.ids)) {
        if (list.length === 0) continue;
        removed += softDeleteMany(table, list);
      }
      deleteMeta(JOURNAL_KEY);
      await getDb().then((db) => db.flush());
      setJournal(null);
      setResult(null);
      setPlan(null);
      setSheets([]);
      touch();
      notify(`Отменено записей: ${removed}`, 'ok');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Не удалось отменить перенос', 'err');
    } finally {
      setBusy('');
      setConfirmUndo(false);
    }
  }

  const ready = plan?.sheets.some((s) => s.table && s.rows > 0) ?? false;

  return (
    <Page title="Умный импорт" onBack={() => navigate('/data')}>
      <Card title="Шаг 1. Архив" actions={<Icon name="upload" />}>
        <div className="small muted">
          Подойдёт ZIP с CSV, файл Excel, одиночный CSV или JSON-копия. Имена файлов и колонок могут быть
          любыми — разберём по смыслу.
        </div>
        <Button variant="primary" block icon="upload" disabled={busy !== ''} onClick={choose}>
          {fileName ? 'Выбрать другой файл' : 'Выбрать архив'}
        </Button>
        {fileName ? <div className="small muted">Файл: {fileName}</div> : null}
      </Card>

      {plan ? (
        <>
          <Card title="Шаг 2. Разбор" actions={<Icon name="ai" />}>
            <div className="small muted">
              {plan.sheets.length} файл(ов), строк всего:{' '}
              {plan.sheets.reduce((acc, s) => acc + s.rows, 0)}
            </div>
            {plan.sheets.map((sheet) => (
              <div key={sheet.source} className="list-item">
                <span className="avatar">
                  <Icon name={sheet.table ? 'doc' : 'warning'} />
                </span>
                <span className="li-main">
                  <span className="li-title">{sheet.source}</span>
                  <span className="li-sub">
                    {sheet.table
                      ? `${sheet.tableTitle} · строк ${sheet.rows} · уверенность ${Math.round(
                          sheet.confidence * 100,
                        )}%`
                      : 'таблица не распознана'}
                  </span>
                </span>
                <Badge tone={sheet.table ? 'ok' : 'warn'}>{sheet.table ? 'найдено' : 'мимо'}</Badge>
              </div>
            ))}
            <div className="divider" />
            <Button block icon="ai" disabled={busy !== '' || !aiReady} onClick={askAi}>
              {aiReady ? 'Уточнить разбор с помощью ИИ' : 'ИИ не настроен'}
            </Button>
            {plan.aiNote ? <div className="small muted">{plan.aiNote}</div> : null}
          </Card>

          <Card title="Шаг 3. Что перенесём" actions={<Icon name="route" />}>
            {ready ? (
              <div className="small">
                <b>Итого по таблицам:</b>{' '}
                {summarizePlan(plan)
                  .map(([title, n]) => `${title} — ${n} строк`)
                  .join(', ')}
              </div>
            ) : null}
            {plan.sheets
              .filter((s) => s.table)
              .map((sheet) => (
                <div key={sheet.source} className="stack">
                  <div>
                    <b>{sheet.source}</b> → {sheet.tableTitle}
                    {sheet.via === 'ИИ' ? ' (уточнено ИИ)' : ''}
                  </div>
                  <div className="small muted">
                    Колонки: {sheet.links.map((l) => `${l.from} → ${l.label}`).join('; ') || '—'}
                  </div>
                  {sheet.unknown.length > 0 ? (
                    <div className="small muted">Без места в базе: {sheet.unknown.join(', ')}</div>
                  ) : null}
                  {sheet.links.filter((l) => l.fk).length > 0 ? (
                    <div className="small muted">
                      Связи по старым id:{' '}
                      {sheet.links
                        .filter((l) => l.fk)
                        .map((l) => `${l.from} → ${TABLE_TITLES[l.fk!.target]}`)
                        .join(', ')}
                    </div>
                  ) : null}
                  {sheet.refs.length > 0 ? (
                    <div className="small muted">Создадим справочники: {sheet.refs.join(', ')}</div>
                  ) : null}
                </div>
              ))}
            {!ready ? <div className="small muted">Пока нечего переносить.</div> : null}
            <div className="divider" />
            <Button variant="primary" block icon="download" disabled={busy !== '' || !ready} onClick={run}>
              Перенести данные
            </Button>
            <div className="small muted">
              Записи добавляются новыми: справочники (места, грузы, фирмы) находятся по названию или
              создаются, а повторный перенос того же файла добавит копии. Ссылки между таблицами
              (перевозка → лист, точка → место, заправка → АЗС) восстанавливаются по старым id.
            </div>
          </Card>

          {plan.advice.length > 0 ? (
            <Card title="Рекомендации" actions={<Icon name="warning" />}>
              <div className="small muted">
                Эти поля есть в архиве, но не в базе. Если они нужны — их можно добавить в проект.
              </div>
              {plan.advice.map((line) => (
                <div key={line} className="small">
                  • {line}
                </div>
              ))}
            </Card>
          ) : null}
        </>
      ) : null}

      {result ? (
        <Card title="Готово" actions={<Icon name="check" />}>
          <div>
            <b>{result.message}</b>
          </div>
          {Object.entries(result.inserted).map(([table, count]) => (
            <div key={table} className="small muted">
              {table}: {count}
            </div>
          ))}
          <div className="divider" />
          <Button block icon="home" onClick={() => navigate('/')}>
            На главную
          </Button>
        </Card>
      ) : null}

      {journal ? (
        <Card title="Последний перенос" actions={<Icon name="undo" />}>
          <div className="small muted">
            {journal.fileName} · {new Date(journal.at).toLocaleString('ru-RU')} · записей{' '}
            {journalTotal(journal)}
          </div>
          {Object.entries(journal.counts).map(([table, count]) => (
            <div key={table} className="small muted">
              {table}: {count}
            </div>
          ))}
          <div className="divider" />
          <Button
            variant="danger"
            block
            icon="trash"
            disabled={busy !== ''}
            onClick={() => setConfirmUndo(true)}
          >
            Отменить перенос
          </Button>
          <div className="small muted">
            Отмена уберёт именно записи этого переноса — остальные данные не пострадают.
          </div>
        </Card>
      ) : null}

      <Confirm
        open={confirmUndo}
        title="Отменить перенос?"
        text="Все записи, добавленные последним переносом (включая созданные справочники), будут удалены."
        confirmLabel="Отменить"
        onCancel={() => setConfirmUndo(false)}
        onConfirm={() => void undo()}
      />
    </Page>
  );
}

/**
 * Умный импорт: разбираем чужой архив, показываем план переноса и подсказки,
 * каких полей не хватает в базе.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, Icon, Page } from '../ui/components';
import { useApp } from '../store';
import { fileToBytes, pickFile } from '../db/storage';
import { getDb } from '../db';
import { isAiReady } from '../lib/ai';
import {
  applyPlan,
  buildPlan,
  readArchive,
  refineWithAi,
  type ApplyResult,
  type ArchiveSheet,
  type ImportPlan,
} from '../lib/smart-import';

export default function SmartImport() {
  const navigate = useNavigate();
  const touch = useApp((s) => s.touch);
  const notify = useApp((s) => s.notify);
  const [fileName, setFileName] = useState('');
  const [sheets, setSheets] = useState<ArchiveSheet[]>([]);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [busy, setBusy] = useState('');
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
      touch();
      notify(res.message, res.total > 0 ? 'ok' : 'info');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Ошибка переноса', 'err');
    } finally {
      setBusy('');
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
              создаются, а повторный перенос того же файла добавит копии.
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
    </Page>
  );
}

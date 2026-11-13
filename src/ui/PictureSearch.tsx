/**
 * Поиск логотипов и значков по названию.
 *
 * Показывает ход поиска, откуда пришла каждая картинка, и даёт выбрать одну из
 * многих. Используется и в карточках справочника (окном), и на отдельном экране.
 */

import { useRef, useState } from 'react';
import { Button, Empty, Field, Icon, Modal, Select, TextInput } from './components';
import { useApp } from '../store';
import { readAiConfig } from '../lib/ai';
import {
  PICTURE_KINDS,
  pictureToDataUrl,
  searchPictures,
  type PictureHit,
  type PictureKind,
  type PictureProgress,
  type PictureQuery,
} from '../lib/pictures';

/** Шаги поиска — по ним видно, чем сейчас занят помощник */
const STEPS: { stage: PictureProgress['stage']; label: string }[] = [
  { stage: 'variants', label: 'Варианты названия' },
  { stage: 'icons', label: 'Значки' },
  { stage: 'logos', label: 'Логотипы и картинки' },
  { stage: 'sites', label: 'Значки сайта' },
];

function stepIndex(stage: PictureProgress['stage']): number {
  if (stage === 'done') return STEPS.length;
  return STEPS.findIndex((s) => s.stage === stage);
}

export function PictureSearch({
  initialName,
  initialKind = 'company',
  showKind = true,
  onPick,
}: {
  initialName: string;
  initialKind?: PictureKind;
  showKind?: boolean;
  onPick: (value: string, hit: PictureHit) => void;
}) {
  const notify = useApp((s) => s.notify);
  const [name, setName] = useState(initialName);
  const [kind, setKind] = useState<PictureKind>(initialKind);
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState<PictureHit[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [query, setQuery] = useState<PictureQuery | null>(null);
  const [progress, setProgress] = useState<PictureProgress | null>(null);
  const [error, setError] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);
  const [broken, setBroken] = useState<string[]>([]);
  const [searched, setSearched] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  async function run() {
    const text = name.trim();
    if (text === '' || busy) return;
    setBusy(true);
    setError('');
    setHits([]);
    setNotes([]);
    setQuery(null);
    setBroken([]);
    setSearched(false);
    setProgress({ stage: 'variants', text: 'Собираю варианты названия' });
    try {
      const res = await searchPictures({
        name: text,
        kind,
        cfg: readAiConfig(),
        onProgress: setProgress,
      });
      setHits(res.hits);
      setNotes(res.notes);
      setQuery(res.query);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось выполнить поиск');
    } finally {
      setBusy(false);
      setSearched(true);
    }
  }

  /** Скачиваем картинку; если не получилось — оставляем ссылку, её тоже видно */
  async function choose(hit: PictureHit) {
    if (savingId !== null) return;
    setSavingId(hit.id);
    try {
      const value = await pictureToDataUrl(hit);
      onPick(value, hit);
    } catch {
      onPick(hit.url, hit);
      notify('Картинку не удалось скачать — сохранена ссылка на неё', 'info');
    } finally {
      setSavingId(null);
    }
  }

  const stage = progress ? stepIndex(progress.stage) : 0;
  const percent = progress ? Math.round((stage / STEPS.length) * 100) : 0;
  const queries = query ? [...query.icon, ...query.web].slice(0, 5) : [];

  return (
    <div className="stack-sm">
      <Field label={showKind ? 'Что ищем' : 'Название'} hint="можно поправить как угодно">
        <div className="row">
          <TextInput
            className="grow"
            value={name}
            placeholder="Например, Маловасилевский ООО"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void run();
            }}
          />
          <Button variant="primary" icon="ai" disabled={busy || name.trim() === ''} onClick={() => void run()}>
            {busy ? 'Ищу…' : 'Найти'}
          </Button>
        </div>
      </Field>

      {showKind ? (
        <Field label="Что это">
          <Select
            value={kind}
            onChange={(v) => setKind((v ?? 'company') as PictureKind)}
            options={PICTURE_KINDS.map((k) => ({ value: k.value, label: `${k.label} — ${k.hint}` }))}
          />
        </Field>
      ) : null}

      {progress ? (
        <div className="progress-box" ref={boxRef}>
          <div className="progress-head">
            <span className={busy ? 'spin' : ''}>
              <Icon name={busy ? 'refresh' : progress.stage === 'done' ? 'check' : 'ai'} size={16} />
            </span>
            <span className="small">{progress.text}</span>
            <span style={{ flex: 1 }} />
            {progress.found ? <span className="small muted">картинок: {progress.found}</span> : null}
          </div>
          <div className="progress">
            <i style={{ width: `${Math.min(100, percent)}%` }} />
          </div>
          <div className="progress-steps">
            {STEPS.map((s, i) => (
              <div
                key={s.stage}
                className={`progress-step ${i < stage ? 'done' : ''} ${i === stage && busy ? 'active' : ''}`}
              >
                <span className="progress-dot">
                  {i < stage || (!busy && progress.stage === 'done') ? <Icon name="check" size={11} /> : null}
                </span>
                <span>{s.label}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {query ? (
        <div className="small muted">
          <Icon name="ai" size={13} />{' '}
          {query.byAi ? 'Варианты названия подобрал помощник' : 'Ключ ИИ не задан — ищу по названию как есть'}
          {query.note ? `: ${query.note}` : ''}
        </div>
      ) : null}

      {queries.length > 0 ? (
        <div className="small muted">Запросы: {queries.join(' · ')}</div>
      ) : null}

      {error ? (
        <div className="alert alert-err">
          <Icon name="warning" />
          <span>{error}</span>
        </div>
      ) : null}

      {notes.length > 0 ? <div className="small muted">{notes.join(' · ')}</div> : null}

      {hits.length > 0 ? (
        <div className="pic-grid">
          {hits.map((h) => (
            <button
              type="button"
              key={h.id}
              className="pic-tile"
              disabled={savingId !== null}
              onClick={() => void choose(h)}
              title={`${h.title} — ${h.source}`}
            >
              <span className="pic-img">
                {broken.includes(h.id) ? (
                  <Icon name="warning" />
                ) : (
                  <img
                    src={h.thumb}
                    alt=""
                    loading="lazy"
                    onError={() => setBroken((list) => (list.includes(h.id) ? list : [...list, h.id]))}
                  />
                )}
              </span>
              <span className="pic-title">{h.title}</span>
              <span className="pic-source">{savingId === h.id ? 'Готовлю картинку…' : h.source}</span>
            </button>
          ))}
        </div>
      ) : null}

      {searched && !busy && hits.length === 0 ? (
        <Empty text="Ничего не нашлось. Попробуйте другое название или выберите «Груз» / «Место» — для них наборы значков больше." />
      ) : null}
    </div>
  );
}

/** То же самое, но окном — так подбирают картинку прямо из карточки справочника */
export function PicturePicker({
  name,
  kind,
  title = 'Подобрать логотип или значок',
  onClose,
  onPick,
}: {
  name: string;
  kind: PictureKind;
  title?: string;
  onClose: () => void;
  onPick: (value: string, hit: PictureHit) => void;
}) {
  return (
    <Modal open title={title} onClose={onClose}>
      <PictureSearch
        initialName={name}
        initialKind={kind}
        showKind={false}
        onPick={(value, hit) => {
          onPick(value, hit);
          onClose();
        }}
      />
    </Modal>
  );
}

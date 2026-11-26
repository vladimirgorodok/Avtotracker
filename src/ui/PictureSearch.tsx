/**
 * Поиск логотипов и значков по названию.
 *
 * Показывает ход поиска, откуда пришла каждая картинка, и даёт выбрать одну из
 * многих. Используется и в карточках справочника (окном), и на отдельном экране.
 */

import { useEffect, useRef, useState } from 'react';
import { Button, Empty, Field, Icon, Modal, Select, Tabs, TextInput } from './components';
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
import {
  catalogAll,
  catalogByCategory,
  catalogCategories,
  collectionLogos,
  loadCatalog,
  loadCollections,
  searchCatalog,
  toHits,
  TRACE_REPO,
  type TraceCollection,
  type TraceLogo,
} from '../lib/tracelogos';

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
  current = '',
  onPick,
}: {
  initialName: string;
  initialKind?: PictureKind;
  showKind?: boolean;
  /** Нынешняя картинка записи — показываем её, чтобы видеть, что меняем */
  current?: string;
  /** Картинка выбрана: найденная в интернете или своя из файла (тогда hit — null) */
  onPick: (value: string, hit: PictureHit | null) => void;
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
  // Поиск в каталоге Trace Logos: кнопка рядом с «Из файла» и «Найти»
  const [traceHits, setTraceHits] = useState<PictureHit[]>([]);
  const [traceBusy, setTraceBusy] = useState(false);
  const [traceNote, setTraceNote] = useState('');
  const [traceSearched, setTraceSearched] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

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

  /** Своя картинка из файла: ставим её так же, как найденную */
  function pickFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => onPick(String(reader.result), null);
    reader.readAsDataURL(file);
  }

  /**
   * Поиск по контексту в каталоге Trace Logos: ищем по названию записи.
   * Каталог скачивается один раз и остаётся в памяти, дальше поиск мгновенный.
   */
  async function runTrace() {
    const text = name.trim();
    if (traceBusy) return;
    setTraceBusy(true);
    setTraceNote('');
    setTraceSearched(false);
    setTraceHits([]);
    try {
      const catalog = await loadCatalog();
      const found = searchCatalog(catalog, text, 30);
      setTraceHits(toHits(found));
      setTraceNote(
        found.length === 0
          ? 'В каталоге ничего не нашлось — откройте «Все картинки» и выберите вручную'
          : `Найдено в каталоге: ${found.length}`,
      );
    } catch (e) {
      setTraceNote(e instanceof Error ? e.message : 'Каталог недоступен — проверьте интернет');
    } finally {
      setTraceBusy(false);
      setTraceSearched(true);
    }
  }

  /** Окно со всеми марками каталога: выбираем глазами */
  function openCatalog() {
    setCatalogOpen(true);
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

      {current ? (
        <div className="row">
          <span className="avatar" style={{ width: 48, height: 48 }}>
            <img src={current} alt="" />
          </span>
          <div className="li-main">
            <div className="li-sub">Сейчас стоит эта картинка — новая её заменит</div>
          </div>
        </div>
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

      {/* Поиск по контексту в каталоге Trace Logos: много российских фирм */}
      <div className="trace-search">
        <div className="small muted">
          <Icon name="github" size={14} />{' '}
          Ещё можно поискать в каталоге логотипов Trace Logos — там российские фирмы, банки и марки.
        </div>
        <div className="row wrap">
          <Button icon="github" disabled={traceBusy || name.trim() === ''} onClick={() => void runTrace()}>
            {traceBusy ? 'Ищу в каталоге…' : 'Поиск в каталоге'}
          </Button>
          <Button icon="search" onClick={openCatalog}>
            Все картинки каталога
          </Button>
        </div>
        {traceNote ? <div className="small muted">{traceNote}</div> : null}

        {traceHits.length > 0 ? (
          <div className="pic-grid">
            {traceHits.map((h) => (
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

        {traceSearched && !traceBusy && traceHits.length === 0 ? (
          <div className="small muted">
            Ничего не нашлось — откройте «Все картинки каталога» и выберите вручную.
          </div>
        ) : null}
      </div>

      <div className="row wrap">
        <Button icon="upload" onClick={() => fileRef.current?.click()}>
          Из файла
        </Button>
        <span className="small muted">своя картинка вместо найденной</span>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) pickFile(f);
            e.target.value = '';
          }}
        />
      </div>

      <CatalogModal
        open={catalogOpen}
        onClose={() => setCatalogOpen(false)}
        onPick={(hit) => {
          setCatalogOpen(false);
          void choose(hit);
        }}
      />
    </div>
  );
}

/**
 * Окно со всеми марками каталога. Два способа смотреть: «папки» — разделы и
 * готовые подборки каталога (удобно, когда не знаешь точного названия), и «все
 * картинки» — сплошная сетка. Рисуем порциями: марок полторы тысячи.
 */
export function CatalogModal({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (hit: PictureHit) => void;
}) {
  const [catalog, setCatalog] = useState<TraceLogo[] | null>(null);
  const [collections, setCollections] = useState<TraceCollection[]>([]);
  const [mode, setMode] = useState<'folders' | 'all'>('folders');
  const [folder, setFolder] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [broken, setBroken] = useState<string[]>([]);
  // Каталог большой (полторы тысячи марок) — рисуем порциями, чтобы телефон не тормозил
  const [shown, setShown] = useState(96);

  // Каталог и подборки качаем при открытии — держим в памяти, пока приложение открыто
  useEffect(() => {
    if (!open || catalog !== null) return;
    let alive = true;
    setBusy(true);
    setError('');
    loadCatalog()
      .then((list) => {
        if (alive) setCatalog(list);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'Каталог недоступен');
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    // Подборки — необязательное дополнение: без них остаются разделы
    loadCollections()
      .then((list) => {
        if (alive) setCollections(list);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [open, catalog]);

  const list = catalog ?? [];
  const categories = catalogCategories(list);
  const needle = query.trim().toLowerCase();

  const inFolder = (slug: string): TraceLogo[] => {
    if (slug === '') return catalogAll(list);
    if (slug.startsWith('collection:')) {
      const c = collections.find((x) => x.slug === slug.slice('collection:'.length));
      return c ? collectionLogos(list, c) : [];
    }
    return catalogByCategory(list, slug);
  };

  let filtered = mode === 'all' ? inFolder('') : inFolder(folder);
  if (needle !== '') {
    filtered = filtered.filter(
      (l) => l.name.toLowerCase().includes(needle) || l.nameEn.toLowerCase().includes(needle) || l.tags.includes(needle),
    );
  }
  const visible = filtered.slice(0, shown);

  // Сменили папку или поиск — показываем список с начала
  const reset = () => setShown(96);

  return (
    <Modal open={open} title="Картинки из каталога" onClose={onClose}>
      {error !== '' ? (
        <div className="alert alert-err">
          <Icon name="warning" />
          <span>{error}</span>
        </div>
      ) : null}
      {busy && catalog === null ? (
        <div className="small muted">Загружаю каталог…</div>
      ) : null}

      {catalog !== null ? (
        <Tabs
          value={mode}
          onChange={(v) => {
            setMode(v);
            reset();
          }}
          items={[
            { value: 'folders', label: 'Папки' },
            { value: 'all', label: 'Все картинки' },
          ]}
        />
      ) : null}

      <Field label="Поиск по каталогу" hint="название марки или фирмы">
        <TextInput
          value={query}
          placeholder="Например, Сбер"
          onChange={(e) => {
            setQuery(e.target.value);
            reset();
          }}
        />
      </Field>

      {mode === 'folders' && catalog !== null ? (
        <div className="folder-list">
          <button
            type="button"
            className={`folder ${folder === '' ? 'folder-active' : ''}`}
            onClick={() => {
              setFolder('');
              reset();
            }}
          >
            <span className="folder-icon">
              <Icon name="folder" />
            </span>
            <span className="folder-name">Всё вместе</span>
            <span className="folder-count">{catalogAll(list).length}</span>
          </button>

          {collections.length > 0 ? (
            <div className="folder-group">
              <div className="folder-head">Подборки каталога</div>
              {collections.map((c) => {
                const slug = `collection:${c.slug}`;
                return (
                  <button
                    key={slug}
                    type="button"
                    className={`folder ${folder === slug ? 'folder-active' : ''}`}
                    onClick={() => {
                      setFolder(slug);
                      reset();
                    }}
                  >
                    <span className="folder-icon">{c.icon}</span>
                    <span className="folder-name">{c.title}</span>
                    <span className="folder-count">{collectionLogos(list, c).length}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          <div className="folder-group">
            <div className="folder-head">Разделы</div>
            {categories.map((c) => (
              <button
                key={c.slug}
                type="button"
                className={`folder ${folder === c.slug ? 'folder-active' : ''}`}
                onClick={() => {
                  setFolder(c.slug);
                  reset();
                }}
              >
                <span className="folder-icon">
                  <Icon name="folder" />
                </span>
                <span className="folder-name">{c.name}</span>
                <span className="folder-count">{c.count}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {catalog !== null ? (
        <div className="row wrap">
          <span className="small muted">
            Показано: {visible.length} из {filtered.length}
          </span>
          <span style={{ flex: 1 }} />
          {mode === 'folders' && folder !== '' ? (
            <Button
              variant="soft"
              icon="folder"
              onClick={() => {
                setFolder('');
                reset();
              }}
            >
              Все папки
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="pic-grid">
        {visible.map((logo) => {
          const hit = toHits([logo])[0]!;
          return (
            <button
              type="button"
              key={hit.id}
              className="pic-tile"
              onClick={() => onPick(hit)}
              title={`${hit.title} — ${hit.source}`}
            >
              <span className="pic-img">
                {broken.includes(hit.id) ? (
                  <Icon name="warning" />
                ) : (
                  <img
                    src={hit.thumb}
                    alt=""
                    loading="lazy"
                    onError={() => setBroken((l) => (l.includes(hit.id) ? l : [...l, hit.id]))}
                  />
                )}
              </span>
              <span className="pic-title">{hit.title}</span>
              <span className="pic-source">{hit.source}</span>
            </button>
          );
        })}
      </div>

      {visible.length < filtered.length ? (
        <Button variant="soft" icon="plus" onClick={() => setShown((n) => n + 96)}>
          Показать ещё (осталось {filtered.length - visible.length})
        </Button>
      ) : null}

      <div className="small muted">
        Каталог:{' '}
        <a href={TRACE_REPO} target="_blank" rel="noreferrer">
          {TRACE_REPO.replace('https://', '')}
        </a>
      </div>
    </Modal>
  );
}

/** То же самое, но окном — так подбирают картинку прямо из карточки справочника */
export function PicturePicker({
  name,
  kind,
  current = '',
  title = 'Подобрать логотип или значок',
  onClose,
  onPick,
}: {
  name: string;
  kind: PictureKind;
  /** Нынешняя картинка записи */
  current?: string;
  title?: string;
  onClose: () => void;
  /** Картинка выбрана: найденная или своя из файла (тогда hit — null) */
  onPick: (value: string, hit: PictureHit | null) => void;
}) {
  return (
    <Modal open title={title} onClose={onClose}>
      <PictureSearch
        initialName={name}
        initialKind={kind}
        showKind={false}
        current={current}
        onPick={(value, hit) => {
          onPick(value, hit);
          onClose();
        }}
      />
    </Modal>
  );
}

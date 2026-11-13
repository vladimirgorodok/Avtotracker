import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  DateInput,
  Empty,
  Field,
  Icon,
  NumberInput,
  Page,
  Select,
  TextInput,
} from '../ui/components';
import { PlacePicker } from '../ui/PlacePicker';
import { useApp } from '../store';
import { refs } from '../db/repo';
import { addPhoto } from '../lib/documents';
import { fmtNumber } from '../lib/format';
import {
  MAX_FILES,
  applyDraft,
  canReadFiles,
  describeOrderResult,
  extractOrder,
  fileToAttachment,
  linkPlaceTo,
  recheckPlace,
  syncCompanies,
  type AttachedFile,
  type OrderDraft,
  type OrderDraftPoint,
  type OrderPlaceDraft,
  type OrderProgress,
  type OrderStage,
} from '../lib/order';
import type { Id } from '../types';

/** Приложенный файл: то, что ушло помощнику, и сам файл — чтобы приложить его к поездке */
interface Picked {
  att: AttachedFile;
  file: File;
}

/** Шаги разбора — по ним видно, чем сейчас занят помощник */
const ORDER_STEPS: { stage: OrderStage; label: string }[] = [
  { stage: 'files', label: 'Читаю приложенные файлы' },
  { stage: 'sending', label: 'Отправляю помощнику' },
  { stage: 'receiving', label: 'Получаю ответ' },
  { stage: 'parsing', label: 'Разбираю ответ и собираю маршрут' },
  { stage: 'matching', label: 'Сверяю фирмы и места со справочником' },
];

type Progress = OrderProgress | { stage: 'done'; text: string; chars?: number };

function stepIndex(stage: Progress['stage']): number {
  if (stage === 'done') return ORDER_STEPS.length;
  return ORDER_STEPS.findIndex((s) => s.stage === stage);
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

/**
 * Поле со списком из справочника: значения берутся готовыми, но можно выбрать
 * «другое» и вписать своё название — оно попадёт в справочник при создании поездки.
 */
function RefSelect({
  label,
  value,
  options,
  onChange,
  placeholder,
  hint,
  disabled,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  placeholder: string;
  hint?: string;
  disabled?: boolean;
}) {
  const [other, setOther] = useState(false);
  const unknown = value.trim() !== '' && !options.includes(value);
  const showOther = other || unknown;

  return (
    <>
      <Field label={label} hint={hint}>
        <Select
          value={showOther ? '__other__' : value || null}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(v) => {
            if (v === '__other__') {
              setOther(true);
              return;
            }
            setOther(false);
            onChange(v ?? '');
          }}
          options={[
            ...options.map((o) => ({ value: o, label: o })),
            { value: '__other__', label: 'Другое — вписать название' },
          ]}
        />
      </Field>
      {showOther ? (
        <Field label="Своё название" hint="его добавят в справочник">
          <TextInput
            value={value}
            disabled={disabled}
            placeholder="Введите название"
            onChange={(e) => onChange(e.target.value)}
          />
        </Field>
      ) : null}
    </>
  );
}

export default function OrderFromFiles() {
  const navigate = useNavigate();
  const settings = useApp((s) => s.settings);
  const notify = useApp((s) => s.notify);
  const touch = useApp((s) => s.touch);
  const revision = useApp((s) => s.revision);

  const [picked, setPicked] = useState<Picked[]>([]);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [comment, setComment] = useState('');
  const [draft, setDraft] = useState<OrderDraft | null>(null);
  const [rawOpen, setRawOpen] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [pickerKey, setPickerKey] = useState<string | null>(null);
  /** Файлы поменяли после разбора — данные на экране надо обновить */
  const [stale, setStale] = useState(false);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const progressRef = useRef<HTMLDivElement | null>(null);

  const ready = canReadFiles();

  /** Секунды на часах, пока помощник работает */
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [busy]);

  useEffect(() => {
    if (busy) progressRef.current?.scrollIntoView({ block: 'nearest' });
  }, [busy, progress?.stage]);

  const cargoNames = useMemo(() => [...new Set(refs.cargoTypes().map((c) => c.name))], [revision]);
  const companyNames = useMemo(() => [...new Set(refs.companies().map((c) => c.name))], [revision]);
  const placeOptions = useMemo(
    () =>
      refs.places().map((p) => ({
        value: p.id,
        label: p.address ? `${p.name} — ${p.address}` : p.name,
      })),
    [revision],
  );

  const summary = useMemo(() => {
    if (!draft) return null;
    return {
      placesAdded: draft.places.filter((p) => p.action === 'add').length,
      placesLinked: draft.places.filter((p) => p.action === 'link').length,
      fills: draft.places.filter((p) => p.action === 'link' && p.fillEnabled && p.fill.length > 0).length,
      companiesAdded: draft.companies.filter((c) => c.action === 'add').length,
      companiesLinked: draft.companies.filter((c) => c.action === 'link').length,
      skipped: draft.places.filter((p) => p.action === 'skip').length,
    };
  }, [draft]);

  async function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setError('');
    const free = MAX_FILES - picked.length;
    if (free <= 0) {
      setError(`Больше ${MAX_FILES} файлов за раз помощник не разберёт`);
      return;
    }
    const files = Array.from(list).slice(0, free);
    setBusy(true);
    setSeconds(0);
    if (draft) setStale(true);
    const next: Picked[] = [];
    const bad: string[] = [];
    for (let i = 0; i < files.length; i++) {
      setProgress({ stage: 'files', text: `Читаю файл ${i + 1} из ${files.length}: ${files[i].name}` });
      try {
        next.push({ att: await fileToAttachment(files[i]), file: files[i] });
      } catch (e) {
        bad.push(`${files[i].name}: ${e instanceof Error ? e.message : 'не читается'}`);
      }
    }
    setPicked((prev) => [...prev, ...next]);
    setProgress({
      stage: 'done',
      text: next.length > 0 ? `Файлы готовы к разбору: ${next.length}` : 'Ни один файл не прочитался',
    });
    setBusy(false);
    if (bad.length > 0) setError(bad.join('; '));
  }

  function removeFile(index: number) {
    setPicked((prev) => prev.filter((_, i) => i !== index));
    if (draft) setStale(true);
  }

  async function parse() {
    if (busy || picked.length === 0) return;
    setBusy(true);
    setError('');
    setComment('');
    setSeconds(0);
    setProgress({ stage: 'sending', text: 'Готовлю файлы к отправке' });
    try {
      const { draft: built, raw } = await extractOrder(picked.map((p) => p.att), (p) => setProgress(p));
      setDraft(built);
      setStale(false);
      setComment(raw.trim());
      setProgress({
        stage: 'done',
        text: `Готово: точек ${built.points.length}, фирм ${built.companies.length}, мест ${built.places.length}`,
      });
      notify('Заявка разобрана — проверьте данные', 'ok');
    } catch (e) {
      const text = e instanceof Error ? e.message : 'Не удалось разобрать файлы';
      setError(text);
      setProgress({ stage: 'done', text: `Не получилось: ${text}` });
    } finally {
      setBusy(false);
    }
  }

  function patch(next: Partial<OrderDraft>) {
    setDraft((d) => (d ? { ...d, ...next } : d));
  }

  function patchPlace(key: string, next: Partial<OrderPlaceDraft>) {
    setDraft((d) => (d ? { ...d, places: d.places.map((p) => (p.key === key ? { ...p, ...next } : p)) } : d));
  }

  function patchPoint(index: number, next: Partial<OrderDraftPoint>) {
    setDraft((d) =>
      d ? { ...d, points: d.points.map((p, i) => (i === index ? { ...p, ...next } : p)) } : d,
    );
  }

  /** Пересчитать, на что похоже место, после ручной правки */
  function recheck(key: string) {
    setDraft((d) =>
      d ? { ...d, places: d.places.map((x) => (x.key === key ? recheckPlace(x) : x)) } : d,
    );
  }

  /** Фирма у точки — это фирма её места; после смены обновляем список фирм */
  function setPlaceCompany(key: string, company: string) {
    if (!key) return;
    setDraft((d) =>
      d ? syncCompanies({ ...d, places: d.places.map((p) => (p.key === key ? { ...p, company } : p)) }) : d,
    );
  }

  /** Привязать место заявки к выбранному вручную месту из справочника */
  function linkTo(key: string, placeId: Id | null) {
    setDraft((d) => {
      if (!d) return d;
      const places = d.places.map((p) => {
        if (p.key !== key) return p;
        if (!placeId) {
          return { ...p, action: 'add' as const, linkId: null, linkName: '', score: 0, reasons: [], fill: [] };
        }
        const found = refs.place(placeId);
        return found ? linkPlaceTo(p, found) : p;
      });
      return syncCompanies({ ...d, places });
    });
  }

  async function create() {
    if (!draft || creating) return;
    setCreating(true);
    try {
      const res = applyDraft(draft, settings);
      for (const item of picked) {
        if (item.att.kind !== 'image') continue;
        try {
          await addPhoto('trips', res.tripId, item.file, `Заявка: ${item.att.name}`);
        } catch {
          /* фото заявки не главное — поездка уже создана */
        }
      }
      touch();
      notify(describeOrderResult(res), 'ok');
      navigate(`/trips/${res.tripId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось создать поездку');
    } finally {
      setCreating(false);
    }
  }

  const stage = progress ? stepIndex(progress.stage) : 0;
  const percent =
    progress === null
      ? 0
      : progress.stage === 'done'
        ? 100
        : Math.round(((stage + (busy ? 0.5 : 0)) / (ORDER_STEPS.length + 1)) * 100 + 10);

  return (
    <Page title="Заявка из файла" onBack={() => navigate('/assistant')}>
      <Card
        title="Файлы заявки"
        actions={<Badge tone={ready ? 'ok' : 'warn'}>{picked.length > 0 ? `файлов: ${picked.length}` : 'пусто'}</Badge>}
      >
        {progress ? (
          <div className="progress-box" ref={progressRef}>
            <div className="progress-head">
              <span className={busy ? 'spin' : ''}>
                <Icon name={busy ? 'refresh' : progress.stage === 'done' ? 'check' : 'ai'} size={16} />
              </span>
              <span className="small">{progress.text}</span>
              <span style={{ flex: 1 }} />
              <span className="small muted">
                {busy ? `${seconds} с` : ''}
                {progress.chars ? `${busy ? ' · ' : ''}${fmtNumber(progress.chars)} знаков` : ''}
              </span>
            </div>
            <div className="progress">
              <i style={{ width: `${Math.min(100, percent)}%` }} />
            </div>
            <div className="progress-steps">
              {ORDER_STEPS.map((s, i) => (
                <div
                  key={s.stage}
                  className={`progress-step ${i < stage ? 'done' : ''} ${i === stage && busy ? 'active' : ''}`}
                >
                  <span className="progress-dot">
                    {i < stage || (!busy && progress.stage === 'done') ? (
                      <Icon name="check" size={11} />
                    ) : i === stage && busy ? (
                      <span className="spin">
                        <Icon name="refresh" size={11} />
                      </span>
                    ) : null}
                  </span>
                  <span className="small">{s.label}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="small muted">
          Приложите фото заявки или файл с текстом (несколько сразу). Помощник прочитает даты, груз и точки
          маршрута, сверит фирмы и места со справочником и предложит, что добавить, а что дополнить.
        </div>

        {!ready ? (
          <div className="alert alert-warn">
            <Icon name="warning" />
            <span>
              Нужны адрес API, ключ и модель в настройках ИИ. Для фотографий подойдёт модель, которая умеет
              смотреть картинки.
            </span>
          </div>
        ) : null}

        {error ? (
          <div className="alert alert-err">
            <Icon name="warning" />
            <span>{error}</span>
          </div>
        ) : null}

        {stale ? (
          <div className="alert alert-warn">
            <Icon name="warning" />
            <span>Файлы изменились — нажмите «Разобрать заявку», чтобы обновить данные на экране.</span>
          </div>
        ) : null}

        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: 'none' }}
          onChange={(e) => {
            void addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/*,.txt,.csv,.json,.md,.tsv,.xlsx,.xls,.ods"
          style={{ display: 'none' }}
          onChange={(e) => {
            void addFiles(e.target.files);
            e.target.value = '';
          }}
        />

        <div className="row wrap">
          <Button icon="eye" disabled={busy} onClick={() => cameraRef.current?.click()}>
            Сфотографировать
          </Button>
          <Button icon="upload" disabled={busy} onClick={() => fileRef.current?.click()}>
            Выбрать файлы
          </Button>
        </div>

        {picked.length === 0 ? (
          <Empty text="Пока ничего не приложено. Фото, скан, текст, CSV или Excel — всё подойдёт." />
        ) : (
          <div className="list">
            {picked.map((p, i) => (
              <div key={`${p.att.name}-${i}`} className="list-item" style={{ cursor: 'default' }}>
                <span className="avatar">
                  <Icon name={p.att.kind === 'image' ? 'eye' : 'doc'} />
                </span>
                <span className="li-main">
                  <span className="li-title">{p.att.name}</span>
                  <span className="li-sub">
                    {p.att.kind === 'image' ? 'фото' : 'текст'} · {sizeLabel(p.att.size)}
                  </span>
                </span>
                <Button icon="trash" disabled={busy} onClick={() => removeFile(i)} />
              </div>
            ))}
          </div>
        )}

        <Button
          variant="primary"
          icon="ai"
          block
          disabled={busy || !ready || picked.length === 0}
          onClick={() => void parse()}
        >
          {busy ? `Работаю… ${seconds} с` : 'Разобрать заявку'}
        </Button>
      </Card>

      {draft ? (
        <>
          <Card
            title="Что получилось"
            actions={
              <Badge tone="info">
                <Icon name="route" size={14} /> точек {draft.points.length}
              </Badge>
            }
          >
            {draft.comment ? (
              <div className="alert alert-info">
                <Icon name="ai" />
                <span>{draft.comment}</span>
              </div>
            ) : null}

            {draft.missing.length > 0 ? (
              <div className="alert alert-warn">
                <Icon name="warning" />
                <span>В заявке нет: {draft.missing.join(', ')}. Заполните это в карточке поездки.</span>
              </div>
            ) : null}

            <Field label="Название поездки">
              <TextInput value={draft.title} onChange={(e) => patch({ title: e.target.value })} />
            </Field>
            <div className="grid-2">
              <RefSelect
                label="Груз"
                value={draft.cargo}
                options={cargoNames}
                onChange={(v) => patch({ cargo: v })}
                placeholder="Не указан"
                hint="список из справочника грузов"
              />
              <Field label="Вес, кг">
                <NumberInput value={draft.weight} onValue={(v) => patch({ weight: v })} />
              </Field>
            </div>
            <div className="grid-2">
              <Field label="Начисление">
                <NumberInput value={draft.amount} onValue={(v) => patch({ amount: v })} />
              </Field>
              <Field label="Машина из заявки">
                <TextInput
                  value={draft.vehicle}
                  placeholder="не указана"
                  onChange={(e) => patch({ vehicle: e.target.value })}
                />
              </Field>
            </div>
            <Field label="Примечание">
              <TextInput value={draft.note} onChange={(e) => patch({ note: e.target.value })} />
            </Field>
          </Card>

          <Card title="Точки маршрута">
            <div className="small muted">Проверьте порядок, даты, места и фирмы — можно поправить прямо здесь</div>
            <div className="stack-sm">
              {draft.points.map((p, i) => {
                const place = draft.places.find((pl) => pl.key === p.placeKey);
                return (
                  <div key={`${p.kind}-${i}`} className={`point ${p.kind === 'load' ? 'point-load' : 'point-unload'}`}>
                    <div className="point-head">
                      <span className="point-num">{i + 1}</span>
                      <Badge tone={p.kind === 'load' ? 'info' : 'err'}>
                        {p.kind === 'load' ? 'Погрузка' : 'Выгрузка'}
                      </Badge>
                      <span className="point-kind">
                        {place?.name || 'Место не выбрано'}
                        {place?.company ? ` · ${place.company}` : ''}
                      </span>
                    </div>
                    <div className="grid-2">
                      <Field label="Тип">
                        <Select
                          value={p.kind}
                          onChange={(v) => patchPoint(i, { kind: v ?? 'unload' })}
                          options={[
                            { value: 'load', label: 'Погрузка' },
                            { value: 'unload', label: 'Выгрузка' },
                          ]}
                        />
                      </Field>
                      <Field label="Дата">
                        <DateInput value={p.date || null} onChange={(v) => patchPoint(i, { date: v ?? '' })} />
                      </Field>
                    </div>
                    <Field label="Место">
                      <Select
                        value={p.placeKey || null}
                        onChange={(v) => patchPoint(i, { placeKey: v ?? '' })}
                        placeholder="Не указано"
                        options={draft.places.map((pl) => ({
                          value: pl.key,
                          label: pl.name || pl.address || 'Место из заявки',
                        }))}
                      />
                    </Field>
                    <RefSelect
                      label="Фирма"
                      value={place?.company ?? ''}
                      options={companyNames}
                      disabled={!place}
                      placeholder={place ? 'Не указана' : 'сначала выберите место'}
                      hint={place ? 'список из справочника фирм' : undefined}
                      onChange={(v) => setPlaceCompany(p.placeKey, v)}
                    />
                    <Field label="Примечание к точке">
                      <TextInput value={p.note} onChange={(e) => patchPoint(i, { note: e.target.value })} />
                    </Field>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card title="Места в справочнике" actions={<Badge tone="info">{draft.places.length}</Badge>}>
            <div className="small muted">
              Похожие места уже есть в справочнике — их можно использовать и дополнить, а новые добавить.
            </div>
            <div className="stack-sm">
              {draft.places.map((pl) => (
                <div key={pl.key} className="point">
                  <div className="point-head">
                    <Icon name="pin" size={16} />
                    <span className="point-kind">{pl.name || pl.address || 'Место из заявки'}</span>
                    <Badge tone={pl.action === 'add' ? 'warn' : pl.action === 'link' ? 'ok' : 'neutral'}>
                      {pl.action === 'add' ? 'Новое' : pl.action === 'link' ? 'Есть похожее' : 'Пропущено'}
                    </Badge>
                  </div>

                  {pl.linkId ? (
                    <div className="row wrap">
                      <Icon name="search" size={16} />
                      <span className="small">
                        Похоже на <b>{pl.linkName}</b>
                        {pl.reasons.length > 0 ? ` — ${pl.reasons.join(', ')}` : ''}
                        {pl.score > 0 ? ` (совпадение ${Math.round(pl.score * 100)}%)` : ''}
                      </span>
                    </div>
                  ) : null}

                  <div className="row wrap">
                    <Button
                      variant={pl.action === 'add' ? 'primary' : 'soft'}
                      icon="plus"
                      onClick={() => patchPlace(pl.key, { action: 'add' })}
                    >
                      Добавить
                    </Button>
                    {pl.linkId ? (
                      <Button
                        variant={pl.action === 'link' ? 'primary' : 'soft'}
                        icon="check"
                        onClick={() => patchPlace(pl.key, { action: 'link' })}
                      >
                        Использовать существующее
                      </Button>
                    ) : null}
                    <Button
                      variant={pl.action === 'skip' ? 'primary' : 'soft'}
                      icon="close"
                      onClick={() => patchPlace(pl.key, { action: 'skip' })}
                    >
                      Пропустить
                    </Button>
                  </div>

                  <Field label="Место из справочника" hint="выбор вручную привяжет заявку к нему">
                    <Select
                      value={pl.linkId}
                      placeholder="Не выбрано"
                      onChange={(id) => linkTo(pl.key, id)}
                      options={placeOptions}
                    />
                  </Field>
                  <div className="row wrap">
                    <Button icon="search" onClick={() => setPickerKey(pl.key)}>
                      Найти или создать место
                    </Button>
                  </div>

                  {pl.linkId && pl.fill.length > 0 && pl.action === 'link' ? (
                    <label className="row small">
                      <input
                        type="checkbox"
                        checked={pl.fillEnabled}
                        onChange={(e) => patchPlace(pl.key, { fillEnabled: e.target.checked })}
                      />
                      <span>Дополнить существующее место: {pl.fill.join(', ')}</span>
                    </label>
                  ) : null}

                  <Field label="Название">
                    <TextInput
                      value={pl.name}
                      onChange={(e) => patchPlace(pl.key, { name: e.target.value })}
                      onBlur={() => recheck(pl.key)}
                    />
                  </Field>
                  <Field label="Адрес">
                    <TextInput
                      value={pl.address}
                      onChange={(e) => patchPlace(pl.key, { address: e.target.value })}
                      onBlur={() => recheck(pl.key)}
                    />
                  </Field>
                  <div className="grid-2">
                    <Field label="Контакт">
                      <TextInput
                        value={pl.contact}
                        onChange={(e) => patchPlace(pl.key, { contact: e.target.value })}
                      />
                    </Field>
                    <Field label="Координаты">
                      <TextInput
                        value={pl.coords}
                        placeholder="55.7558, 37.6173"
                        onChange={(e) => patchPlace(pl.key, { coords: e.target.value })}
                        onBlur={() => recheck(pl.key)}
                      />
                    </Field>
                  </div>
                  <RefSelect
                    label="Фирма"
                    value={pl.company}
                    options={companyNames}
                    placeholder="Не указана"
                    hint="список из справочника фирм"
                    onChange={(v) => setPlaceCompany(pl.key, v)}
                  />
                  <div className="small muted">Точек заявки на этом месте: {pl.points.length}</div>
                </div>
              ))}
            </div>
          </Card>

          {draft.companies.length > 0 ? (
            <Card title="Фирмы в справочнике" actions={<Badge tone="info">{draft.companies.length}</Badge>}>
              <div className="small muted">
                Совпадающие названия используем как есть, новые — добавим в справочник.
              </div>
              <div className="stack-sm">
                {draft.companies.map((c) => (
                  <div key={c.key} className="point">
                    <div className="point-head">
                      <Icon name="box" size={16} />
                      <span className="point-kind">{c.name}</span>
                      <Badge tone={c.action === 'add' ? 'warn' : c.action === 'link' ? 'ok' : 'neutral'}>
                        {c.action === 'add' ? 'Новая' : c.action === 'link' ? 'Уже есть' : 'Пропущена'}
                      </Badge>
                    </div>
                    {c.linkId ? (
                      <div className="row wrap">
                        <Icon name="search" size={16} />
                        <span className="small">
                          Похоже на <b>{c.linkName}</b> ({Math.round(c.score * 100)}%)
                        </span>
                      </div>
                    ) : null}
                    <div className="row wrap">
                      <Button
                        variant={c.action === 'add' ? 'primary' : 'soft'}
                        icon="plus"
                        onClick={() =>
                          setDraft((d) =>
                            d
                              ? { ...d, companies: d.companies.map((x) => (x.key === c.key ? { ...x, action: 'add' } : x)) }
                              : d,
                          )
                        }
                      >
                        Добавить
                      </Button>
                      {c.linkId ? (
                        <Button
                          variant={c.action === 'link' ? 'primary' : 'soft'}
                          icon="check"
                          onClick={() =>
                            setDraft((d) =>
                              d
                                ? { ...d, companies: d.companies.map((x) => (x.key === c.key ? { ...x, action: 'link' } : x)) }
                                : d,
                            )
                          }
                        >
                          Использовать «{c.linkName}»
                        </Button>
                      ) : null}
                      <Button
                        variant={c.action === 'skip' ? 'primary' : 'soft'}
                        icon="close"
                        onClick={() =>
                          setDraft((d) =>
                            d
                              ? { ...d, companies: d.companies.map((x) => (x.key === c.key ? { ...x, action: 'skip' } : x)) }
                              : d,
                          )
                        }
                      >
                        Не добавлять
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          <Card title="Создать поездку">
            {summary ? (
              <div className="small muted">
                Новых мест: {summary.placesAdded} · используем существующих: {summary.placesLinked}
                {summary.fills > 0 ? ` (дополним ${summary.fills})` : ''} · новых фирм: {summary.companiesAdded}
                {summary.companiesLinked > 0 ? `, уже есть: ${summary.companiesLinked}` : ''}
                {summary.skipped > 0 ? ` · пропущено мест: ${summary.skipped}` : ''}
              </div>
            ) : null}
            <Button variant="primary" icon="check" block disabled={creating} onClick={() => void create()}>
              {creating ? 'Создаю…' : 'Создать поездку'}
            </Button>
            <div className="small muted">
              Поездка появится в списке со статусом «В плане». Недостающие данные — вес, контакты, даты —
              заполните в её карточке. Фотографии заявки приложатся к поездке.
            </div>
            <div className="row">
              <Button icon="doc" onClick={() => setRawOpen((v) => !v)}>
                {rawOpen ? 'Скрыть ответ помощника' : 'Показать ответ помощника'}
              </Button>
              <span style={{ flex: 1 }} />
              <Button
                icon="undo"
                onClick={() => {
                  setDraft(null);
                  setProgress(null);
                  setStale(false);
                }}
              >
                Сбросить разбор
              </Button>
            </div>
            {rawOpen ? <pre className="raw-answer">{comment}</pre> : null}
          </Card>

          <PlacePicker
            open={pickerKey !== null}
            onClose={() => setPickerKey(null)}
            onPick={(place) => {
              if (pickerKey) linkTo(pickerKey, place.id);
              setPickerKey(null);
            }}
          />
        </>
      ) : null}
    </Page>
  );
}

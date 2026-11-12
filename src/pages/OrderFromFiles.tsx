import { useMemo, useRef, useState } from 'react';
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
import { useApp } from '../store';
import { addPhoto } from '../lib/documents';
import {
  MAX_FILES,
  applyDraft,
  buildDraft,
  canReadFiles,
  describeOrderResult,
  extractOrder,
  fileToAttachment,
  recheckPlace,
  type AttachedFile,
  type OrderDraft,
  type OrderDraftPoint,
  type OrderPlaceDraft,
} from '../lib/order';

/** Приложенный файл: то, что ушло помощнику, и сам файл — чтобы приложить его к поездке */
interface Picked {
  att: AttachedFile;
  file: File;
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

export default function OrderFromFiles() {
  const navigate = useNavigate();
  const settings = useApp((s) => s.settings);
  const notify = useApp((s) => s.notify);
  const touch = useApp((s) => s.touch);

  const [picked, setPicked] = useState<Picked[]>([]);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [comment, setComment] = useState('');
  const [draft, setDraft] = useState<OrderDraft | null>(null);
  const [rawOpen, setRawOpen] = useState(false);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const cameraRef = useRef<HTMLInputElement | null>(null);

  const ready = canReadFiles();

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
    setBusy(true);
    const next: Picked[] = [];
    const bad: string[] = [];
    for (const file of Array.from(list).slice(0, free)) {
      try {
        next.push({ att: await fileToAttachment(file), file });
      } catch (e) {
        bad.push(`${file.name}: ${e instanceof Error ? e.message : 'не читается'}`);
      }
    }
    setPicked((prev) => [...prev, ...next]);
    setBusy(false);
    if (bad.length > 0) setError(bad.join('; '));
    if (next.length > 0) setDraft(null);
  }

  function removeFile(index: number) {
    setPicked((prev) => prev.filter((_, i) => i !== index));
    setDraft(null);
  }

  async function parse() {
    if (busy || picked.length === 0) return;
    setBusy(true);
    setError('');
    setComment('');
    try {
      const { order, raw } = await extractOrder(picked.map((p) => p.att));
      const built = buildDraft(order);
      setDraft(built);
      setComment(raw.trim());
      notify('Заявка разобрана — проверьте данные', 'ok');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось разобрать файлы');
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

  return (
    <Page title="Заявка из файла" onBack={() => navigate('/assistant')}>
      <Card
        title="Файлы заявки"
        actions={<Badge tone={ready ? 'ok' : 'warn'}>{picked.length > 0 ? `файлов: ${picked.length}` : 'пусто'}</Badge>}
      >
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
          <Button icon="eye" onClick={() => cameraRef.current?.click()}>
            Сфотографировать
          </Button>
          <Button icon="upload" onClick={() => fileRef.current?.click()}>
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
                <Button icon="trash" onClick={() => removeFile(i)} />
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
          {busy ? 'Читаю файлы…' : 'Разобрать заявку'}
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
              <Field label="Груз">
                <TextInput
                  value={draft.cargo}
                  placeholder="не указан"
                  onChange={(e) => patch({ cargo: e.target.value })}
                />
              </Field>
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
            <div className="small muted">Проверьте порядок, даты и места — можно поправить прямо здесь</div>
            <div className="stack-sm">
              {draft.points.map((p, i) => (
                <div key={`${p.kind}-${i}`} className={`point ${p.kind === 'load' ? 'point-load' : 'point-unload'}`}>
                  <div className="point-head">
                    <span className="point-num">{i + 1}</span>
                    <Badge tone={p.kind === 'load' ? 'info' : 'err'}>
                      {p.kind === 'load' ? 'Погрузка' : 'Выгрузка'}
                    </Badge>
                    <span className="point-kind">
                      {draft.places.find((pl) => pl.key === p.placeKey)?.name || 'Место не выбрано'}
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
                  <Field label="Примечание к точке">
                    <TextInput value={p.note} onChange={(e) => patchPoint(i, { note: e.target.value })} />
                  </Field>
                </div>
              ))}
            </div>
          </Card>

          <Card
            title="Места в справочнике"
            actions={<Badge tone="info">{draft.places.length}</Badge>}
          >
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
                  <Field label="Фирма">
                    <TextInput
                      value={pl.company}
                      placeholder="не указана"
                      onChange={(e) => patchPlace(pl.key, { company: e.target.value })}
                    />
                  </Field>
                  <div className="small muted">
                    Точек заявки на этом месте: {pl.points.length}
                  </div>
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
              <Button icon="undo" onClick={() => setDraft(null)}>
                Сбросить разбор
              </Button>
            </div>
            {rawOpen ? <pre className="raw-answer">{comment}</pre> : null}
          </Card>
        </>
      ) : null}
    </Page>
  );
}

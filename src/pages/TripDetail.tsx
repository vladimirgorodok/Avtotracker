import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  Confirm,
  DateInput,
  Empty,
  Field,
  Icon,
  KV,
  Modal,
  NumberInput,
  Page,
  Select,
} from '../ui/components';
import { PlacePicker } from '../ui/PlacePicker';
import { useApp } from '../store';
import { insertRow, refs, softDelete, tripRepo, uid, updateRow, waybillRepo } from '../db/repo';
import { autoTripAmount, summarizeTrip } from '../lib/calc';
import { chargeTrip, deleteTrip, renumberPoints, refreshTripStatus, unchargeTrip } from '../lib/actions';
import { fmtDate, fmtMoney, mapLink, addDays, todayIso } from '../lib/format';
import { LOAD_TYPES, loadTypeLabel, type Id, type Place, type Trip, type TripPoint, type TripPointKind } from '../types';

export default function TripDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const revision = useApp((s) => s.revision);
  const settings = useApp((s) => s.settings);
  const touch = useApp((s) => s.touch);
  const notify = useApp((s) => s.notify);

  const [tripId, setTripId] = useState(id);
  const [form, setForm] = useState<Trip | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editPoint, setEditPoint] = useState<TripPoint | null>(null);
  const [pointDraft, setPointDraft] = useState<TripPoint | null>(null);
  const [pointCompany, setPointCompany] = useState<Id | null>(null);
  const [pickerFor, setPickerFor] = useState<'draft' | null>(null);

  useEffect(() => {
    if (id === 'new') {
      const openWaybill = waybillRepo.open()[0] ?? waybillRepo.list()[0] ?? null;
      const newId = uid();
      insertRow('trips', {
        id: newId,
        waybill_id: openWaybill?.id ?? '',
        cargo_type_id: null,
        weight: null,
        amount: settings.base_amount,
        note: '',
        status: 'planned',
      });
      touch();
      setTripId(newId);
      navigate(`/trips/${newId}`, { replace: true });
    } else {
      setTripId(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const row = useMemo(() => tripRepo.get(tripId), [tripId, revision]);
  useEffect(() => {
    if (row) setForm({ ...row });
  }, [row?.id, revision]); // eslint-disable-line react-hooks/exhaustive-deps

  const summary = useMemo(() => (row ? summarizeTrip(row) : null), [row, revision]);
  const points = summary?.points ?? [];

  if (!form || !summary) {
    return (
      <Page title="Поездка" onBack={() => navigate(-1)}>
        <Empty text="Поездка не найдена" />
      </Page>
    );
  }

  const waybills = waybillRepo.list();
  const cargoTypes = refs.cargoTypes();

  function set<K extends keyof Trip>(key: K, value: Trip[K]) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }

  function save() {
    if (!form) return;
    updateRow('trips', form.id, {
      waybill_id: form.waybill_id,
      cargo_type_id: form.cargo_type_id,
      weight: form.weight,
      amount: form.amount,
      note: form.note,
    });
    touch();
    notify('Поездка сохранена', 'ok');
  }

  function newPoint(kind: TripPointKind) {
    // Дата выгрузки по умолчанию — на день позже предыдущей точки (обычно погрузки).
    const last = points[points.length - 1];
    const base = last?.fact_date ?? last?.plan_date ?? todayIso();
    const draft: TripPoint = {
      id: uid(),
      trip_id: form!.id,
      seq: points.length + 1,
      kind,
      place_id: null,
      plan_date: kind === 'unload' && points.length > 0 ? addDays(base, 1) : todayIso(),
      fact_date: null,
      load_type: null,
      cargo_type_id: form!.cargo_type_id,
      weight: null,
      status: 'planned',
      note: '',
      created_at: '',
      updated_at: '',
      deleted: 0,
    };
    setPointDraft(draft);
    setEditPoint(null);
    setPointCompany(null);
  }

  function openPoint(p: TripPoint) {
    setPointDraft({ ...p });
    setEditPoint(p);
    setPointCompany(refs.place(p.place_id)?.company_id ?? null);
  }

  /** Отметить точку выполненной сегодняшним днём. */
  function markPointDone(p: TripPoint) {
    updateRow('trip_points', p.id, { fact_date: todayIso(), status: 'done' });
    refreshTripStatus(form!.id);
    touch();
    const after = tripRepo.get(form!.id);
    if (after && after.status !== 'planned') notify('Все точки выполнены — сохраните начисление', 'ok');
    else notify('Точка выполнена', 'ok');
  }

  function savePoint() {
    if (!pointDraft) return;
    const d = pointDraft;
    const payload = {
      trip_id: form!.id,
      seq: d.seq,
      kind: d.kind,
      place_id: d.place_id,
      plan_date: d.plan_date,
      fact_date: d.fact_date,
      load_type: d.load_type,
      cargo_type_id: d.cargo_type_id,
      weight: d.weight,
      status: d.status,
      note: d.note,
    };
    if (editPoint) updateRow('trip_points', d.id, payload);
    else insertRow('trip_points', { id: d.id, ...payload });
    renumberPoints(form!.id);
    refreshTripStatus(form!.id);
    touch();
    setPointDraft(null);
    setEditPoint(null);
  }

  function removePoint(p: TripPoint) {
    softDelete('trip_points', p.id);
    renumberPoints(form!.id);
    refreshTripStatus(form!.id);
    touch();
    setPointDraft(null);
    setEditPoint(null);
  }

  function movePoint(p: TripPoint, dir: -1 | 1) {
    const list = [...points];
    const idx = list.findIndex((x) => x.id === p.id);
    const target = idx + dir;
    if (target < 0 || target >= list.length) return;
    const a = list[idx];
    const b = list[target];
    updateRow('trip_points', a.id, { seq: b.seq });
    updateRow('trip_points', b.id, { seq: a.seq });
    renumberPoints(form!.id);
    touch();
  }

  function applyPlace(place: Place) {
    setPointCompany(place.company_id ?? null);
    setPointDraft((d) =>
      d
        ? {
            ...d,
            place_id: place.id,
            load_type: place.load_type ?? d.load_type,
            cargo_type_id: place.cargo_type_id ?? d.cargo_type_id,
          }
        : d,
    );
  }

  const autoAmount = autoTripAmount(settings, points.length);
  const companies = refs.companies();
  const allPlaces = refs.places();
  // Места показываем только по выбранной фирме — так их проще выбрать.
  const placesForCompany = pointCompany
    ? allPlaces.filter((p) => p.company_id === pointCompany)
    : allPlaces;

  return (
    <Page
      title="Изменить поездку"
      onBack={() => navigate(-1)}
      actions={
        <>
          <Button variant="danger" icon="trash" onClick={() => setConfirmDelete(true)} />
          <Button variant="ghost" icon="close" onClick={() => navigate('/trips')} />
        </>
      }
    >
      <Card title="Основное">
        <Field label="Путевой лист" required>
          <Select
            value={form.waybill_id || null}
            onChange={(v) => set('waybill_id', v ?? '')}
            options={waybills.map((w) => ({
              value: w.id,
              label: `${fmtDate(w.date_out)} — ${w.date_in ? fmtDate(w.date_in) : 'открыт'}`,
            }))}
            placeholder="Не выбран"
          />
        </Field>
        <Field label="Поездка">
          <div className="input" style={{ display: 'flex', alignItems: 'center' }}>
            {summary.title}
          </div>
        </Field>
        <Field label="Груз">
          <div className="row">
            <Select
              value={form.cargo_type_id}
              onChange={(v) => set('cargo_type_id', v)}
              options={cargoTypes.map((c) => ({ value: c.id, label: c.name }))}
              placeholder="Не выбран"
              className=""
            />
            <Button icon="plus" onClick={() => navigate('/refs?tab=cargo&new=1')} />
          </div>
        </Field>
        <Field label="Вес, кг">
          <NumberInput value={form.weight} onValue={(v) => set('weight', v)} />
        </Field>
        <Field label="Начисление" required hint={`Автоматически по точкам: ${fmtMoney(autoAmount, settings.currency)}`}>
          <NumberInput value={form.amount} onValue={(v) => set('amount', v)} />
        </Field>
        <Field label="Примечания">
          <textarea
            className="input"
            rows={3}
            value={form.note}
            onChange={(e) => set('note', e.target.value)}
          />
        </Field>
      </Card>

      <Button variant="primary" block icon="check" onClick={save}>
        Сохранить
      </Button>

      {form.status === 'charged' ? (
        <Button
          variant="ghost"
          block
          icon="refresh"
          onClick={() => {
            unchargeTrip(form!.id);
            touch();
            notify('Начисление снято', 'info');
          }}
        >
          Снять начисление
        </Button>
      ) : (
        <Button
          variant="success"
          block
          icon="money"
          onClick={() => {
            updateRow('trips', form!.id, {
              amount: form!.amount,
              cargo_type_id: form!.cargo_type_id,
              weight: form!.weight,
              note: form!.note,
            });
            chargeTrip(form!.id, settings, form!.amount ?? autoAmount);
            touch();
            notify(`Начислено ${fmtMoney(form!.amount ?? autoAmount, settings.currency)}`, 'ok');
          }}
        >
          Начислить
        </Button>
      )}

      <Card
        title={
          <>
            Маршрут поездки <Badge tone="info">{points.length} точек</Badge>
          </>
        }
        actions={
          <>
            <Button icon="plus" onClick={() => newPoint(points.length === 0 ? 'load' : 'unload')}>
              Добавить
            </Button>
          </>
        }
      >
        <div className="small muted">Все сведения по точкам без дополнительного открытия</div>
        {points.length === 0 ? (
          <Empty text="Точек маршрута нет" />
        ) : (
          <div className="stack-sm">
            {points.map((p, idx) => {
              const place = refs.place(p.place_id);
              const company = refs.company(place?.company_id ?? null);
              return (
                <div key={p.id} className={`point ${p.kind === 'load' ? 'point-load' : 'point-unload'}`}>
                  <div className="point-head">
                    <span className="point-num">{idx + 1}</span>
                    <Badge tone={p.kind === 'load' ? 'info' : 'err'}>
                      {p.kind === 'load' ? 'Погрузка' : 'Выгрузка'}
                    </Badge>
                    <span className="point-kind">{place?.name ?? 'Место не выбрано'}</span>
                    <Badge tone={p.status === 'done' ? 'ok' : 'warn'}>
                      {p.status === 'done' ? 'Выполнено' : 'В плане'}
                    </Badge>
                  </div>

                  {company ? (
                    <div className="row">
                      <span className="avatar" style={{ width: 32, height: 32 }}>
                        {company.logo ? <img src={company.logo} alt="" /> : <Icon name="box" size={16} />}
                      </span>
                      <span className="small muted">Фирма</span>
                      <b className="small">{company.name}</b>
                    </div>
                  ) : null}

                  <div className="grid-2">
                    <KV label="Плановая дата" value={fmtDate(p.plan_date)} />
                    <KV label="Фактическая дата" value={fmtDate(p.fact_date)} />
                  </div>
                  {place?.address ? (
                    <div className="row">
                      <Icon name="pin" size={16} />
                      <span className="small">{place.address}</span>
                    </div>
                  ) : null}
                  <div className="row wrap">
                    {p.load_type ? <Badge tone="warn">{loadTypeLabel(p.load_type)}</Badge> : null}
                    {place && (place.lat !== null || place.address) ? (
                      <a
                        className="badge badge-info"
                        href={mapLink(place.lat, place.lon, place.address, place.name)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Icon name="nav" size={14} />
                        {place.lat !== null ? `${place.lat.toFixed(4)}, ${place.lon?.toFixed(4)}` : 'Маршрут'}
                      </a>
                    ) : null}
                    {place?.contact ? (
                      <a className="badge badge-ok" href={`tel:${place.contact}`}>
                        <Icon name="phone" size={14} />
                        {place.contact}
                      </a>
                    ) : null}
                  </div>

                  <div className="divider" />
                  <div className="row wrap">
                    <Button icon="up" onClick={() => movePoint(p, -1)} />
                    <Button icon="down" onClick={() => movePoint(p, 1)} />
                    {p.status !== 'done' ? (
                      <Button variant="success" icon="check" onClick={() => markPointDone(p)}>
                        Выполнен
                      </Button>
                    ) : null}
                    <span style={{ flex: 1 }} />
                    <Button icon="edit" onClick={() => openPoint(p)}>
                      Изменить
                    </Button>
                    <Button variant="danger" icon="trash" onClick={() => removePoint(p)} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Modal
        open={pointDraft !== null}
        title={editPoint ? 'Изменить точку' : 'Новая точка'}
        onClose={() => {
          setPointDraft(null);
          setEditPoint(null);
        }}
        footer={
          <>
            {editPoint ? (
              <Button variant="danger" icon="trash" onClick={() => removePoint(pointDraft!)}>
                Удалить
              </Button>
            ) : null}
            <span style={{ flex: 1 }} />
            <Button
              onClick={() => {
                setPointDraft(null);
                setEditPoint(null);
              }}
            >
              Отмена
            </Button>
            <Button variant="primary" icon="check" onClick={savePoint}>
              Сохранить
            </Button>
          </>
        }
      >
        {pointDraft ? (
          <>
            <Field label="Тип точки" required>
              <Select
                value={pointDraft.kind}
                onChange={(v) => setPointDraft({ ...pointDraft, kind: (v ?? 'load') as TripPointKind })}
                options={[
                  { value: 'load', label: 'Погрузка' },
                  { value: 'unload', label: 'Выгрузка' },
                ]}
                placeholder="Погрузка"
              />
            </Field>
            <Field label="Фирма" hint="Сначала фирма — список мест отфильтруется по её привязке">
              <Select
                value={pointCompany}
                onChange={(v) => {
                  setPointCompany(v);
                  const current = refs.place(pointDraft.place_id);
                  if (current && current.company_id !== v) setPointDraft({ ...pointDraft, place_id: null });
                }}
                options={companies.map((c) => ({ value: c.id, label: c.name }))}
                placeholder="Все фирмы"
              />
            </Field>
            <Field label="Место" required>
              <div className="row">
                <Select
                  className=""
                  value={pointDraft.place_id}
                  onChange={(v) => {
                    const place = refs.place(v);
                    setPointDraft({
                      ...pointDraft,
                      place_id: v,
                      load_type: place?.load_type ?? pointDraft.load_type,
                      cargo_type_id: place?.cargo_type_id ?? pointDraft.cargo_type_id,
                    });
                  }}
                  options={placesForCompany.map((p) => ({
                    value: p.id,
                    label: p.address ? `${p.name} · ${p.address}` : p.name,
                  }))}
                  placeholder="Не выбрано"
                />
                <Button icon="plus" onClick={() => setPickerFor('draft')}>
                  Новое
                </Button>
              </div>
            </Field>
            <Field label="Плановая дата">
              <DateInput
                value={pointDraft.plan_date}
                onChange={(v) => setPointDraft({ ...pointDraft, plan_date: v })}
              />
            </Field>
            <Field label="Фактическая дата" hint="Если указана — точка считается выполненной">
              <DateInput
                value={pointDraft.fact_date}
                onChange={(v) =>
                  setPointDraft({
                    ...pointDraft,
                    fact_date: v,
                    status: v ? 'done' : 'planned',
                  })
                }
              />
            </Field>
            <Field label="Статус">
              <Select
                value={pointDraft.status}
                onChange={(v) => setPointDraft({ ...pointDraft, status: (v ?? 'planned') as 'planned' | 'done' })}
                options={[
                  { value: 'planned', label: 'В плане' },
                  { value: 'done', label: 'Выполнено' },
                ]}
                placeholder="В плане"
              />
            </Field>
            <Field label="Тип загрузки">
              <Select
                value={pointDraft.load_type}
                onChange={(v) => setPointDraft({ ...pointDraft, load_type: v })}
                options={LOAD_TYPES}
                placeholder="Не выбран"
              />
            </Field>
            <Field label="Груз">
              <Select
                value={pointDraft.cargo_type_id}
                onChange={(v) => setPointDraft({ ...pointDraft, cargo_type_id: v })}
                options={cargoTypes.map((c) => ({ value: c.id, label: c.name }))}
                placeholder="Не выбран"
              />
            </Field>
            <Field label="Примечания">
              <textarea
                className="input"
                rows={2}
                value={pointDraft.note}
                onChange={(e) => setPointDraft({ ...pointDraft, note: e.target.value })}
              />
            </Field>
          </>
        ) : null}
      </Modal>

      <PlacePicker
        open={pickerFor === 'draft'}
        onClose={() => setPickerFor(null)}
        onPick={(p) => {
          applyPlace(p);
          setPickerFor(null);
        }}
      />

      <Confirm
        open={confirmDelete}
        title="Удалить поездку"
        text="Поездка, её точки и начисления будут удалены."
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          deleteTrip(form.id);
          touch();
          setConfirmDelete(false);
          navigate('/trips');
        }}
      />
    </Page>
  );
}

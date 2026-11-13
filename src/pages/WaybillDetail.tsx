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
  NumberInput,
  Page,
  Select,
  TextInput,
} from '../ui/components';
import { useApp } from '../store';
import { insertRow, refs, refuelRepo, softDelete, tripRepo, uid, updateRow, waybillRepo } from '../db/repo';
import { autoFillForNewWaybill, summarizeWaybill } from '../lib/calc';
import { closeWaybill, reopenWaybill, vehicleTitle } from '../lib/actions';
import { fmtDate, fmtDateTime, fmtMoney, fmtNumber, todayIso } from '../lib/format';
import { refuelKindLabel } from '../types';
import { TripCard } from './Home';
import { DocumentsCard } from '../ui/Documents';
import type { Waybill } from '../types';

export default function WaybillDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const revision = useApp((s) => s.revision);
  const settings = useApp((s) => s.settings);
  const touch = useApp((s) => s.touch);
  const notify = useApp((s) => s.notify);

  const [waybillId, setWaybillId] = useState(id);
  const [form, setForm] = useState<Waybill | null>(null);
  const [showExtra, setShowExtra] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // создание нового листа по маршруту /waybills/new
  useEffect(() => {
    if (id === 'new') {
      const pre = autoFillForNewWaybill(settings.last_vehicle_id || null);
      const today = todayIso();
      const newId = uid();
      insertRow('waybills', {
        id: newId,
        number: '',
        name: `${today} — открыт`,
        date_out: today,
        odometer_out: pre.odometer_out,
        fuel_out: pre.fuel_out,
        vehicle_id: pre.vehicle_id,
        trailer_id: pre.trailer_id,
        status: 'open',
      });
      touch();
      setWaybillId(newId);
      navigate(`/waybills/${newId}`, { replace: true });
    } else {
      setWaybillId(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const row = useMemo(() => waybillRepo.get(waybillId), [waybillId, revision]);

  useEffect(() => {
    if (row) setForm({ ...row });
  }, [row?.id, revision]); // eslint-disable-line react-hooks/exhaustive-deps

  const summary = useMemo(() => (row ? summarizeWaybill(row) : null), [row, revision]);

  if (!form || !summary) {
    return (
      <Page title="Путевой лист" onBack={() => navigate(-1)}>
        <Empty text="Путевой лист не найден" />
      </Page>
    );
  }

  const vehicles = refs.vehicles('tractor');
  const trailers = refs.vehicles('trailer');

  function set<K extends keyof Waybill>(key: K, value: Waybill[K]) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }

  function save() {
    if (!form) return;
    updateRow('waybills', form.id, {
      number: form.number,
      name: form.name,
      date_out: form.date_out,
      odometer_out: form.odometer_out,
      fuel_out: form.fuel_out,
      date_in: form.date_in,
      odometer_in: form.odometer_in,
      fuel_in: form.fuel_in,
      vehicle_id: form.vehicle_id,
      trailer_id: form.trailer_id,
      note: form.note,
    });
    if (form.vehicle_id) {
      useApp.getState().saveSetting('last_vehicle_id', form.vehicle_id);
      if (form.trailer_id) useApp.getState().saveSetting('last_trailer_id', form.trailer_id);
    }
    touch();
    notify('Путевой лист сохранён', 'ok');
  }

  function doClose() {
    if (!form) return;
    updateRow('waybills', form.id, {
      date_out: form.date_out,
      odometer_out: form.odometer_out,
      fuel_out: form.fuel_out,
      date_in: form.date_in,
      odometer_in: form.odometer_in,
      fuel_in: form.fuel_in,
      vehicle_id: form.vehicle_id,
      trailer_id: form.trailer_id,
    });
    const res = closeWaybill(form.id, settings);
    touch();
    notify(res.message, res.ok ? 'ok' : 'err');
    if (res.ok && res.charged > 0) {
      notify(`Начислено ${fmtMoney(res.charged, settings.currency)}`, 'ok');
    }
  }

  function doReopen() {
    reopenWaybill(form!.id);
    touch();
    notify('Лист снова открыт', 'info');
  }

  function addTrip() {
    const newTripId = uid();
    insertRow('trips', {
      id: newTripId,
      waybill_id: form!.id,
      cargo_type_id: null,
      weight: null,
      amount: settings.base_amount,
      note: '',
      status: 'planned',
    });
    touch();
    navigate(`/trips/${newTripId}`);
  }

  function addRefuel() {
    const newId = uid();
    insertRow('refuelings', {
      id: newId,
      waybill_id: form!.id,
      date: new Date().toISOString(),
      volume: 0,
      kind: 'barrel',
      station_id: null,
      note: '',
    });
    touch();
    navigate(`/refuelings/${newId}`);
  }

  function addCharge() {
    const newId = uid();
    insertRow('finance_ops', {
      id: newId,
      date: form!.date_in ?? todayIso(),
      kind: 'charge',
      amount: 0,
      pay_month: (form!.date_in ?? form!.date_out).slice(0, 7),
      waybill_id: form!.id,
      note: '',
      auto: 0,
    });
    touch();
    navigate(`/finance/${newId}`);
  }

  const refuelings = refuelRepo.byWaybill(waybillId);
  const charges = summary.trips;

  return (
    <Page
      title="Изменить путевой лист"
      onBack={() => navigate(-1)}
      actions={
        <>
          <Button variant="danger" icon="trash" onClick={() => setConfirmDelete(true)} />
          <Button variant="ghost" icon="close" onClick={() => navigate('/waybills')} />
        </>
      }
    >
      {summary.errors.map((e) => (
        <div className="alert alert-err" key={e}>
          <Icon name="warning" />
          <span>{e}</span>
        </div>
      ))}
      {summary.warnings.map((w) => (
        <div className="alert alert-warn" key={w}>
          <Icon name="warning" />
          <span>{w}</span>
        </div>
      ))}

      <Card title={form.status === 'open' ? 'Лист открыт' : 'Лист закрыт'} actions={<Badge tone={form.status === 'open' ? 'warn' : 'neutral'}>{form.status === 'open' ? 'Открыт' : 'Закрыт'}</Badge>}>
        <div className="grid-3">
          <KV label="Пробег" value={summary.mileage === null ? '—' : `${fmtNumber(summary.mileage)} км`} />
          <KV label="Заправлено" value={`${fmtNumber(summary.refueled)} л`} />
          <KV
            label="Средний расход"
            value={summary.avgConsumption === null ? '—' : `${fmtNumber(summary.avgConsumption, 1)} л/100`}
          />
        </div>
        <div className="divider" />
        <div className="row">
          <Icon name="money" />
          <span className="muted small">Начислено по листу</span>
          <span style={{ flex: 1 }} />
          <b className="mono">{fmtMoney(summary.charged, settings.currency)}</b>
        </div>
      </Card>

      <Card title="Основное">
        <Field label="Дата выезда" required>
          <DateInput value={form.date_out} onChange={(v) => set('date_out', v ?? todayIso())} />
        </Field>
        <Field label="Тягач / основной автомобиль" required>
          <Select
            value={form.vehicle_id}
            onChange={(v) => set('vehicle_id', v)}
            options={vehicles.map((v) => ({
              value: v.id,
              label: v.plate ? `${v.name} · ${v.plate}` : v.name,
              logo: v.logo,
            }))}
            placeholder="Не выбран"
          />
        </Field>
        <Field label="Одометр при выезде, км">
          <NumberInput value={form.odometer_out} onValue={(v) => set('odometer_out', v)} />
        </Field>
        <Field label="Топливо при выезде, л">
          <NumberInput value={form.fuel_out} onValue={(v) => set('fuel_out', v)} />
        </Field>
      </Card>

      <Card
        title="Завершение и дополнительные данные"
        actions={<Button variant="ghost" icon={showExtra ? 'up' : 'down'} onClick={() => setShowExtra(!showExtra)} />}
      >
        {showExtra ? (
          <>
            <Field label="Дата сдачи">
              <DateInput value={form.date_in} onChange={(v) => set('date_in', v)} />
            </Field>
            <Field label="Прицеп">
              <Select
                value={form.trailer_id}
                onChange={(v) => set('trailer_id', v)}
                options={trailers.map((v) => ({
                  value: v.id,
                  label: v.plate ? `${v.name} · ${v.plate}` : v.name,
                  logo: v.logo,
                }))}
                placeholder="Не выбран"
              />
            </Field>
            <Field label="Одометр при сдаче, км">
              <NumberInput value={form.odometer_in} onValue={(v) => set('odometer_in', v)} />
            </Field>
            <Field label="Топливо при сдаче, л">
              <NumberInput value={form.fuel_in} onValue={(v) => set('fuel_in', v)} />
            </Field>
            <Field label="Название">
              <TextInput value={form.name} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label="Номер листа">
              <TextInput value={form.number} onChange={(e) => set('number', e.target.value)} />
            </Field>
            <Field label="Примечания">
              <textarea
                className="input"
                rows={3}
                value={form.note}
                onChange={(e) => set('note', e.target.value)}
              />
            </Field>
          </>
        ) : (
          <div className="small muted">
            Дата сдачи: {fmtDate(form.date_in)} · Прицеп: {form.trailer_id ? vehicleTitle(form.trailer_id) : '—'}
          </div>
        )}
      </Card>

      <Button variant="primary" block icon="check" onClick={save}>
        Сохранить
      </Button>

      <Button
        block
        icon="doc"
        onClick={async () => {
          try {
            const { exportWaybillPdf } = await import('../lib/backup');
            await exportWaybillPdf(form.id, settings);
          } catch (e) {
            notify(e instanceof Error ? e.message : 'Не удалось создать PDF', 'err');
          }
        }}
      >
        Печать путевого листа (PDF)
      </Button>

      {form.status === 'open' ? (
        <Button variant="success" block icon="check" onClick={doClose}>
          Закрыть путевой лист
        </Button>
      ) : (
        <Button variant="ghost" block icon="refresh" onClick={doReopen}>
          Открыть лист заново
        </Button>
      )}

      <div className="section-title">
        Поездки <span className="count">{summary.tripsCount}</span>
        <span style={{ flex: 1 }} />
        <Button icon="plus" onClick={addTrip}>
          Добавить
        </Button>
      </div>
      {charges.length === 0 ? (
        <Card>
          <Empty text="Поездок в листе нет" />
        </Card>
      ) : (
        <div className="stack">
          {charges.map((t) => (
            <TripCard key={t.trip.id} summary={t} onOpen={() => navigate(`/trips/${t.trip.id}`)} />
          ))}
        </div>
      )}

      <div className="section-title">
        Заправки <span className="count">{refuelings.length}</span>
        <span style={{ flex: 1 }} />
        <Button icon="plus" onClick={addRefuel}>
          Добавить
        </Button>
      </div>
      {refuelings.length === 0 ? (
        <Card>
          <Empty text="Заправок нет" />
        </Card>
      ) : (
        <div className="list">
          {refuelings.map((r) => (
            <button key={r.id} className="list-item" onClick={() => navigate(`/refuelings/${r.id}`)}>
              <span className="avatar">
                <Icon name="fuel" />
              </span>
              <span className="li-main">
                <span className="li-title">
                  {fmtNumber(r.volume)} л · {refuelKindLabel(r.kind)}
                </span>
                <span className="li-sub">{fmtDateTime(r.date)}</span>
              </span>
              <Icon name="nav" />
            </button>
          ))}
        </div>
      )}

      <div className="section-title">
        Начисления <span className="count">{summary.trips.filter((t) => t.status === 'charged').length}</span>
        <span style={{ flex: 1 }} />
        <Button icon="plus" onClick={addCharge}>
          Добавить
        </Button>
      </div>
      <Card>
        <div className="row">
          <Icon name="money" />
          <span className="muted small">Итого начислено</span>
          <span style={{ flex: 1 }} />
          <b className="mono">{fmtMoney(summary.charged, settings.currency)}</b>
        </div>
        <div className="small muted">
          Начисления создаются автоматически при закрытии листа, если все точки перевозки выполнены.
        </div>
      </Card>

      <Card>
        <DocumentsCard ownerTable="waybills" ownerId={form.id} title="Документы листа" />
      </Card>

      <Confirm
        open={confirmDelete}
        title="Удалить путевой лист"
        text="Лист и его поездки будут скрыты из списков. Действие можно отменить только через восстановление из резервной копии."
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          softDelete('waybills', form.id);
          for (const t of tripRepo.byWaybill(form.id)) {
            softDelete('trips', t.id);
          }
          touch();
          setConfirmDelete(false);
          navigate('/waybills');
        }}
      />
    </Page>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Button,
  Card,
  Confirm,
  DateTimeInput,
  Empty,
  Field,
  NumberInput,
  Page,
  Select,
  TextInput,
} from '../ui/components';
import { DocumentsCard } from '../ui/Documents';
import { useApp } from '../store';
import { insertRow, refs, refuelRepo, softDelete, uid, updateRow, waybillRepo } from '../db/repo';
import { fmtDate } from '../lib/format';
import { REFUEL_KINDS, type Refueling } from '../types';

export default function RefuelDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const revision = useApp((s) => s.revision);
  const touch = useApp((s) => s.touch);
  const notify = useApp((s) => s.notify);

  const [refuelId, setRefuelId] = useState(id);
  const [form, setForm] = useState<Refueling | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (id === 'new') {
      const openWaybill = waybillRepo.open()[0] ?? waybillRepo.list()[0] ?? null;
      const newId = uid();
      insertRow('refuelings', {
        id: newId,
        waybill_id: openWaybill?.id ?? '',
        date: new Date().toISOString(),
        volume: 0,
        kind: 'barrel',
        station_id: null,
        note: '',
      });
      touch();
      setRefuelId(newId);
      navigate(`/refuelings/${newId}`, { replace: true });
    } else {
      setRefuelId(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const row = useMemo(() => refuelRepo.get(refuelId), [refuelId, revision]);
  useEffect(() => {
    if (row) setForm({ ...row });
  }, [row?.id, revision]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!form) {
    return (
      <Page title="Заправка" onBack={() => navigate(-1)}>
        <Empty text="Заправка не найдена" />
      </Page>
    );
  }

  const waybills = waybillRepo.list();
  const stations = refs.fuelStations();

  function save() {
    if (!form) return;
    updateRow('refuelings', form.id, {
      waybill_id: form.waybill_id,
      date: form.date,
      volume: form.volume,
      kind: form.kind,
      station_id: form.station_id,
      note: form.note,
    });
    touch();
    notify('Заправка сохранена', 'ok');
  }

  return (
    <Page
      title="Изменить заправку"
      onBack={() => navigate(-1)}
      actions={
        <>
          <Button variant="danger" icon="trash" onClick={() => setConfirmDelete(true)} />
          <Button variant="ghost" icon="close" onClick={() => navigate('/refuelings')} />
        </>
      }
    >
      <Card>
        <Field label="Путевой лист">
          <Select
            value={form.waybill_id || null}
            onChange={(v) => setForm({ ...form, waybill_id: v ?? '' })}
            options={waybills.map((w) => ({
              value: w.id,
              label: `${fmtDate(w.date_out)} — ${w.date_in ? fmtDate(w.date_in) : 'открыт'}`,
            }))}
            placeholder="Без листа"
          />
        </Field>
        <Field label="Дата и время" required>
          <DateTimeInput value={form.date} onChange={(v) => setForm({ ...form, date: v ?? new Date().toISOString() })} />
        </Field>
        <Field label="Объём, л" required>
          <NumberInput value={form.volume} onValue={(v) => setForm({ ...form, volume: v ?? 0 })} />
        </Field>
        <Field label="Источник топлива" required>
          <Select
            value={form.kind}
            onChange={(v) =>
              setForm({ ...form, kind: (v ?? 'barrel') as Refueling['kind'], station_id: v === 'barrel' ? null : form.station_id })
            }
            options={REFUEL_KINDS}
            placeholder="Бочка"
          />
        </Field>
        {form.kind === 'station' ? (
          <Field label="АЗС">
            <Select
              value={form.station_id}
              onChange={(v) => setForm({ ...form, station_id: v })}
              options={stations.map((s) => ({ value: s.id, label: s.name }))}
              placeholder="Не выбрана"
            />
          </Field>
        ) : null}
        <Field label="Примечания">
          <TextInput value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </Field>
      </Card>

      <Button variant="primary" block icon="check" onClick={save}>
        Сохранить
      </Button>

      <Card>
        <DocumentsCard ownerTable="refuelings" ownerId={form.id} title="Чек или фото" />
      </Card>

      <Confirm
        open={confirmDelete}
        title="Удалить заправку"
        text="Запись будет скрыта из списков."
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          softDelete('refuelings', form.id);
          touch();
          setConfirmDelete(false);
          navigate('/refuelings');
        }}
      />
    </Page>
  );
}

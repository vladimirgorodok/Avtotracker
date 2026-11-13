import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Button,
  Card,
  Confirm,
  DateInput,
  Empty,
  Field,
  Icon,
  Modal,
  NumberInput,
  Page,
  Select,
  TextInput,
} from '../ui/components';
import { useApp } from '../store';
import { insertRow, softDelete, uid, updateRow, vehicleRepo, waybillRepo } from '../db/repo';
import { PicturePicker } from '../ui/PictureSearch';
import { fmtDate, plural } from '../lib/format';
import type { Vehicle } from '../types';

export default function VehicleDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const revision = useApp((s) => s.revision);
  const touch = useApp((s) => s.touch);
  const notify = useApp((s) => s.notify);

  const [vehicleId, setVehicleId] = useState(id);
  const [form, setForm] = useState<Vehicle | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [periodOpen, setPeriodOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [period, setPeriod] = useState<{ id: string | null; start_date: string | null; end_date: string | null; note: string }>({
    id: null,
    start_date: null,
    end_date: null,
    note: '',
  });

  useEffect(() => {
    if (id === 'new') {
      const newId = uid();
      insertRow('vehicles', {
        id: newId,
        name: '',
        plate: '',
        kind: 'tractor',
        brand: '',
        model: '',
        vin: '',
        year: '',
        fuel_norm: null,
        note: '',
        logo: '',
        archived: 0,
      });
      touch();
      setVehicleId(newId);
      navigate(`/vehicles/${newId}`, { replace: true });
    } else {
      setVehicleId(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const row = useMemo(() => vehicleRepo.find(vehicleId), [vehicleId, revision]);
  useEffect(() => {
    if (row) setForm({ ...row });
  }, [row?.id, revision]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!form) {
    return (
      <Page title="Автомобиль" onBack={() => navigate(-1)}>
        <Empty text="Автомобиль не найден" />
      </Page>
    );
  }

  const periods = vehicleRepo.periods(vehicleId);
  const waybills = waybillRepo.list().filter((w) => w.vehicle_id === vehicleId);

  function save() {
    if (!form) return;
    updateRow('vehicles', form.id, {
      name: form.name,
      plate: form.plate,
      kind: form.kind,
      brand: form.brand,
      model: form.model,
      vin: form.vin,
      year: form.year,
      fuel_norm: form.fuel_norm,
      note: form.note,
      logo: form.logo,
      archived: form.archived,
    });
    touch();
    notify('Автомобиль сохранён', 'ok');
  }

  /** Логотип сразу попадает и в форму, и в базу */
  function applyLogo(url: string) {
    setForm((f) => (f ? { ...f, logo: url } : f));
    updateRow('vehicles', vehicleId, { logo: url });
    touch();
  }

  async function pickLogo(file: File) {
    const reader = new FileReader();
    reader.onload = () => applyLogo(String(reader.result));
    reader.readAsDataURL(file);
  }

  function savePeriod() {
    const payload = {
      vehicle_id: vehicleId,
      start_date: period.start_date ?? '',
      end_date: period.end_date,
      note: period.note,
    };
    if (period.id) updateRow('vehicle_periods', period.id, payload);
    else insertRow('vehicle_periods', { id: uid(), ...payload });
    touch();
    setPeriodOpen(false);
  }

  return (
    <Page
      title="Изменить автомобиль"
      onBack={() => navigate(-1)}
      actions={
        <>
          <Button variant="danger" icon="trash" onClick={() => setConfirmDelete(true)} />
          <Button variant="ghost" icon="close" onClick={() => navigate('/vehicles')} />
        </>
      }
    >
      <Card>
        <div className="row">
          <span className="avatar" style={{ width: 64, height: 64 }}>
            {form.logo ? <img src={form.logo} alt="" /> : <Icon name="car" size={28} />}
          </span>
          <div className="li-main">
            <div className="li-title">{form.name || 'Новый автомобиль'}</div>
            <div className="li-sub">{form.plate}</div>
          </div>
        </div>

        <Field label="Автомобиль" required>
          <TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Тип">
          <Select
            value={form.kind}
            onChange={(v) => setForm({ ...form, kind: (v ?? 'tractor') as Vehicle['kind'] })}
            options={[
              { value: 'tractor', label: 'Тягач / основной' },
              { value: 'trailer', label: 'Прицеп' },
            ]}
            placeholder="Тягач"
          />
        </Field>
        <Field label="Госномер">
          <TextInput value={form.plate} onChange={(e) => setForm({ ...form, plate: e.target.value })} />
        </Field>
        <Field label="Марка">
          <TextInput value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} />
        </Field>
        <Field label="Модель">
          <TextInput value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
        </Field>
        <Field label="VIN">
          <TextInput value={form.vin} onChange={(e) => setForm({ ...form, vin: e.target.value })} />
        </Field>
        <Field label="Год">
          <TextInput value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })} />
        </Field>
        <Field label="Норма расхода, л/100 км" hint="Нужна для контроля перерасхода топлива">
          <NumberInput value={form.fuel_norm} onValue={(v) => setForm({ ...form, fuel_norm: v })} />
        </Field>
        <Field label="Примечания">
          <textarea
            className="input"
            rows={3}
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
        </Field>
        <Field label="Логотип" hint="можно подобрать помощником по названию">
          <div className="row wrap">
            <label className="btn btn-soft">
              <Icon name="upload" />
              <span>Файл</span>
              <input
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void pickLogo(f);
                }}
              />
            </label>
            <Button
              icon="ai"
              disabled={form.name.trim() === '' && form.plate.trim() === ''}
              onClick={() => setPickerOpen(true)}
            >
              Найти
            </Button>
            <TextInput
              value={form.logo.startsWith('data:') ? '' : form.logo}
              placeholder="Ссылка на изображение"
              onChange={(e) => setForm({ ...form, logo: e.target.value })}
            />
            {form.logo ? <Button variant="danger" icon="trash" onClick={() => applyLogo('')} /> : null}
          </div>
        </Field>
        <Field label="Архив">
          <Select
            value={form.archived ? '1' : '0'}
            onChange={(v) => setForm({ ...form, archived: v === '1' ? 1 : 0 })}
            options={[
              { value: '0', label: 'Активный' },
              { value: '1', label: 'В архиве' },
            ]}
            placeholder="Активный"
          />
        </Field>
      </Card>

      <Button variant="primary" block icon="check" onClick={save}>
        Сохранить
      </Button>

      <div className="section-title">
        Периоды <span className="count">{periods.length}</span>
        <span style={{ flex: 1 }} />
        <Button
          icon="plus"
          onClick={() => {
            setPeriod({ id: null, start_date: new Date().toISOString().slice(0, 10), end_date: null, note: '' });
            setPeriodOpen(true);
          }}
        >
          Добавить
        </Button>
      </div>
      {periods.length === 0 ? (
        <Card>
          <Empty text="Периодов использования нет" />
        </Card>
      ) : (
        <div className="list">
          {periods.map((p) => (
            <button
              key={p.id}
              className="list-item"
              onClick={() => {
                setPeriod({ id: p.id, start_date: p.start_date, end_date: p.end_date, note: p.note });
                setPeriodOpen(true);
              }}
            >
              <span className="li-main">
                <span className="li-title">
                  {fmtDate(p.start_date)} — {p.end_date ? fmtDate(p.end_date) : 'по настоящее время'}
                </span>
                <span className="li-sub">{p.end_date ? 'Завершён' : 'Активный период'}</span>
              </span>
              <Icon name="edit" />
            </button>
          ))}
        </div>
      )}

      <div className="section-title">
        Путевые листы <span className="count">{waybills.length}</span>
      </div>
      {waybills.length === 0 ? (
        <Card>
          <Empty text="Листов нет" />
        </Card>
      ) : (
        <div className="list">
          {waybills.map((w) => (
            <button key={w.id} className="list-item" onClick={() => navigate(`/waybills/${w.id}`)}>
              <span className="avatar">
                <Icon name="doc" />
              </span>
              <span className="li-main">
                <span className="li-title">
                  {fmtDate(w.date_out)} — {w.date_in ? fmtDate(w.date_in) : 'открыт'}
                </span>
                <span className="li-sub">
                  {w.date_out} · {w.status === 'open' ? 'открыт' : 'закрыт'}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      <Modal
        open={periodOpen}
        title={period.id ? 'Изменить период' : 'Новый период'}
        onClose={() => setPeriodOpen(false)}
        footer={
          <>
            {period.id ? (
              <Button
                variant="danger"
                icon="trash"
                onClick={() => {
                  softDelete('vehicle_periods', period.id!);
                  touch();
                  setPeriodOpen(false);
                }}
              >
                Удалить
              </Button>
            ) : null}
            <span style={{ flex: 1 }} />
            <Button onClick={() => setPeriodOpen(false)}>Отмена</Button>
            <Button variant="primary" icon="check" onClick={savePeriod}>
              Сохранить
            </Button>
          </>
        }
      >
        <Field label="Начало" required>
          <DateInput value={period.start_date} onChange={(v) => setPeriod({ ...period, start_date: v })} />
        </Field>
        <Field label="Окончание" hint="Оставьте пустым для активного периода">
          <DateInput value={period.end_date} onChange={(v) => setPeriod({ ...period, end_date: v })} />
        </Field>
        <Field label="Примечания">
          <TextInput value={period.note} onChange={(e) => setPeriod({ ...period, note: e.target.value })} />
        </Field>
        <div className="small muted">
          {waybills.length} {plural(waybills.length, 'лист', 'листа', 'листов')} привязано к автомобилю
        </div>
      </Modal>

      <Confirm
        open={confirmDelete}
        title="Удалить автомобиль"
        text="Автомобиль будет скрыт из списков. Путевые листы останутся, но потеряют привязку."
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          softDelete('vehicles', form.id);
          touch();
          setConfirmDelete(false);
          navigate('/vehicles');
        }}
      />

      {pickerOpen ? (
        <PicturePicker
          name={form.name.trim() !== '' ? form.name : form.plate}
          kind="vehicle"
          title="Подобрать значок техники"
          onClose={() => setPickerOpen(false)}
          onPick={(value) => applyLogo(value)}
        />
      ) : null}
    </Page>
  );
}

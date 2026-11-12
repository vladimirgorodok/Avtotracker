import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Button,
  Card,
  Confirm,
  DateInput,
  Empty,
  Field,
  NumberInput,
  Page,
  Select,
  TextInput,
} from '../ui/components';
import { useApp } from '../store';
import { financeRepo, insertRow, refs, softDelete, tripRepo, uid, updateRow } from '../db/repo';
import { fmtDate, monthLabel, monthKey, todayIso } from '../lib/format';
import { FINANCE_KINDS, type FinanceOp } from '../types';

export default function FinanceDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const revision = useApp((s) => s.revision);
  const touch = useApp((s) => s.touch);
  const notify = useApp((s) => s.notify);

  const [opId, setOpId] = useState(id);
  const [form, setForm] = useState<FinanceOp | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (id === 'new') {
      const newId = uid();
      const today = todayIso();
      insertRow('finance_ops', {
        id: newId,
        date: today,
        kind: 'payment',
        amount: 0,
        pay_month: today.slice(0, 7),
        note: '',
        auto: 0,
      });
      touch();
      setOpId(newId);
      navigate(`/finance/${newId}`, { replace: true });
    } else {
      setOpId(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const row = useMemo(() => financeRepo.get(opId), [opId, revision]);
  useEffect(() => {
    if (row) setForm({ ...row });
  }, [row?.id, revision]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!form) {
    return (
      <Page title="Операция" onBack={() => navigate(-1)}>
        <Empty text="Операция не найдена" />
      </Page>
    );
  }

  const trips = tripRepo.all();

  function save() {
    if (!form) return;
    updateRow('finance_ops', form.id, {
      date: form.date,
      kind: form.kind,
      amount: form.amount,
      pay_month: form.pay_month,
      trip_id: form.trip_id,
      note: form.note,
    });
    touch();
    notify('Операция сохранена', 'ok');
  }

  return (
    <Page
      title="Изменить операцию"
      onBack={() => navigate(-1)}
      actions={
        <>
          <Button variant="danger" icon="trash" onClick={() => setConfirmDelete(true)} />
          <Button variant="ghost" icon="close" onClick={() => navigate('/finance')} />
        </>
      }
    >
      <Card>
        <Field label="Дата операции" required>
          <DateInput
            value={form.date}
            onChange={(v) => {
              const date = v ?? todayIso();
              setForm({ ...form, date, pay_month: form.pay_month ?? monthKey(date) });
            }}
          />
        </Field>
        <Field label="Тип операции" required>
          <Select
            value={form.kind}
            onChange={(v) => setForm({ ...form, kind: (v ?? 'charge') as FinanceOp['kind'] })}
            options={FINANCE_KINDS}
            placeholder="Начислено"
          />
        </Field>
        <Field label={form.kind === 'charge' ? 'Сумма начислено' : 'Сумма поступило'} required>
          <NumberInput value={form.amount} onValue={(v) => setForm({ ...form, amount: v ?? 0 })} />
        </Field>
        <Field label="Месяц оплаты" hint="К какому месяцу относится зарплата">
          <Select
            value={form.pay_month}
            onChange={(v) => setForm({ ...form, pay_month: v })}
            options={monthOptions().map((m) => ({ value: m, label: monthLabel(m) }))}
            placeholder="Не указан"
          />
        </Field>
        <Field label="Перевозка" hint="Необязательно">
          <Select
            value={form.trip_id}
            onChange={(v) => setForm({ ...form, trip_id: v })}
            options={trips.map((t) => {
              const pts = tripRepo.points(t.id);
              const from = refs.place(pts[0]?.place_id ?? null)?.name ?? '—';
              const to = refs.place(pts[pts.length - 1]?.place_id ?? null)?.name ?? '—';
              return { value: t.id, label: `${from} → ${to}` };
            })}
            placeholder="Без привязки"
          />
        </Field>
        <Field label="Примечания">
          <TextInput value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </Field>
        <div className="small muted">
          Создано: {fmtDate(form.created_at.slice(0, 10))}
          {form.auto ? ' · автоматически при начислении' : ''}
        </div>
      </Card>

      <Button variant="primary" block icon="check" onClick={save}>
        Сохранить
      </Button>

      <Confirm
        open={confirmDelete}
        title="Удалить операцию"
        text="Операция будет скрыта из списков."
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          softDelete('finance_ops', form.id);
          touch();
          setConfirmDelete(false);
          navigate('/finance');
        }}
      />
    </Page>
  );
}

function monthOptions(): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = -24; i <= 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out.reverse();
}

/**
 * Быстрые действия водителя: «Заправился» и «Пришли деньги».
 *
 * Это короткие окна в одно-два поля. Живут рядом с меню «＋», чтобы не занимать
 * Главный экран: нажали «＋» — и сразу вводите только то, что нужно.
 */

import { useState } from 'react';
import { Button, Modal, NumberInput, TextInput } from './components';
import { useApp } from '../store';
import { updateRow, waybillRepo } from '../db/repo';
import { lastRefuelKind, quickPayment, quickRefuel } from '../lib/actions';
import { fmtMoney, fmtNumber } from '../lib/format';

/** Быстрая заправка: только литры, остальное подставляем — источник как в прошлый раз */
export function QuickRefuelModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const touch = useApp((s) => s.touch);
  const notify = useApp((s) => s.notify);
  const [volume, setVolume] = useState<number | null>(null);

  function save() {
    const v = Number(volume) || 0;
    if (v <= 0) {
      notify('Укажите объём', 'err');
      return;
    }
    const wbId = waybillRepo.open()[0]?.id ?? null;
    quickRefuel(wbId, v, lastRefuelKind());
    touch();
    setVolume(null);
    onClose();
    notify(`Заправлено ${fmtNumber(v)} л`, 'ok');
  }

  return (
    <Modal
      open={open}
      title="Заправился"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" icon="check" onClick={save}>
            Сохранить
          </Button>
        </>
      }
    >
      <div className="small muted">
        Источник подставим как в прошлый раз, дата — сегодня. Нужен только объём.
      </div>
      <label className="field">
        <span className="field-label">Объём, л</span>
        <NumberInput value={volume} onValue={setVolume} steppers step={10} />
      </label>
    </Modal>
  );
}

/** Быстрое поступление: сумма и отчисление в семью, дата — сегодня */
export function QuickMoneyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = useApp((s) => s.settings);
  const touch = useApp((s) => s.touch);
  const notify = useApp((s) => s.notify);
  const [amount, setAmount] = useState<number | null>(null);
  const [family, setFamily] = useState<number | null>(null);
  const [note, setNote] = useState('');

  function save() {
    const sum = Number(amount) || 0;
    if (sum <= 0) {
      notify('Укажите сумму', 'err');
      return;
    }
    const wbId = waybillRepo.open()[0]?.id ?? null;
    const id = quickPayment(sum, Number(family) || 0, wbId);
    if (note.trim()) updateRow('finance_ops', id, { note: note.trim() });
    touch();
    setAmount(null);
    setFamily(null);
    setNote('');
    onClose();
    notify(`Поступило ${fmtMoney(sum, settings.currency)}`, 'ok');
  }

  return (
    <Modal
      open={open}
      title="Пришли деньги"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" icon="check" onClick={save}>
            Сохранить
          </Button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">Сумма поступило</span>
        <NumberInput value={amount} onValue={setAmount} steppers step={500} />
      </label>
      <label className="field">
        <span className="field-label">В семью</span>
        <NumberInput value={family} onValue={setFamily} steppers step={500} />
        <span className="field-hint">Отчисление из этого поступления; можно оставить нулём</span>
      </label>
      <label className="field">
        <span className="field-label">Примечание</span>
        <TextInput value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="small muted">Месяц оплаты — прошлый; его можно поменять в операции.</div>
    </Modal>
  );
}

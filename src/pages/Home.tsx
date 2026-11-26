import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  defaultFilterMonth,
  Empty,
  Icon,
  Modal,
  MonthPicker,
  NumberInput,
  SearchEntry,
  StatCard,
  StatGrid,
  TextInput,
} from '../ui/components';
import { useApp } from '../store';
import { financeRepo, refs, tripRepo, updateRow, waybillRepo } from '../db/repo';
import { fmtDate, fmtMoney, fmtNumber, mapLink, monthKey, todayIso } from '../lib/format';
import { sortTrips, summarizeTrip, summarizeWaybill } from '../lib/calc';
import type { TripSummary } from '../lib/calc';
import { closeShiftToday, lastRefuelKind, quickPayment, quickRefuel, refreshTripStatus } from '../lib/actions';
import type { TripPoint } from '../types';
import { SaveBadge } from '../ui/SaveBadge';

export default function Home({ onCreate }: { onCreate: () => void }) {
  const navigate = useNavigate();
  const revision = useApp((s) => s.revision);
  const settings = useApp((s) => s.settings);
  const touch = useApp((s) => s.touch);
  const notify = useApp((s) => s.notify);
  const [quick, setQuick] = useState<'refuel' | 'money' | null>(null);
  const [fuelVolume, setFuelVolume] = useState<number | null>(null);
  const [moneyAmount, setMoneyAmount] = useState<number | null>(null);
  const [moneyFamily, setMoneyFamily] = useState<number | null>(null);
  const [moneyNote, setMoneyNote] = useState('');
  const [month, setMonth] = useState<string>(() => defaultFilterMonth());

  const data = useMemo(() => {
    const openWaybill = waybillRepo.open()[0] ?? null;
    const lastWaybill = openWaybill ?? waybillRepo.list()[0] ?? null;
    const openSummary = openWaybill ? summarizeWaybill(openWaybill) : null;

    const financeOps = month ? financeRepo.byMonth(month) : financeRepo.list();
    const charged = financeOps.filter((o) => o.kind === 'charge').reduce((s, o) => s + o.amount, 0);
    const paid = financeOps.filter((o) => o.kind === 'payment').reduce((s, o) => s + o.amount, 0);
    const family = financeOps
      .filter((o) => o.kind === 'payment')
      .reduce((s, o) => s + (Number(o.family) || 0), 0);

    const trips = sortTrips(tripRepo.all().map(summarizeTrip));
    const current = trips.find((t) => !t.completed && t.nextPoint) ?? null;
    const filtered = trips.filter((t) => {
      if (!month) return true;
      const wb = waybillRepo.get(t.trip.waybill_id);
      const key = monthKey(wb?.date_out ?? t.trip.created_at);
      return key === month;
    });

    return { openWaybill, lastWaybill, openSummary, charged, paid, family, onHand: paid - family, trips: filtered, current };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, month]);

  /** Быстрая заправка: литры, остальное подставляем — источник как в прошлый раз */
  function saveQuickRefuel() {
    const volume = Number(fuelVolume) || 0;
    if (volume <= 0) {
      notify('Укажите объём', 'err');
      return;
    }
    const wbId = data.openWaybill?.id ?? null;
    quickRefuel(wbId, volume, lastRefuelKind());
    touch();
    setQuick(null);
    setFuelVolume(null);
    notify(`Заправлено ${fmtNumber(volume)} л`, 'ok');
  }

  /** Быстрое поступление: сумма и отчисление в семью, дата — сегодня */
  function saveQuickMoney() {
    const amount = Number(moneyAmount) || 0;
    if (amount <= 0) {
      notify('Укажите сумму', 'err');
      return;
    }
    const id = quickPayment(amount, Number(moneyFamily) || 0, data.openWaybill?.id ?? null);
    if (moneyNote.trim()) updateRow('finance_ops', id, { note: moneyNote.trim() });
    touch();
    setQuick(null);
    setMoneyAmount(null);
    setMoneyFamily(null);
    setMoneyNote('');
    notify(`Поступило ${fmtMoney(amount, settings.currency)}`, 'ok');
  }

  /** Закрыть смену одним движением: дату, одометр и топливо подставляем сами */
  function saveCloseShift() {
    const wb = data.openWaybill;
    if (!wb) return;
    const res = closeShiftToday(wb.id, settings);
    touch();
    notify(res.message, res.ok ? 'ok' : 'err');
    if (res.ok && res.charged > 0) notify(`Начислено ${fmtMoney(res.charged, settings.currency)}`, 'ok');
    if (!res.ok) navigate(`/waybills/${wb.id}`);
  }

  /** Закрыть точку «сегодня»; после последней точки открываем карточку поездки для начисления. */
  function completePoint(point: TripPoint, tripId: string) {
    updateRow('trip_points', point.id, { fact_date: todayIso(), status: 'done' });
    refreshTripStatus(tripId);
    touch();
    const after = tripRepo.get(tripId);
    if (after && after.status !== 'planned') {
      notify('Поездка выполнена — сохраните начисление', 'ok');
      navigate(`/trips/${tripId}`);
    } else {
      notify('Точка выполнена', 'ok');
    }
  }

  const vehicle = refs.vehicle(data.lastWaybill?.vehicle_id ?? null);
  const trailer = refs.vehicle(data.lastWaybill?.trailer_id ?? null);

  return (
    <div className="page">
      <header className="topbar">
        <h1>Главная</h1>
        <SaveBadge />
      </header>
      <div className="page-body">
        <div className="filters">
          <Button
            variant={month ? 'soft' : 'primary'}
            icon={month ? 'check' : undefined}
            onClick={() => setMonth(month ? '' : monthKey(new Date().toISOString()))}
          >
            {month ? 'Месяц' : 'Все'}
          </Button>
          <MonthPicker value={month} onChange={setMonth} />
        </div>
        <SearchEntry text="Поиск по всему: листы, поездки, справочники" onClick={() => navigate('/search')} />

        <div className="quick-actions">
          <Button variant="soft" icon="fuel" onClick={() => setQuick('refuel')}>
            Заправился
          </Button>
          <Button variant="soft" icon="money" onClick={() => setQuick('money')}>
            Пришли деньги
          </Button>
          {data.openWaybill ? (
            <Button variant="success" icon="check" onClick={saveCloseShift}>
              Закрыть смену
            </Button>
          ) : (
            <Button variant="primary" icon="plus" onClick={onCreate}>
              Открыть смену
            </Button>
          )}
        </div>

        {data.current?.nextPoint ? (
          <NextPointCard
            summary={data.current}
            onOpen={() => navigate(`/trips/${data.current!.trip.id}`)}
            onDone={(p) => completePoint(p, data.current!.trip.id)}
          />
        ) : null}

        <Card
          title="Автомобиль и смена"
          actions={<Icon name="car" />}
          className="clickable"
          onClick={() => navigate('/vehicles')}
        >
          {vehicle ? (
            <div className="row">
              <span className="avatar">
                {vehicle.logo ? <img src={vehicle.logo} alt="" /> : <Icon name="car" />}
              </span>
              <div className="li-main">
                <div className="li-title">
                  {vehicle.name}
                  {trailer ? ` + ${trailer.name}` : ''}
                </div>
                <div className="li-sub">
                  {[vehicle.plate, trailer?.plate].filter(Boolean).join(' · ')}
                </div>
              </div>
              <Badge>{trailer ? 'Тягач и прицеп' : 'Тягач'}</Badge>
            </div>
          ) : (
            <div className="muted small">Автомобиль ещё не добавлен</div>
          )}
        </Card>

        {data.openSummary ? (
          <Card
            title="Открытый путевой лист"
            actions={<Badge tone="warn">Открыт</Badge>}
            className="clickable"
            onClick={() => navigate(`/waybills/${data.openSummary!.waybill.id}`)}
          >
            <div style={{ fontWeight: 650, fontSize: 17 }}>
              {fmtDate(data.openSummary.waybill.date_out)} — открыт
            </div>
            <div className="grid-2">
              <div className="kv">
                <div className="kv-label">Выезд</div>
                <div className="kv-value">{fmtDate(data.openSummary.waybill.date_out)}</div>
              </div>
              <div className="kv">
                <div className="kv-label">Одометр</div>
                <div className="kv-value mono">
                  {fmtNumber(data.openSummary.waybill.odometer_out)} км
                </div>
              </div>
              <div className="kv">
                <div className="kv-label">Топливо при выезде</div>
                <div className="kv-value mono">{fmtNumber(data.openSummary.waybill.fuel_out)} л</div>
              </div>
              <div className="kv">
                <div className="kv-label">Заправки</div>
                <div className="kv-value mono">{fmtNumber(data.openSummary.refueled)} л</div>
              </div>
            </div>
          </Card>
        ) : (
          <Card title="Путевой лист">
            <Empty text="Открытого путевого листа нет" action={<Button variant="primary" icon="plus" onClick={onCreate}>Создать</Button>} />
          </Card>
        )}

        <StatGrid>
          <StatCard
            label="Начислено"
            tone="ok"
            icon="money"
            value={fmtMoney(data.charged, settings.currency)}
            onClick={() => navigate('/finance')}
          />
          <StatCard
            label="Оплачено"
            tone="info"
            icon="check"
            value={fmtMoney(data.paid, settings.currency)}
            onClick={() => navigate('/finance')}
          />
          <StatCard
            label="В семью"
            tone="warn"
            icon="family"
            value={fmtMoney(data.family, settings.currency)}
            onClick={() => navigate('/finance')}
          />
          <StatCard
            label="На руках"
            tone="ok"
            icon="money"
            value={fmtMoney(data.onHand, settings.currency)}
            onClick={() => navigate('/finance')}
          />
          <StatCard
            label="Остаток"
            tone={data.charged - data.paid > 0 ? 'err' : 'ok'}
            icon="money"
            value={fmtMoney(data.charged - data.paid, settings.currency)}
            onClick={() => navigate('/finance')}
          />
        </StatGrid>

        <div className="section-title">
          Перевозки <span className="count">{data.trips.length}</span>
        </div>
        {data.trips.length === 0 ? (
          <Card>
            <Empty text="Перевозок за выбранный период нет" />
          </Card>
        ) : (
          <div className="stack">
            {data.trips.slice(0, 6).map((t) => (
              <TripCard key={t.trip.id} summary={t} onOpen={() => navigate(`/trips/${t.trip.id}`)} />
            ))}
            {data.trips.length > 6 ? (
              <Button onClick={() => navigate('/trips')}>Все перевозки</Button>
            ) : null}
          </div>
        )}
      </div>

      <Modal
        open={quick === 'refuel'}
        title="Заправился"
        onClose={() => setQuick(null)}
        footer={
          <>
            <Button onClick={() => setQuick(null)}>Отмена</Button>
            <Button variant="primary" icon="check" onClick={saveQuickRefuel}>
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
          <NumberInput value={fuelVolume} onValue={setFuelVolume} steppers step={10} />
        </label>
      </Modal>

      <Modal
        open={quick === 'money'}
        title="Пришли деньги"
        onClose={() => setQuick(null)}
        footer={
          <>
            <Button onClick={() => setQuick(null)}>Отмена</Button>
            <Button variant="primary" icon="check" onClick={saveQuickMoney}>
              Сохранить
            </Button>
          </>
        }
      >
        <label className="field">
          <span className="field-label">Сумма поступило</span>
          <NumberInput value={moneyAmount} onValue={setMoneyAmount} steppers step={500} />
        </label>
        <label className="field">
          <span className="field-label">В семью</span>
          <NumberInput value={moneyFamily} onValue={setMoneyFamily} steppers step={500} />
          <span className="field-hint">Отчисление из этого поступления; можно оставить нулём</span>
        </label>
        <label className="field">
          <span className="field-label">Примечание</span>
          <TextInput value={moneyNote} onChange={(e) => setMoneyNote(e.target.value)} />
        </label>
      </Modal>
    </div>
  );
}

export function TripCard({ summary, onOpen }: { summary: TripSummary; onOpen: () => void }) {
  const settings = useApp((s) => s.settings);
  const wb = waybillRepo.get(summary.trip.waybill_id);
  const cargo = refs.cargoType(summary.trip.cargo_type_id ?? summary.firstLoad?.cargo_type_id ?? null);
  // Значок отражает ход поездки, а деньги — отдельная плашка: «Начислено» или «К начислению».
  const statusTone = summary.completed ? 'info' : 'warn';
  const statusLabel = summary.completed ? 'Выполнена' : 'В плане';

  return (
    <Card className="clickable" onClick={onOpen}>
      <div className="card-head">
        <span className="avatar">
          <Icon name="route" />
        </span>
        <div className="li-main">
          <div className="li-title">
            {fmtDate(summary.dateLoad ?? wb?.date_out)} · {summary.title}
          </div>
          <div className="li-sub">
            {summary.pointsCount} точек · {fmtDate(wb?.date_out)}
          </div>
        </div>
        <Badge tone={statusTone}>{statusLabel}</Badge>
      </div>

      <div className="progress">
        <i style={{ width: `${Math.round(summary.progress * 100)}%` }} />
      </div>

      <div className="stack-sm">
        {summary.points.map((p) => {
          const place = refs.place(p.place_id);
          const company = refs.company(place?.company_id ?? null);
          return (
            <div key={p.id} className="row">
              <Badge tone={p.kind === 'load' ? 'info' : 'err'}>
                {p.kind === 'load' ? 'Погрузка' : 'Выгрузка'}
              </Badge>
              <div className="li-main">
                <div className="li-title small">{place?.name ?? 'Место не выбрано'}</div>
                <div className="li-sub">{company?.name ?? '—'}</div>
              </div>
              <div className="li-side">
                <span className="small muted">
                  {p.status === 'done' ? `Факт ${fmtDate(p.fact_date)}` : `План ${fmtDate(p.plan_date)}`}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="divider" />
      <div className="row wrap">
        <Badge>{cargo?.name ?? 'Груз не указан'}</Badge>
        <span className="small muted">Вес: {fmtNumber(summary.totalWeight)} кг</span>
        <span style={{ flex: 1 }} />
        <Badge tone={summary.charged ? 'ok' : 'warn'}>
          {summary.charged ? 'Начислено' : 'К начислению'} · {fmtMoney(summary.amount, settings.currency)}
        </Badge>
      </div>
    </Card>
  );
}

/**
 * Следующая точка текущей поездки: фирма с логотипом, данные места
 * (адрес, координаты, контакт, примечания — всё кликабельное) и кнопка «Выполнен».
 */
export function NextPointCard({
  summary,
  onOpen,
  onDone,
}: {
  summary: TripSummary;
  onOpen: () => void;
  onDone: (point: TripPoint) => void;
}) {
  const point = summary.nextPoint;
  if (!point) return null;
  const place = refs.place(point.place_id);
  const company = refs.company(place?.company_id ?? null);
  const left = summary.pointsCount - summary.doneCount;

  return (
    <Card
      title="Следующая точка"
      actions={
        <Badge tone={point.kind === 'load' ? 'info' : 'err'}>
          {point.kind === 'load' ? 'Погрузка' : 'Выгрузка'}
        </Badge>
      }
    >
      <div className="row">
        <span className="avatar">
          {company?.logo ? <img src={company.logo} alt="" /> : <Icon name="box" />}
        </span>
        <div className="li-main">
          <div className="li-title">{place?.name ?? 'Место не выбрано'}</div>
          <div className="li-sub">{company?.name ?? 'Фирма не указана'}</div>
        </div>
        <div className="li-side">
          <span className="small muted">из {left}</span>
        </div>
      </div>

      <div className="grid-2">
        <div className="kv">
          <div className="kv-label">Плановая дата</div>
          <div className="kv-value">{fmtDate(point.plan_date)}</div>
        </div>
        <div className="kv">
          <div className="kv-label">Поездка</div>
          <div className="kv-value small">{summary.title}</div>
        </div>
      </div>

      <div className="row wrap">
        {place?.address ? (
          <a
            className="badge badge-info"
            href={mapLink(place.lat, place.lon, place.address, place.name)}
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="nav" size={14} />
            {place.address}
          </a>
        ) : null}
        {place?.contact ? (
          <a className="badge badge-ok" href={`tel:${place.contact}`}>
            <Icon name="phone" size={14} />
            {place.contact}
          </a>
        ) : null}
        {place?.note ? <span className="small muted">{place.note}</span> : null}
        {point.note ? <span className="small muted">{point.note}</span> : null}
      </div>

      <div className="row">
        <Button variant="success" icon="check" onClick={() => onDone(point)}>
          Выполнен
        </Button>
        <Button icon="route" onClick={onOpen}>
          Открыть поездку
        </Button>
      </div>
    </Card>
  );
}

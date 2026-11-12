import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  Empty,
  Icon,
  MonthPicker,
  SearchBar,
  StatCard,
} from '../ui/components';
import { useApp } from '../store';
import { financeRepo, refs, tripRepo, waybillRepo } from '../db/repo';
import { fmtDate, fmtMoney, fmtNumber, monthKey } from '../lib/format';
import { summarizeTrip, summarizeWaybill } from '../lib/calc';
import type { TripSummary } from '../lib/calc';

export default function Home({ onCreate }: { onCreate: () => void }) {
  const navigate = useNavigate();
  const revision = useApp((s) => s.revision);
  const settings = useApp((s) => s.settings);
  const [month, setMonth] = useState<string>(() => monthKey(new Date().toISOString()));
  const [search, setSearch] = useState('');

  const data = useMemo(() => {
    const openWaybill = waybillRepo.open()[0] ?? null;
    const lastWaybill = openWaybill ?? waybillRepo.list()[0] ?? null;
    const openSummary = openWaybill ? summarizeWaybill(openWaybill) : null;

    const financeOps = month ? financeRepo.byMonth(month) : financeRepo.list();
    const charged = financeOps.filter((o) => o.kind === 'charge').reduce((s, o) => s + o.amount, 0);
    const paid = financeOps.filter((o) => o.kind === 'payment').reduce((s, o) => s + o.amount, 0);

    const trips = tripRepo.all().map(summarizeTrip);
    const needle = search.trim().toLowerCase();
    const filtered = trips.filter((t) => {
      if (month) {
        const wb = waybillRepo.get(t.trip.waybill_id);
        const key = monthKey(wb?.date_out ?? t.trip.created_at);
        if (key !== month) return false;
      }
      if (!needle) return true;
      return (
        t.title.toLowerCase().includes(needle) ||
        (refs.cargoType(t.trip.cargo_type_id)?.name ?? '').toLowerCase().includes(needle)
      );
    });

    return { openWaybill, lastWaybill, openSummary, charged, paid, trips: filtered };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, month, search]);

  const vehicle = refs.vehicle(data.lastWaybill?.vehicle_id ?? null);
  const trailer = refs.vehicle(data.lastWaybill?.trailer_id ?? null);

  return (
    <div className="page">
      <header className="topbar">
        <h1>Главная</h1>
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
        <SearchBar value={search} onChange={setSearch} />

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
                <div className="li-title">{vehicle.name}</div>
                <div className="li-sub">{vehicle.plate}</div>
              </div>
              <Badge>Тягач</Badge>
            </div>
          ) : (
            <div className="muted small">Автомобиль ещё не добавлен</div>
          )}
          {trailer ? (
            <div className="row">
              <span className="avatar">
                {trailer.logo ? <img src={trailer.logo} alt="" /> : <Icon name="box" />}
              </span>
              <div className="li-main">
                <div className="li-title">{trailer.name}</div>
                <div className="li-sub">{trailer.plate}</div>
              </div>
              <Badge>Прицеп</Badge>
            </div>
          ) : null}
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

        <div className="grid-3">
          <StatCard label="Начислено" tone="ok" icon="money" value={fmtMoney(data.charged, settings.currency)} />
          <StatCard label="Оплачено" tone="info" icon="check" value={fmtMoney(data.paid, settings.currency)} />
          <StatCard
            label="Остаток"
            tone={data.charged - data.paid > 0 ? 'err' : 'ok'}
            icon="money"
            value={fmtMoney(data.charged - data.paid, settings.currency)}
          />
        </div>

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
    </div>
  );
}

export function TripCard({ summary, onOpen }: { summary: TripSummary; onOpen: () => void }) {
  const settings = useApp((s) => s.settings);
  const wb = waybillRepo.get(summary.trip.waybill_id);
  const cargo = refs.cargoType(summary.trip.cargo_type_id ?? summary.firstLoad?.cargo_type_id ?? null);
  const statusTone =
    summary.status === 'charged' ? 'ok' : summary.status === 'done' ? 'info' : 'warn';
  const statusLabel =
    summary.status === 'charged' ? 'Начислена' : summary.status === 'done' ? 'Выполнена' : 'В плане';

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
        <Badge tone="warn">К начислению · {fmtMoney(summary.amount, settings.currency)}</Badge>
      </div>
    </Card>
  );
}

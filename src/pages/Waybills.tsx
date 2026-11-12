import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Empty, MonthPicker, SearchBar, Badge, Icon } from '../ui/components';
import { useApp } from '../store';
import { refs, waybillRepo } from '../db/repo';
import { summarizeWaybill } from '../lib/calc';
import { fmtDate, fmtMoney, fmtNumber, monthKey, plural } from '../lib/format';

export default function Waybills() {
  const navigate = useNavigate();
  const revision = useApp((s) => s.revision);
  const settings = useApp((s) => s.settings);
  const [month, setMonth] = useState<string>('');
  const [search, setSearch] = useState('');

  const items = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return waybillRepo
      .list()
      .filter((wb) => {
        if (month && monthKey(wb.date_out) !== month) return false;
        if (!needle) return true;
        const vehicle = refs.vehicle(wb.vehicle_id);
        const hay = `${wb.name} ${wb.date_out} ${wb.number} ${vehicle?.name ?? ''} ${vehicle?.plate ?? ''}`;
        return hay.toLowerCase().includes(needle);
      })
      .map((wb) => summarizeWaybill(wb));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, month, search]);

  return (
    <div className="page">
      <header className="topbar">
        <h1>Путевые листы</h1>
        <div className="topbar-actions">
          <Button variant="soft" icon="plus" onClick={() => navigate('/waybills/new')} />
        </div>
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

        {items.length === 0 ? (
          <Card>
            <Empty text="Путевых листов нет" />
          </Card>
        ) : (
          <div className="stack">
            {items.map((it) => (
              <Card
                key={it.waybill.id}
                className="clickable"
                onClick={() => navigate(`/waybills/${it.waybill.id}`)}
              >
                <div className="card-head">
                  <span className="avatar">
                    <Icon name="doc" />
                  </span>
                  <div className="li-main">
                    <div className="li-title">
                      {fmtDate(it.waybill.date_out)} —{' '}
                      {it.waybill.date_in ? fmtDate(it.waybill.date_in) : 'открыт'}
                    </div>
                    <div className="li-sub">{it.periodLabel}</div>
                    <div className="li-sub">{it.vehicleTitle}</div>
                  </div>
                  <Badge tone={it.waybill.status === 'open' ? 'warn' : 'neutral'}>
                    {it.waybill.status === 'open' ? 'Открыт' : 'Закрыт'}
                  </Badge>
                </div>

                <div className="grid-2">
                  <div className="kv">
                    <div className="kv-label">Пробег</div>
                    <div className="kv-value mono">
                      {it.mileage === null ? '—' : `${fmtNumber(it.mileage)} км`}
                    </div>
                  </div>
                  <div className="kv">
                    <div className="kv-label">Заправлено</div>
                    <div className="kv-value mono">{fmtNumber(it.refueled)} л</div>
                  </div>
                  <div className="kv">
                    <div className="kv-label">Поездки</div>
                    <div className="kv-value mono">
                      {it.tripsCount} {plural(it.tripsCount, 'поездка', 'поездки', 'поездок')}
                    </div>
                  </div>
                  <div className="kv">
                    <div className="kv-label">Средний расход</div>
                    <div className="kv-value mono">
                      {it.avgConsumption === null ? '—' : `${fmtNumber(it.avgConsumption, 1)} л/100 км`}
                    </div>
                  </div>
                </div>

                <div className="divider" />
                <div className="row">
                  <Icon name="money" />
                  <span className="muted small">Начислено</span>
                  <span style={{ flex: 1 }} />
                  <b className="mono">{fmtMoney(it.charged, settings.currency)}</b>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

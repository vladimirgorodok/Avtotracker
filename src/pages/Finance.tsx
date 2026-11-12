import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Empty, Icon, MonthPicker, SearchBar, StatCard, Tabs } from '../ui/components';
import { useApp } from '../store';
import { financeRepo, refs, tripRepo } from '../db/repo';
import { fmtDate, fmtMoney, monthKey, plural } from '../lib/format';
import { summarizeFinance } from '../lib/calc';
import { FINANCE_KINDS } from '../types';

export default function Finance() {
  const navigate = useNavigate();
  const revision = useApp((s) => s.revision);
  const settings = useApp((s) => s.settings);
  const [month, setMonth] = useState(() => monthKey(new Date().toISOString()));
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<'all' | 'charge' | 'payment'>('all');

  const ops = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const base = month ? financeRepo.byMonth(month) : financeRepo.list();
    return base
      .filter((o) => (kind === 'all' ? true : o.kind === kind))
      .filter((o) => {
        if (!needle) return true;
        const trip = o.trip_id ? tripRepo.get(o.trip_id) : null;
        const wb = o.waybill_id ? refs.vehicle(null) : null;
        void wb;
        return `${o.note} ${o.amount} ${trip ? trip.amount : ''}`.toLowerCase().includes(needle);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, month, search, kind]);

  const totals = useMemo(() => summarizeFinance(month || null), [month, revision]);

  return (
    <div className="page">
      <header className="topbar">
        <h1>Финансы</h1>
        <div className="topbar-actions">
          <Button variant="soft" icon="plus" onClick={() => navigate('/finance/new')} />
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

        <div className="stack-sm">
          <StatCard label="Начислено" tone="ok" icon="money" value={fmtMoney(totals.charged, settings.currency)} />
          <StatCard label="Оплачено" tone="info" icon="check" value={fmtMoney(totals.paid, settings.currency)} />
          <StatCard
            label="Остаток"
            tone={totals.balance > 0 ? 'err' : 'ok'}
            icon="money"
            value={fmtMoney(totals.balance, settings.currency)}
          />
        </div>

        <Tabs
          value={kind}
          onChange={setKind}
          items={[
            { value: 'all', label: 'Все' },
            { value: 'charge', label: 'Начислено' },
            { value: 'payment', label: 'Оплачено' },
          ]}
        />

        <div className="row">
          <span className="small muted">
            {ops.length} {plural(ops.length, 'операция', 'операции', 'операций')} за период
          </span>
          <span style={{ flex: 1 }} />
          <Button icon="plus" variant="primary" onClick={() => navigate('/finance/new')}>
            Добавить
          </Button>
        </div>

        {ops.length === 0 ? (
          <Card>
            <Empty text="Операций нет" />
          </Card>
        ) : (
          <div className="list">
            {ops.map((o) => {
              const label = FINANCE_KINDS.find((k) => k.value === o.kind)?.label ?? '';
              const trip = o.trip_id ? tripRepo.get(o.trip_id) : null;
              const tripPoints = trip ? tripRepo.points(trip.id) : [];
              const from = refs.place(tripPoints[0]?.place_id ?? null)?.name ?? '';
              const to = refs.place(tripPoints[tripPoints.length - 1]?.place_id ?? null)?.name ?? '';
              return (
                <button key={o.id} className="list-item" onClick={() => navigate(`/finance/${o.id}`)}>
                  <span className="avatar">
                    <Icon name={o.kind === 'charge' ? 'money' : 'check'} />
                  </span>
                  <span className="li-main">
                    <span className="li-title">
                      {label} · {fmtMoney(o.amount, settings.currency)}
                    </span>
                    <span className="li-sub">
                      {fmtDate(o.date)} · {o.note || (from ? `${from} → ${to}` : 'Без описания')}
                    </span>
                  </span>
                  {o.auto ? <Icon name="ai" size={16} /> : null}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

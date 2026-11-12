import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Empty, MonthPicker, SearchBar, Tabs } from '../ui/components';
import { useApp } from '../store';
import { refs, tripRepo, waybillRepo } from '../db/repo';
import { summarizeTrip } from '../lib/calc';
import { monthKey, plural } from '../lib/format';
import { TripCard } from './Home';

type Tab = 'all' | 'planned' | 'done' | 'charged';

export default function Trips() {
  const navigate = useNavigate();
  const revision = useApp((s) => s.revision);
  const [month, setMonth] = useState<string>('');
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<Tab>('all');

  const items = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return tripRepo
      .all()
      .map(summarizeTrip)
      .filter((t) => {
        const wb = waybillRepo.get(t.trip.waybill_id);
        if (month && monthKey(wb?.date_out ?? t.trip.created_at) !== month) return false;
        if (tab !== 'all' && t.status !== tab) return false;
        if (!needle) return true;
        const cargo = refs.cargoType(t.trip.cargo_type_id)?.name ?? '';
        return (
          t.title.toLowerCase().includes(needle) ||
          cargo.toLowerCase().includes(needle) ||
          t.points.some((p) => (refs.place(p.place_id)?.name ?? '').toLowerCase().includes(needle))
        );
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, month, search, tab]);

  return (
    <div className="page">
      <header className="topbar">
        <h1>Поездки</h1>
        <div className="topbar-actions">
          <Button variant="soft" icon="plus" onClick={() => navigate('/trips/new')} />
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
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          items={[
            { value: 'all', label: 'Все' },
            { value: 'planned', label: 'В плане' },
            { value: 'done', label: 'Выполнены' },
            { value: 'charged', label: 'Начислены' },
          ]}
        />

        <div className="small muted">
          {items.length} {plural(items.length, 'перевозка', 'перевозки', 'перевозок')}
        </div>

        {items.length === 0 ? (
          <Card>
            <Empty text="Перевозок нет" action={<Button variant="primary" icon="plus" onClick={() => navigate('/trips/new')}>Добавить</Button>} />
          </Card>
        ) : (
          <div className="stack">
            {items.map((t) => (
              <TripCard key={t.trip.id} summary={t} onOpen={() => navigate(`/trips/${t.trip.id}`)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

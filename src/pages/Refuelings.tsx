import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Empty, Icon, MonthPicker, SearchBar, Tabs } from '../ui/components';
import { useApp } from '../store';
import { refs, refuelRepo } from '../db/repo';
import { fmtDateTime, fmtNumber, monthKey, plural } from '../lib/format';
import { refuelKindLabel } from '../types';

export default function Refuelings() {
  const navigate = useNavigate();
  const revision = useApp((s) => s.revision);
  const [month, setMonth] = useState('');
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<'all' | 'barrel' | 'station'>('all');

  const items = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return refuelRepo.list().filter((r) => {
      if (month && monthKey(r.date) !== month) return false;
      if (kind !== 'all' && r.kind !== kind) return false;
      if (!needle) return true;
      const station = refs.station(r.station_id)?.name ?? '';
      return `${r.note} ${station} ${r.volume}`.toLowerCase().includes(needle);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, month, search, kind]);

  const total = items.reduce((s, r) => s + r.volume, 0);

  return (
    <div className="page">
      <header className="topbar">
        <h1>Заправки</h1>
        <div className="topbar-actions">
          <Button variant="soft" icon="plus" onClick={() => navigate('/refuelings/new')} />
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
        <Tabs
          value={kind}
          onChange={setKind}
          items={[
            { value: 'all', label: 'Все' },
            { value: 'barrel', label: 'Бочка' },
            { value: 'station', label: 'АЗС' },
          ]}
        />

        <Card>
          <div className="row">
            <Icon name="fuel" />
            <b>
              {items.length} {plural(items.length, 'заправка', 'заправки', 'заправок')}
            </b>
            <span className="muted">·</span>
            <b className="mono">{fmtNumber(total)} л</b>
            <span style={{ flex: 1 }} />
            <Button icon="plus" variant="primary" onClick={() => navigate('/refuelings/new')}>
              Добавить
            </Button>
          </div>
        </Card>

        {items.length === 0 ? (
          <Card>
            <Empty text="Заправок нет" />
          </Card>
        ) : (
          <div className="list">
            {items.map((r) => {
              const station = refs.station(r.station_id);
              return (
                <button key={r.id} className="list-item" onClick={() => navigate(`/refuelings/${r.id}`)}>
                  <span className="avatar">
                    {station?.logo ? <img src={station.logo} alt="" /> : <Icon name="fuel" />}
                  </span>
                  <span className="li-main">
                    <span className="li-title">
                      {fmtNumber(r.volume)} л · {station?.name ?? refuelKindLabel(r.kind)}
                    </span>
                    <span className="li-sub">{fmtDateTime(r.date)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

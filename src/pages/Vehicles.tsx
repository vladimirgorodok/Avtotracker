import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, Empty, Icon, SearchBar, Tabs } from '../ui/components';
import { useApp } from '../store';
import { listWhere, vehicleRepo, waybillRepo } from '../db/repo';
import { fmtDate, plural } from '../lib/format';
import type { Vehicle } from '../types';

export default function Vehicles() {
  const navigate = useNavigate();
  const revision = useApp((s) => s.revision);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'active' | 'archive' | 'all'>('active');

  const items = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const base = listWhere<Vehicle>('vehicles', '1=1', [], 'kind, name');
    return base.filter((v) => {
      if (tab === 'active' && v.archived) return false;
      if (tab === 'archive' && !v.archived) return false;
      if (!needle) return true;
      return `${v.name} ${v.plate} ${v.brand} ${v.model} ${v.vin}`.toLowerCase().includes(needle);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, search, tab]);

  return (
    <div className="page">
      <header className="topbar">
        <h1>Автомобили</h1>
        <div className="topbar-actions">
          <Button variant="soft" icon="plus" onClick={() => navigate('/vehicles/new')} />
        </div>
      </header>
      <div className="page-body">
        <SearchBar value={search} onChange={setSearch} />
        <div className="row">
          <span className="small muted">
            {items.length} {plural(items.length, 'автомобиль', 'автомобиля', 'автомобилей')}
          </span>
          <span style={{ flex: 1 }} />
          <Button icon="plus" variant="primary" onClick={() => navigate('/vehicles/new')}>
            Добавить
          </Button>
        </div>
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: 'active', label: 'Активные' },
            { value: 'archive', label: 'Архив' },
            { value: 'all', label: 'Все' },
          ]}
        />

        {items.length === 0 ? (
          <Card>
            <Empty text="Автомобилей нет" />
          </Card>
        ) : (
          <div className="stack">
            {items.map((v) => {
              const periods = vehicleRepo.periods(v.id);
              const active = periods.find((p) => !p.end_date);
              const waybills = waybillRepo.list().filter((w) => w.vehicle_id === v.id);
              return (
                <Card key={v.id} className="clickable" onClick={() => navigate(`/vehicles/${v.id}`)}>
                  <div className="card-head">
                    <span className="avatar">
                      {v.logo ? <img src={v.logo} alt="" /> : <Icon name={v.kind === 'tractor' ? 'car' : 'box'} />}
                    </span>
                    <div className="li-main">
                      <div className="li-title">{v.name}</div>
                      <div className="li-sub">{v.plate || 'Без госномера'}</div>
                    </div>
                    <Badge tone={v.kind === 'tractor' ? 'info' : 'neutral'}>
                      {v.kind === 'tractor' ? 'Тягач' : 'Прицеп'}
                    </Badge>
                  </div>
                  <div className="row wrap">
                    <Badge>{periods.length} периодов</Badge>
                    {active ? (
                      <Badge tone="ok">{fmtDate(active.start_date)} — сейчас</Badge>
                    ) : (
                      <Badge tone="warn">Нет активного периода</Badge>
                    )}
                    <Badge tone="info">{waybills.length} листов</Badge>
                    {v.archived ? <Badge tone="warn">В архиве</Badge> : null}
                  </div>
                  {v.fuel_norm ? (
                    <div className="small muted">Норма расхода: {v.fuel_norm} л/100 км</div>
                  ) : null}
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

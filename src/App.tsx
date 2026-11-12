import { useCallback, useEffect, useState } from 'react';
import { HashRouter, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { getDb } from './db';
import { applyStatusBarTheme, applyTheme, useApp } from './store';
import { Icon, type IconName, Modal, Toasts } from './ui/components';
import { Splash } from './ui/Splash';
import Home from './pages/Home';
import Waybills from './pages/Waybills';
import WaybillDetail from './pages/WaybillDetail';
import Trips from './pages/Trips';
import TripDetail from './pages/TripDetail';
import Refuelings from './pages/Refuelings';
import RefuelDetail from './pages/RefuelDetail';
import Finance from './pages/Finance';
import FinanceDetail from './pages/FinanceDetail';
import Vehicles from './pages/Vehicles';
import VehicleDetail from './pages/VehicleDetail';
import Refs from './pages/Refs';
import DataPage from './pages/Data';
import SmartImport from './pages/SmartImport';
import MorePage from './pages/More';
import SettingsPage from './pages/Settings';
import Assistant from './pages/Assistant';
import OrderFromFiles from './pages/OrderFromFiles';
import { seedIfEmpty } from './db/seed';
import { insertRow, uid, waybillRepo } from './db/repo';
import { todayIso } from './lib/format';
import { autoFillForNewWaybill } from './lib/calc';

function BottomNav({ onCreate }: { onCreate: () => void }) {
  const loc = useLocation();
  const items: { to: string; label: string; icon: IconName }[] = [
    { to: '/', label: 'Главная', icon: 'home' },
    { to: '/waybills', label: 'Листы', icon: 'doc' },
    { to: '/trips', label: 'Поездки', icon: 'route' },
    { to: '/more', label: 'Ещё', icon: 'menu' },
  ];
  return (
    <>
      <button className="fab" onClick={onCreate} aria-label="Добавить">
        <Icon name="plus" size={26} />
      </button>
      <nav className="bottom-nav">
        {items.map((it, idx) => (
          <NavLink
            key={it.to}
            to={it.to}
            className={({ isActive }) =>
              `nav-item ${idx === 2 ? 'center' : ''} ${
                isActive && (it.to !== '/' || loc.pathname === '/') ? 'active' : ''
              }`
            }
          >
            <Icon name={it.icon} size={22} />
            <span>{it.label}</span>
          </NavLink>
        ))}
      </nav>
    </>
  );
}

function CreateSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const touch = useApp((s) => s.touch);
  const notify = useApp((s) => s.notify);
  const settings = useApp((s) => s.settings);

  function newWaybill() {
    const pre = autoFillForNewWaybill(settings.last_vehicle_id || null);
    const id = uid();
    const today = todayIso();
    insertRow('waybills', {
      id,
      number: '',
      name: `${today} — открыт`,
      date_out: today,
      odometer_out: pre.odometer_out,
      fuel_out: pre.fuel_out,
      vehicle_id: pre.vehicle_id,
      trailer_id: pre.trailer_id,
      status: 'open',
    });
    touch();
    onClose();
    navigate(`/waybills/${id}`);
  }

  function newTrip() {
    const id = uid();
    const openWaybill = waybillRepo.open()[0] ?? null;
    insertRow('trips', {
      id,
      waybill_id: openWaybill?.id ?? '',
      amount: settings.base_amount,
      cargo_type_id: null,
      weight: null,
      note: '',
      status: 'planned',
    });
    touch();
    onClose();
    navigate(`/trips/${id}`);
  }

  function newRefuel() {
    const id = uid();
    const openWaybill = waybillRepo.open()[0] ?? null;
    insertRow('refuelings', {
      id,
      waybill_id: openWaybill?.id ?? '',
      date: new Date().toISOString(),
      volume: 0,
      kind: 'barrel',
      station_id: null,
      note: '',
    });
    touch();
    onClose();
    navigate(`/refuelings/${id}`);
  }

  function newFinance() {
    const id = uid();
    insertRow('finance_ops', {
      id,
      date: todayIso(),
      kind: 'payment',
      amount: 0,
      pay_month: todayIso().slice(0, 7),
      note: '',
      auto: 0,
    });
    touch();
    onClose();
    navigate(`/finance/${id}`);
  }

  function newPlace() {
    notify('Справочники открыты', 'info');
    onClose();
    navigate('/refs?tab=places&new=1');
  }

  return (
    <Modal open={open} title="Что добавить" onClose={onClose}>
      <div className="list">
        <button className="list-item" onClick={newWaybill}>
          <span className="avatar">
            <Icon name="doc" />
          </span>
          <span className="li-main">
            <span className="li-title">Путевой лист</span>
            <span className="li-sub">Дата выезда, одометр, топливо</span>
          </span>
        </button>
        <button className="list-item" onClick={newTrip}>
          <span className="avatar">
            <Icon name="route" />
          </span>
          <span className="li-main">
            <span className="li-title">Перевозка</span>
            <span className="li-sub">Маршрут из точек погрузки и выгрузки</span>
          </span>
        </button>
        <button className="list-item" onClick={newRefuel}>
          <span className="avatar">
            <Icon name="fuel" />
          </span>
          <span className="li-main">
            <span className="li-title">Заправка</span>
            <span className="li-sub">Бочка или АЗС</span>
          </span>
        </button>
        <button className="list-item" onClick={newFinance}>
          <span className="avatar">
            <Icon name="money" />
          </span>
          <span className="li-main">
            <span className="li-title">Финансовая операция</span>
            <span className="li-sub">Поступило или начислено</span>
          </span>
        </button>
        <button className="list-item" onClick={newPlace}>
          <span className="avatar">
            <Icon name="pin" />
          </span>
          <span className="li-main">
            <span className="li-title">Место в справочник</span>
            <span className="li-sub">Адрес, координаты, контакт</span>
          </span>
        </button>
      </div>
    </Modal>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [splashDone, setSplashDone] = useState(false);
  const init = useApp((s) => s.init);
  const settings = useApp((s) => s.settings);
  const finishSplash = useCallback(() => setSplashDone(true), []);

  useEffect(() => {
    (async () => {
      try {
        const db = await getDb();
        seedIfEmpty();
        init();
        await db.flush();
        setReady(true);
      } catch (e) {
        console.error(e);
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [init]);

  useEffect(() => {
    if (!ready) return;
    applyTheme(settings.theme, settings.palette);
    // Пока идёт заставка, значки в строке состояния светлые под её тёмный фон
    if (splashDone) applyStatusBarTheme(settings.theme);
  }, [ready, splashDone, settings.theme, settings.palette]);

  useEffect(() => {
    const onHide = () => {
      void getDb().then((db) => db.flush());
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') onHide();
    });
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);

  if (error) {
    return (
      <div className="page-body">
        <div className="alert alert-err">
          <Icon name="warning" />
          <div>
            <b>Не удалось открыть базу данных</b>
            <div className="small">{error}</div>
          </div>
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="empty">
        <span className="muted">Готовим базу данных…</span>
      </div>
    );
  }

  return (
    <>
      {ready ? (
        <HashRouter>
          <div className="app-shell">
            <Routes>
              <Route path="/" element={<Home onCreate={() => setCreateOpen(true)} />} />
              <Route path="/waybills" element={<Waybills />} />
              <Route path="/waybills/:id" element={<WaybillDetail />} />
              <Route path="/trips" element={<Trips />} />
              <Route path="/trips/:id" element={<TripDetail />} />
              <Route path="/refuelings" element={<Refuelings />} />
              <Route path="/refuelings/:id" element={<RefuelDetail />} />
              <Route path="/finance" element={<Finance />} />
              <Route path="/finance/:id" element={<FinanceDetail />} />
              <Route path="/vehicles" element={<Vehicles />} />
              <Route path="/vehicles/:id" element={<VehicleDetail />} />
              <Route path="/refs" element={<Refs />} />
              <Route path="/data" element={<DataPage />} />
              <Route path="/data/smart" element={<SmartImport />} />
              <Route path="/more" element={<MorePage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/assistant" element={<Assistant />} />
              <Route path="/assistant/order" element={<OrderFromFiles />} />
            </Routes>
            <BottomNav onCreate={() => setCreateOpen(true)} />
            <CreateSheet open={createOpen} onClose={() => setCreateOpen(false)} />
            <Toasts />
          </div>
        </HashRouter>
      ) : (
        <div className="empty">
          <span className="muted">Готовим базу данных…</span>
        </div>
      )}
      {!splashDone && <Splash onDone={finishSplash} />}
    </>
  );
}

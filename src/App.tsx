import { useCallback, useEffect, useState } from 'react';
import { HashRouter, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { getDb, setSaveErrorHandler } from './db';
import { applyStatusBarTheme, applyTheme, applyViewMode, useApp } from './store';
import { Confirm, Icon, type IconName, Modal, Toasts } from './ui/components';
import { Splash } from './ui/Splash';
import { ExitScreen } from './ui/ExitScreen';
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
import MorePage from './pages/More';
import SettingsPage from './pages/Settings';
import YandexDisk from './pages/YandexDisk';
import Assistant from './pages/Assistant';
import OrderFromFiles from './pages/OrderFromFiles';
import PictureFinder from './pages/PictureFinder';
import Search from './pages/Search';
import { seedIfEmpty } from './db/seed';
import { insertRow, uid, waybillRepo } from './db/repo';
import { todayIso } from './lib/format';
import { autoFillForNewWaybill } from './lib/calc';
import { startAutoSync } from './lib/yadisk-auto';

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

/**
 * Системная кнопка «Назад».
 *
 * На внутренних экранах — обычный возврат, а на главной она предлагает закрыть
 * приложение: выход идёт через сохранение, поэтому случайное нажатие ничего не теряет.
 */
function BackExit({ onExit }: { onExit: () => void }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const handle = CapApp.addListener('backButton', () => {
      if (pathname !== '/') navigate(-1);
      else onExit();
    });
    return () => {
      void handle.then((h) => h.remove());
    };
  }, [pathname, navigate, onExit]);

  return null;
}

function CreateSheet({
  open,
  onClose,
  onExit,
}: {
  open: boolean;
  onClose: () => void;
  onExit: () => void;
}) {
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
    <Modal open={open} title="Что сделать" onClose={onClose}>
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
        <div className="divider" />
        <button className="list-item" onClick={onExit}>
          <span className="avatar">
            <Icon name="power" />
          </span>
          <span className="li-main">
            <span className="li-title">Закрыть приложение</span>
            <span className="li-sub">Сохранение, обмен с облаком, выход</span>
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
  const [exitOpen, setExitOpen] = useState(false);
  const [askExit, setAskExit] = useState(false);
  const [splashDone, setSplashDone] = useState(false);
  const init = useApp((s) => s.init);
  const settings = useApp((s) => s.settings);
  const dataWarning = useApp((s) => s.dataWarning);
  const finishSplash = useCallback(() => setSplashDone(true), []);
  const openExit = useCallback(() => {
    setCreateOpen(false);
    setAskExit(false);
    setExitOpen(true);
  }, []);
  /** «Назад» на главной: если открыт экран закрытия — возвращаемся, иначе спрашиваем */
  const backFromRoot = useCallback(() => {
    if (exitOpen) setExitOpen(false);
    else setAskExit(true);
  }, [exitOpen]);

  useEffect(() => {
    (async () => {
      try {
        const db = await getDb();
        seedIfEmpty();
        init();
        const problem = db.loadProblem();
        if (problem) {
          // Базу не прочитали: пустую базу поверх файла не пишем
          useApp.getState().setDataWarning(problem);
          useApp.getState().notify('База на устройстве не читается — данные не перезаписываем', 'err');
        } else {
          await db.flush();
        }
        setReady(true);
      } catch (e) {
        console.error(e);
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [init]);

  useEffect(() => {
    // Если базу не удалось записать, об этом надо сказать, а не молчать
    setSaveErrorHandler((e) => {
      useApp.getState().notify(
        `Не удалось сохранить базу: ${e instanceof Error ? e.message : String(e)}`,
        'err',
      );
    });
    return () => setSaveErrorHandler(null);
  }, []);

  useEffect(() => {
    if (!ready) return;
    applyTheme(settings.theme, settings.palette);
    // Пока идёт заставка, значки в строке состояния светлые под её тёмный фон
    if (splashDone) applyStatusBarTheme(settings.theme);
  }, [ready, splashDone, settings.theme, settings.palette]);

  useEffect(() => {
    // Вид для планшета: в «авто» подбирается по размеру экрана — следим за поворотом
    if (!ready) return;
    applyViewMode(settings.view_mode);
    if (settings.view_mode !== 'auto') return;
    const onResize = () => applyViewMode('auto');
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, [ready, settings.view_mode]);

  useEffect(() => {
    // Обмен с Яндекс Диском: следим за изменениями и сверяемся при запуске
    if (!ready) return;
    startAutoSync();
  }, [ready]);

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
            {dataWarning ? (
              <div className="alert alert-err shell-alert">
                <Icon name="warning" />
                <div>
                  <b>База на устройстве не читается</b>
                  <div className="small">{dataWarning}</div>
                  <div className="small">
                    Файл мы не перезаписываем, поэтому данные на месте. Откройте «Ещё → Обмен
                    данными»: там можно вернуть копию, импортировать свою резервную копию или
                    продолжить с пустой базой.
                  </div>
                </div>
              </div>
            ) : null}
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
              <Route path="/more" element={<MorePage />} />
              <Route path="/search" element={<Search />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/yadisk" element={<YandexDisk />} />
              <Route path="/assistant" element={<Assistant />} />
              <Route path="/assistant/order" element={<OrderFromFiles />} />
              <Route path="/assistant/pictures" element={<PictureFinder />} />
            </Routes>
            <BottomNav onCreate={() => setCreateOpen(true)} />
            <CreateSheet
              open={createOpen}
              onClose={() => setCreateOpen(false)}
              onExit={openExit}
            />
            <BackExit onExit={backFromRoot} />
            <Confirm
              open={askExit}
              title="Закрыть приложение?"
              text="Перед выходом сохраним базу на устройстве и, если есть изменения, выгрузим их в облако."
              confirmLabel="Закрыть"
              onCancel={() => setAskExit(false)}
              onConfirm={openExit}
            />
            <Toasts />
          </div>
        </HashRouter>
      ) : (
        <div className="empty">
          <span className="muted">Готовим базу данных…</span>
        </div>
      )}
      {!splashDone && <Splash onDone={finishSplash} />}
      {exitOpen && <ExitScreen onCancel={() => setExitOpen(false)} />}
    </>
  );
}

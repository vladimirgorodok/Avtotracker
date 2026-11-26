import { useCallback, useEffect, useState } from 'react';
import { HashRouter, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { getDb, setSaveErrorHandler } from './db';
import { applyStatusBarTheme, applyTheme, applyViewMode, useApp } from './store';
import { Confirm, Icon, type IconName, Modal, Toasts } from './ui/components';
import { QuickMoneyModal, QuickRefuelModal } from './ui/QuickActions';
import { Splash } from './ui/Splash';
import { StartScreen } from './ui/StartScreen';
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
import Audit from './pages/Audit';
import YandexDisk from './pages/YandexDisk';
import Assistant from './pages/Assistant';
import OrderFromFiles from './pages/OrderFromFiles';
import PictureFinder from './pages/PictureFinder';
import Search from './pages/Search';
import UpdatePage from './pages/Update';
import { seedIfEmpty } from './db/seed';
import { insertRow, uid, waybillRepo } from './db/repo';
import { prevMonthKey, todayIso } from './lib/format';
import { autoFillForNewWaybill, sameWaybill } from './lib/calc';
import { autoSyncWanted, startAutoSync } from './lib/yadisk-auto';
import { checkUpdateQuietly } from './lib/update';

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
  onQuickRefuel,
  onQuickMoney,
}: {
  open: boolean;
  onClose: () => void;
  onExit: () => void;
  onQuickRefuel: () => void;
  onQuickMoney: () => void;
}) {
  const navigate = useNavigate();
  const touch = useApp((s) => s.touch);
  const notify = useApp((s) => s.notify);
  const settings = useApp((s) => s.settings);

  function newWaybill() {
    const pre = autoFillForNewWaybill(settings.last_vehicle_id || null);
    const today = todayIso();
    // Лист на этот день уже открыт — открываем его, а не заводим второй
    const twin = sameWaybill({ date_out: today, status: 'open', vehicle_id: pre.vehicle_id, date_in: null });
    if (twin) {
      notify('Путевой лист на сегодня уже открыт', 'info');
      onClose();
      navigate(`/waybills/${twin.id}`);
      return;
    }
    const id = uid();
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

  function newFinance() {
    const id = uid();
    insertRow('finance_ops', {
      id,
      date: todayIso(),
      kind: 'payment',
      amount: 0,
      // Деньги обычно приходят за прошлый месяц — его и подставляем
      pay_month: prevMonthKey(),
      note: '',
      auto: 0,
      family: 0,
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
    <Modal open={open} title="Действие" onClose={onClose}>
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
        <button className="list-item" onClick={onQuickRefuel}>
          <span className="avatar">
            <Icon name="fuel" />
          </span>
          <span className="li-main">
            <span className="li-title">Заправился</span>
            <span className="li-sub">Быстро: только объём, источник как в прошлый раз</span>
          </span>
        </button>
        <button className="list-item" onClick={onQuickMoney}>
          <span className="avatar">
            <Icon name="money" />
          </span>
          <span className="li-main">
            <span className="li-title">Пришли деньги</span>
            <span className="li-sub">Быстро: сумма и отчисление в семью</span>
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
  const [quick, setQuick] = useState<'refuel' | 'money' | null>(null);
  const [exitOpen, setExitOpen] = useState(false);
  const [askExit, setAskExit] = useState(false);
  const [splashDone, setSplashDone] = useState(false);
  // Окно обмена при запуске: ждём конца заставки, затем показываем или пропускаем
  const [startPhase, setStartPhase] = useState<'wait' | 'show' | 'done'>('wait');
  const init = useApp((s) => s.init);
  const settings = useApp((s) => s.settings);
  const dataWarning = useApp((s) => s.dataWarning);
  const finishSplash = useCallback(() => {
    setSplashDone(true);
    // Обмениваться нечем, если облако не настроено или автобмен выключен
    setStartPhase(autoSyncWanted() ? 'show' : 'done');
  }, []);
  const finishStart = useCallback(() => setStartPhase('done'), []);
  const openExit = useCallback(() => {
    setCreateOpen(false);
    setAskExit(false);
    setExitOpen(true);
  }, []);
  /** «Назад» на главной: если открыт экран закрытия — возвращаемся, иначе спрашиваем */
  const backFromRoot = useCallback(() => {
    // Пока идёт обмен при запуске, «Назад» ничего не делает
    if (startPhase === 'show') return;
    if (exitOpen) setExitOpen(false);
    else setAskExit(true);
  }, [exitOpen, startPhase]);

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
    // Пока идут тёмные заставка и окно обмена, значки в строке состояния светлые
    if (splashDone && startPhase !== 'show') applyStatusBarTheme(settings.theme);
  }, [ready, splashDone, startPhase, settings.theme, settings.palette]);

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
    // Проверка обновлений при запуске: тихо, не чаще раза в сутки.
    // Ждём конца заставки и окна обмена — иначе весточку о новой версии
    // закрыли бы собой заставка или окно обмена.
    if (!ready || !splashDone || startPhase === 'show') return;
    void checkUpdateQuietly();
  }, [ready, splashDone, startPhase]);

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
              <Route path="/update" element={<UpdatePage />} />
              <Route path="/audit" element={<Audit />} />
              <Route path="/assistant" element={<Assistant />} />
              <Route path="/assistant/order" element={<OrderFromFiles />} />
              <Route path="/assistant/pictures" element={<PictureFinder />} />
            </Routes>
            <BottomNav onCreate={() => setCreateOpen(true)} />
            <CreateSheet
              open={createOpen}
              onClose={() => setCreateOpen(false)}
              onExit={openExit}
              onQuickRefuel={() => {
                setCreateOpen(false);
                setQuick('refuel');
              }}
              onQuickMoney={() => {
                setCreateOpen(false);
                setQuick('money');
              }}
            />
            <QuickRefuelModal open={quick === 'refuel'} onClose={() => setQuick(null)} />
            <QuickMoneyModal open={quick === 'money'} onClose={() => setQuick(null)} />
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
      {startPhase === 'show' ? <StartScreen onDone={finishStart} /> : null}
      {exitOpen && <ExitScreen onCancel={() => setExitOpen(false)} />}
    </>
  );
}

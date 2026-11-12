import { useNavigate } from 'react-router-dom';
import { Card, Icon, type IconName, Page } from '../ui/components';
import { useApp } from '../store';
import { countRows } from '../db/repo';
import { syncState } from '../lib/sync';

function syncSub(): string {
  const s = syncState();
  if (!s.configured) return 'Не настроена · данные только на телефоне';
  if (!s.signedIn) return 'Нужно войти в облако';
  return s.pending > 0 ? `Ожидают отправки: ${s.pending}` : 'Всё отправлено в облако';
}

export default function MorePage() {
  const navigate = useNavigate();
  const revision = useApp((s) => s.revision);

  const items: { to: string; title: string; sub: string; icon: IconName }[] = [
    { to: '/waybills', title: 'Путевые листы', sub: `${countRows('waybills')} записей`, icon: 'doc' },
    { to: '/trips', title: 'Поездки', sub: `${countRows('trips')} перевозок`, icon: 'route' },
    { to: '/refuelings', title: 'Заправки', sub: `${countRows('refuelings')} записей`, icon: 'fuel' },
    { to: '/finance', title: 'Финансы', sub: `${countRows('finance_ops')} операций`, icon: 'money' },
    { to: '/vehicles', title: 'Автомобили', sub: `${countRows('vehicles')} единиц техники`, icon: 'car' },
    { to: '/refs', title: 'Справочники', sub: 'Фирмы, места, грузы, АЗС', icon: 'pin' },
    {
      to: '/settings',
      title: 'Облачная синхронизация',
      sub: syncSub(),
      icon: 'refresh',
    },
    { to: '/data', title: 'Обмен данными', sub: 'Экспорт, импорт, резервные копии', icon: 'share' },
    { to: '/assistant', title: 'ИИ-помощник', sub: 'Разбор заявок и расчёты', icon: 'ai' },
    { to: '/settings', title: 'Настройки', sub: 'Ставки, тема, синхронизация', icon: 'settings' },
  ];

  return (
    <Page title="Ещё">
      <div className="list" key={revision}>
        {items.map((it) => (
          <button key={it.to} className="list-item" onClick={() => navigate(it.to)}>
            <span className="avatar">
              <Icon name={it.icon} />
            </span>
            <span className="li-main">
              <span className="li-title">{it.title}</span>
              <span className="li-sub">{it.sub}</span>
            </span>
            <Icon name="nav" />
          </button>
        ))}
      </div>

      <Card>
        <div className="small muted">
          АвтоБаза — учёт путевых листов, перевозок, топлива и расчётов. Данные хранятся на телефоне и
          работают без интернета.
        </div>
      </Card>
    </Page>
  );
}

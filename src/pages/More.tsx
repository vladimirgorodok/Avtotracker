import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Icon, Tabs, type IconName, Page } from '../ui/components';
import { useApp } from '../store';
import { countRows } from '../db/repo';
import { auditSummary } from '../lib/audit';
import { cloudState } from '../lib/yadisk';
import { fmtDateTime } from '../lib/format';

function diskSub(): string {
  const s = cloudState();
  if (!s.configured) return 'Не настроен · данные и значки только на телефоне';
  if (s.dirty) return 'Есть невыгруженные изменения';
  return s.lastAt ? `Последний обмен: ${fmtDateTime(s.lastAt)}` : 'Готов к обмену';
}

type MoreTab = 'data' | 'services';

/** Разделы экрана «Ещё»: сверху — записи учёта, снизу — справочники и сервисы */
const TABS: { id: MoreTab; label: string; hint: string }[] = [
  {
    id: 'data',
    label: 'Данные',
    hint: 'Поиск по всему, путевые листы, поездки, заправки, финансы, техника и справочники',
  },
  { id: 'services', label: 'Сервисы', hint: 'Яндекс Диск, обмен данными, помощник, значки и настройки' },
];

export default function MorePage() {
  const navigate = useNavigate();
  const revision = useApp((s) => s.revision);
  const [tab, setTab] = useState<MoreTab>('data');
  // Проверка данных — дело небыстрое, поэтому считаем её только при изменениях
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const auditSub = useMemo(() => auditSummary(), [revision]);

  const dataItems: { to: string; title: string; sub: string; icon: IconName }[] = [
    { to: '/search', title: 'Поиск по всему', sub: 'Найти запись в любом разделе', icon: 'search' },
    { to: '/waybills', title: 'Путевые листы', sub: `${countRows('waybills')} записей`, icon: 'doc' },
    { to: '/trips', title: 'Поездки', sub: `${countRows('trips')} перевозок`, icon: 'route' },
    { to: '/refuelings', title: 'Заправки', sub: `${countRows('refuelings')} записей`, icon: 'fuel' },
    { to: '/finance', title: 'Финансы', sub: `${countRows('finance_ops')} операций`, icon: 'money' },
    { to: '/vehicles', title: 'Автомобили', sub: `${countRows('vehicles')} единиц техники`, icon: 'car' },
    { to: '/refs', title: 'Справочники', sub: 'Фирмы, места, грузы, АЗС', icon: 'pin' },
  ];

  const serviceItems: { to: string; title: string; sub: string; icon: IconName }[] = [
    { to: '/yadisk', title: 'Яндекс Диск', sub: diskSub(), icon: 'upload' },
    { to: '/update', title: 'Обновление', sub: 'Проверить новую версию на GitHub', icon: 'download' },
    { to: '/data', title: 'Обмен данными', sub: 'Экспорт, импорт, резервные копии', icon: 'share' },
    { to: '/audit', title: 'Проверка данных', sub: auditSub, icon: 'check' },
    { to: '/assistant', title: 'ИИ-помощник', sub: 'Разбор заявок и расчёты', icon: 'ai' },
    { to: '/assistant/pictures', title: 'Значки и логотипы', sub: 'Подбор картинок по названию', icon: 'search' },
    { to: '/settings', title: 'Настройки', sub: 'Ставки, тема, оформление', icon: 'settings' },
  ];

  const items = tab === 'data' ? dataItems : serviceItems;
  const current = TABS.find((t) => t.id === tab) ?? TABS[0]!;

  return (
    <Page title="Ещё">
      <Tabs<MoreTab>
        value={tab}
        onChange={setTab}
        items={TABS.map((t) => ({ value: t.id, label: t.label }))}
      />
      <div className="small muted">{current.hint}</div>

      <div className="list" key={`${tab}-${revision}`}>
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

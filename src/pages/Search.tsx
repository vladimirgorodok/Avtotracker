/**
 * Поиск по всей базе: находки собраны в список по разделам, по каждой можно
 * сразу перейти в карточку записи.
 */

import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Card, Empty, Icon, type IconName, Page, SearchBar } from '../ui/components';
import { useApp } from '../store';
import { SEARCH_KINDS, globalSearch, type SearchKind } from '../lib/search';
import { plural } from '../lib/format';

/** Значок раздела, когда у записи нет своей картинки */
const KIND_ICONS: Record<SearchKind, IconName> = {
  waybill: 'doc',
  trip: 'route',
  refueling: 'fuel',
  finance: 'money',
  vehicle: 'car',
  company: 'box',
  place: 'pin',
  cargo: 'box',
  station: 'fuel',
};

export default function Search() {
  const navigate = useNavigate();
  const revision = useApp((s) => s.revision);
  // Запрос держим в адресе: вернувшись из карточки, человек увидит прежние находки
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';

  // Находки пересобираем и после правок в данных
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const result = useMemo(() => globalSearch(query), [revision, query]);
  const groups = useMemo(
    () =>
      SEARCH_KINDS.map((k) => ({
        ...k,
        total: result.byKind[k.kind],
        hits: result.hits.filter((h) => h.kind === k.kind),
      })).filter((g) => g.hits.length > 0),
    [result],
  );

  const needle = query.trim();

  return (
    <Page title="Поиск по всему" onBack={() => navigate(-1)}>
      <SearchBar
        value={query}
        onChange={(v) => setParams(v ? { q: v } : {}, { replace: true })}
        autoFocus
      />

      {needle === '' ? (
        <Card>
          <div className="small muted">
            Начните вводить — искать будем сразу везде: номер путевого листа, машина и её номер, фирма, место и
            адрес, груз, АЗС, сумма, дата или заметка. Найденное покажем списком по разделам, нажмите на строку —
            откроется карточка записи.
          </div>
        </Card>
      ) : result.total === 0 ? (
        <Card>
          <Empty text="Ничего не найдено" />
        </Card>
      ) : (
        <>
          <div className="row">
            <Icon name="search" />
            <span className="small muted">
              {result.total} {plural(result.total, 'находка', 'находки', 'находок')} в{' '}
              {groups.length} {plural(groups.length, 'разделе', 'разделах', 'разделах')}
            </span>
          </div>

          {groups.map((g) => (
            <div className="stack-sm" key={g.kind}>
              <div className="row">
                <span className="li-title">{g.label}</span>
                <span style={{ flex: 1 }} />
                <span className="small muted">{g.total}</span>
              </div>
              <div className="list">
                {g.hits.map((h) => (
                  <button
                    key={`${h.kind}:${h.id}`}
                    className="list-item"
                    onClick={() => navigate(h.to)}
                  >
                    <span className="avatar">
                      {h.logo ? <img src={h.logo} alt="" /> : <Icon name={KIND_ICONS[h.kind]} />}
                    </span>
                    <span className="li-main">
                      <span className="li-title">{h.title}</span>
                      <span className="li-sub">{h.sub}</span>
                    </span>
                    <Icon name="nav" />
                  </button>
                ))}
              </div>
              {g.total > g.hits.length ? (
                <div className="small muted">
                  Показаны первые {g.hits.length} из {g.total} — уточните запрос, чтобы сузить поиск.
                </div>
              ) : null}
            </div>
          ))}
        </>
      )}
    </Page>
  );
}

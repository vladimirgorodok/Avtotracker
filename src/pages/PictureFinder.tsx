/**
 * Экран «Значки и логотипы»: подбор картинки по названию.
 *
 * Можно выбрать, куда её поставить (фирма, груз, АЗС, автомобиль) — тогда картинка
 * сразу сохраняется в справочнике, — или просто найти картинку и сохранить её файлом.
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, Field, Icon, Page, Select } from '../ui/components';
import { PictureSearch } from '../ui/PictureSearch';
import { useApp } from '../store';
import { refs, updateRow } from '../db/repo';
import { saveBinaryFile } from '../db/storage';
import { dataUrlToBytes } from '../lib/files';
import { PICTURE_KINDS, kindLabel, type PictureHit, type PictureKind } from '../lib/pictures';
import type { TableName } from '../types';

/** Где лежат картинки: таблица, поле и как показать запись */
const TARGETS: Record<PictureKind, { table: TableName; field: string; title: string }> = {
  company: { table: 'companies', field: 'logo', title: 'Фирма' },
  cargo: { table: 'cargo_types', field: 'icon', title: 'Груз' },
  station: { table: 'fuel_stations', field: 'logo', title: 'АЗС' },
  vehicle: { table: 'vehicles', field: 'logo', title: 'Автомобиль' },
};

interface Target {
  id: string;
  name: string;
  hasPicture: boolean;
  /** Уже сохранённая картинка записи — показываем её в списке выбора */
  picture: string;
}

function fileStamp(): string {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
}

export default function PictureFinder() {
  const navigate = useNavigate();
  const notify = useApp((s) => s.notify);
  const touch = useApp((s) => s.touch);
  const revision = useApp((s) => s.revision);
  const [kind, setKind] = useState<PictureKind>('company');
  const [targetId, setTargetId] = useState<string | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const targets = useMemo<Target[]>(() => {
    if (kind === 'company') {
      return refs.companies().map((c) => ({ id: c.id, name: c.name, hasPicture: c.logo !== '', picture: c.logo }));
    }
    if (kind === 'cargo') {
      return refs.cargoTypes().map((c) => ({ id: c.id, name: c.name, hasPicture: c.icon !== '', picture: c.icon }));
    }
    if (kind === 'station') {
      return refs.fuelStations().map((s) => ({ id: s.id, name: s.name, hasPicture: s.logo !== '', picture: s.logo }));
    }
    return refs.vehicles().map((v) => ({
      id: v.id,
      name: `${v.name}${v.plate ? ` (${v.plate})` : ''}`,
      hasPicture: v.logo !== '',
      picture: v.logo,
    }));
  }, [kind, revision]);

  const target = targets.find((t) => t.id === targetId) ?? null;
  const searchName = target ? target.name : '';

  function apply(value: string, hit: PictureHit) {
    if (!target) {
      const parsed = dataUrlToBytes(value);
      if (!parsed) {
        notify('Ссылка на картинку сохранена в буфер обмена', 'info');
        void navigator.clipboard?.writeText(value).catch(() => undefined);
        return;
      }
      void saveBinaryFile(`картинка-${fileStamp()}.png`, parsed.bytes, parsed.mime)
        .then(() => notify('Картинка сохранена файлом', 'ok'))
        .catch(() => notify('Не удалось сохранить картинку', 'err'));
      return;
    }
    updateRow(TARGETS[kind].table, target.id, { [TARGETS[kind].field]: value });
    touch();
    notify(`Картинка поставлена: ${target.name} (${hit.source})`, 'ok');
    setTargetId(null);
  }

  return (
    <Page title="Значки и логотипы" onBack={() => navigate('/assistant')}>
      <Card
        title="Куда поставить"
        actions={<Badge tone="info">{kindLabel(kind)}</Badge>}
      >
        <div className="small muted">
          Выберите запись — картинка сохранится прямо в справочнике. Если ничего не выбирать, найденную
          картинку можно сохранить файлом.
        </div>
        <Field label="Вид записи">
          <Select
            value={kind}
            onChange={(v) => {
              setKind((v ?? 'company') as PictureKind);
              setTargetId(null);
            }}
            options={PICTURE_KINDS.map((k) => ({ value: k.value, label: `${k.label} — ${k.hint}` }))}
          />
        </Field>
        <Field label={TARGETS[kind].title} hint="записи без картинки помечены">
          <Select
            value={targetId}
            onChange={setTargetId}
            placeholder="Ничего не выбирать"
            options={targets.map((t) => ({
              value: t.id,
              label: `${t.name}${t.hasPicture ? '' : ' — без картинки'}`,
              logo: t.picture,
            }))}
          />
        </Field>
        {target ? (
          <div className="row">
            <span className="avatar" style={{ width: 56, height: 56 }}>
              {target.picture ? <img src={target.picture} alt="" /> : <Icon name="box" size={24} />}
            </span>
            <div className="li-main">
              <div className="li-title">{target.name}</div>
              <div className="li-sub">
                {target.hasPicture
                  ? 'Сейчас стоит эта картинка — новая её заменит'
                  : 'Картинки пока нет — выбранная встанет на это место'}
              </div>
            </div>
          </div>
        ) : null}
        {targets.length === 0 ? (
          <div className="small muted">Записей этого вида пока нет — сначала заведите их в справочнике.</div>
        ) : null}
        <div className="row">
          <Button icon="ai" onClick={() => navigate('/assistant')}>
            ИИ-помощник
          </Button>
          <Button icon="pin" onClick={() => navigate('/refs')}>
            Справочники
          </Button>
        </div>
      </Card>

      <Card
        title="Поиск картинки"
        actions={
          <Badge tone="neutral">
            <Icon name="search" size={14} /> {searchName || 'по названию'}
          </Badge>
        }
      >
        <PictureSearch
          key={`${kind}:${target?.id ?? 'free'}`}
          initialName={searchName}
          initialKind={kind}
          showKind={false}
          current={target?.picture ?? ''}
          onPick={apply}
        />
      </Card>

      <Card title="Как это работает">
        <div className="small muted">
          Поиск идёт по открытым источникам без ключей и аккаунтов: наборы значков Iconify (в том числе
          фирменные логотипы), Викисклад — настоящие логотипы и фотографии, а при известном адресе фирмы —
          значки её сайта. ИИ-помощник, если он настроен, готовит варианты названия: убирает и добавляет
          «ООО», «АО» и подобные формы, пишет название латиницей и подсказывает адрес сайта. Без ключа
          поиск тоже работает — по названию как есть.
        </div>
      </Card>
    </Page>
  );
}

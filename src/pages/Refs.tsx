import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Button,
  Card,
  Confirm,
  Empty,
  Field,
  Icon,
  Modal,
  Page,
  SearchBar,
  Select,
  Tabs,
  TextInput,
} from '../ui/components';
import { useApp } from '../store';
import { countRows, insertRow, refs, softDelete, uid, updateRow } from '../db/repo';
import { PicturePicker } from '../ui/PictureSearch';
import { fmtCoords, parseCoords } from '../lib/format';
import { LOAD_TYPES, type CargoType, type Company, type FuelStation, type Place } from '../types';
import type { PictureKind } from '../lib/pictures';
import { listAll } from '../db/repo';

type Tab = 'companies' | 'places' | 'cargo' | 'stations';

export default function Refs() {
  const [params, setParams] = useSearchParams();
  const revision = useApp((s) => s.revision);
  const touch = useApp((s) => s.touch);
  const notify = useApp((s) => s.notify);

  const [tab, setTab] = useState<Tab>((params.get('tab') as Tab) || 'companies');
  const [search, setSearch] = useState('');
  const [editor, setEditor] = useState<{ kind: Tab; id: string | null } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: Tab; id: string } | null>(null);
  /** Подбор картинки помощником: окно открывает родитель, чтобы не прятать его внутрь карточки */
  const [pictureRequest, setPictureRequest] = useState<PictureRequest | null>(null);

  useEffect(() => {
    if (params.get('new') === '1') {
      setEditor({ kind: tab, id: null });
      const next = new URLSearchParams(params);
      next.delete('new');
      setParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const companies = useMemo(() => refs.companies(), [revision]);
  const places = useMemo(() => refs.places(), [revision]);
  const cargo = useMemo(() => refs.cargoTypes(), [revision]);
  const stations = useMemo(() => refs.fuelStations(), [revision]);

  const needle = search.trim().toLowerCase();
  const visibleCompanies = companies.filter((c) => c.name.toLowerCase().includes(needle));
  const visiblePlaces = places.filter((p) => {
    const company = refs.company(p.company_id)?.name ?? '';
    return `${p.name} ${p.address} ${company}`.toLowerCase().includes(needle);
  });
  const visibleCargo = cargo.filter((c) => c.name.toLowerCase().includes(needle));
  const visibleStations = stations.filter((s) => s.name.toLowerCase().includes(needle));

  const tabCount =
    tab === 'companies'
      ? visibleCompanies.length
      : tab === 'places'
        ? visiblePlaces.length
        : tab === 'cargo'
          ? visibleCargo.length
          : visibleStations.length;

  return (
    <Page
      title="Справочники"
      onBack={undefined}
      actions={<Button variant="soft" icon="plus" onClick={() => setEditor({ kind: tab, id: null })} />}
    >
      <SearchBar value={search} onChange={setSearch} />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        items={[
          { value: 'companies', label: 'Фирмы' },
          { value: 'places', label: 'Места' },
          { value: 'cargo', label: 'Грузы' },
          { value: 'stations', label: 'АЗС' },
        ]}
      />
      <div className="row">
        <span className="small muted">{tabCount} записей</span>
        <span style={{ flex: 1 }} />
        <Button variant="primary" icon="plus" onClick={() => setEditor({ kind: tab, id: null })}>
          Добавить
        </Button>
      </div>

      {tab === 'companies' ? (
        visibleCompanies.length === 0 ? (
          <Card>
            <Empty text="Фирм нет" />
          </Card>
        ) : (
          <div className="list">
            {visibleCompanies.map((c) => {
              const placesCount = countRows('places', 'company_id = ?', [c.id]);
              return (
                <button key={c.id} className="list-item" onClick={() => setEditor({ kind: 'companies', id: c.id })}>
                  <span className="avatar">
                    {c.logo ? <img src={c.logo} alt="" /> : <Icon name="box" />}
                  </span>
                  <span className="li-main">
                    <span className="li-title">{c.name}</span>
                    <span className="li-sub">
                      {placesCount} мест · {refs.cargoType(c.cargo_type_id)?.name ?? 'груз не задан'}
                    </span>
                  </span>
                  <Icon name="nav" />
                </button>
              );
            })}
          </div>
        )
      ) : null}

      {tab === 'places' ? (
        visiblePlaces.length === 0 ? (
          <Card>
            <Empty text="Мест нет" />
          </Card>
        ) : (
          <div className="list">
            {visiblePlaces.map((p) => (
              <button key={p.id} className="list-item" onClick={() => setEditor({ kind: 'places', id: p.id })}>
                <span className="avatar">
                  <Icon name="pin" />
                </span>
                <span className="li-main">
                  <span className="li-title">{p.name}</span>
                  <span className="li-sub">
                    {refs.company(p.company_id)?.name ?? 'Без фирмы'} · {p.address}
                  </span>
                </span>
                <Icon name="nav" />
              </button>
            ))}
          </div>
        )
      ) : null}

      {tab === 'cargo' ? (
        visibleCargo.length === 0 ? (
          <Card>
            <Empty text="Грузов нет" />
          </Card>
        ) : (
          <div className="list">
            {visibleCargo.map((c) => (
              <button key={c.id} className="list-item" onClick={() => setEditor({ kind: 'cargo', id: c.id })}>
                <span className="avatar">
                  {c.icon ? <img src={c.icon} alt="" /> : <Icon name="box" />}
                </span>
                <span className="li-main">
                  <span className="li-title">{c.name}</span>
                  <span className="li-sub">Груз</span>
                </span>
                <Icon name="nav" />
              </button>
            ))}
          </div>
        )
      ) : null}

      {tab === 'stations' ? (
        visibleStations.length === 0 ? (
          <Card>
            <Empty text="АЗС нет" />
          </Card>
        ) : (
          <div className="list">
            {visibleStations.map((s) => (
              <button key={s.id} className="list-item" onClick={() => setEditor({ kind: 'stations', id: s.id })}>
                <span className="avatar">
                  {s.logo ? <img src={s.logo} alt="" /> : <Icon name="fuel" />}
                </span>
                <span className="li-main">
                  <span className="li-title">{s.name}</span>
                  <span className="li-sub">
                    {countRows('refuelings', 'station_id = ?', [s.id])} заправок
                  </span>
                </span>
                <Icon name="nav" />
              </button>
            ))}
          </div>
        )
      ) : null}

      <RefEditor
        editor={editor}
        onClose={() => setEditor(null)}
        onDelete={(kind, id) => {
          setEditor(null);
          setConfirm({ kind, id });
        }}
        onSaved={(msg) => {
          touch();
          notify(msg, 'ok');
        }}
        onFindPicture={setPictureRequest}
      />

      {pictureRequest ? (
        <PicturePicker
          name={pictureRequest.name}
          kind={pictureRequest.kind}
          title={`Подобрать: ${pictureRequest.name || pictureTitle(pictureRequest.kind)}`}
          onClose={() => setPictureRequest(null)}
          onPick={(value) => pictureRequest.apply(value)}
        />
      ) : null}

      <Confirm
        open={confirm !== null}
        title="Удалить запись"
        text="Запись будет скрыта из справочника. Уже созданные перевозки сохранят данные."
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm) {
            softDelete(confirm.kind === 'cargo' ? 'cargo_types' : confirm.kind === 'stations' ? 'fuel_stations' : confirm.kind, confirm.id);
            touch();
          }
          setConfirm(null);
        }}
      />
    </Page>
  );
}

/** Запрос на подбор картинки: что искать и куда поставить найденное */
interface PictureRequest {
  name: string;
  kind: PictureKind;
  apply: (v: string) => void;
}

function pictureTitle(kind: PictureKind): string {
  if (kind === 'cargo') return 'значок груза';
  if (kind === 'station') return 'логотип АЗС';
  if (kind === 'vehicle') return 'значок техники';
  return 'логотип фирмы';
}

function RefEditor({
  editor,
  onClose,
  onDelete,
  onSaved,
  onFindPicture,
}: {
  editor: { kind: Tab; id: string | null } | null;
  onClose: () => void;
  onDelete: (kind: Tab, id: string) => void;
  onSaved: (msg: string) => void;
  onFindPicture: (req: PictureRequest) => void;
}) {
  const revision = useApp((s) => s.revision);
  const [company, setCompany] = useState<Company | null>(null);
  const [place, setPlace] = useState<Place | null>(null);
  const [cargo, setCargo] = useState<CargoType | null>(null);
  const [station, setStation] = useState<FuelStation | null>(null);

  useEffect(() => {
    if (!editor) return;
    if (editor.kind === 'companies') {
      setCompany(
        editor.id
          ? refs.company(editor.id)
          : { id: uid(), name: '', cargo_type_id: null, logo: '', note: '', created_at: '', updated_at: '', deleted: 0 },
      );
    }
    if (editor.kind === 'places') {
      setPlace(
        editor.id
          ? refs.place(editor.id)
          : {
              id: uid(),
              name: '',
              company_id: null,
              address: '',
              lat: null,
              lon: null,
              contact: '',
              load_type: null,
              cargo_type_id: null,
              note: '',
              created_at: '',
              updated_at: '',
              deleted: 0,
            },
      );
    }
    if (editor.kind === 'cargo') {
      const found = listAll<CargoType>('cargo_types', 'name').find((c) => c.id === editor.id);
      setCargo(
        found ?? { id: uid(), name: '', icon: '', note: '', created_at: '', updated_at: '', deleted: 0 },
      );
    }
    if (editor.kind === 'stations') {
      setStation(
        editor.id
          ? refs.station(editor.id)
          : { id: uid(), name: '', logo: '', note: '', created_at: '', updated_at: '', deleted: 0 },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor?.kind, editor?.id, revision]);

  if (!editor) return null;

  const titles: Record<Tab, string> = {
    companies: 'фирму',
    places: 'место',
    cargo: 'груз',
    stations: 'АЗС',
  };

  function save() {
    if (editor!.kind === 'companies' && company) {
      const payload = { name: company.name, cargo_type_id: company.cargo_type_id, logo: company.logo, note: company.note };
      if (editor!.id) updateRow('companies', company.id, payload);
      else insertRow('companies', { id: company.id, ...payload });
    }
    if (editor!.kind === 'places' && place) {
      const payload = {
        name: place.name,
        company_id: place.company_id,
        address: place.address,
        lat: place.lat,
        lon: place.lon,
        contact: place.contact,
        load_type: place.load_type,
        cargo_type_id: place.cargo_type_id,
        note: place.note,
      };
      if (editor!.id) updateRow('places', place.id, payload);
      else insertRow('places', { id: place.id, ...payload });
    }
    if (editor!.kind === 'cargo' && cargo) {
      const payload = { name: cargo.name, icon: cargo.icon, note: cargo.note };
      if (editor!.id) updateRow('cargo_types', cargo.id, payload);
      else insertRow('cargo_types', { id: cargo.id, ...payload });
    }
    if (editor!.kind === 'stations' && station) {
      const payload = { name: station.name, logo: station.logo, note: station.note };
      if (editor!.id) updateRow('fuel_stations', station.id, payload);
      else insertRow('fuel_stations', { id: station.id, ...payload });
    }
    onSaved('Запись сохранена');
    onClose();
  }

  function pickLogo(file: File, apply: (dataUrl: string) => void) {
    const reader = new FileReader();
    reader.onload = () => apply(String(reader.result));
    reader.readAsDataURL(file);
  }

  const logoRow = (
    value: string,
    apply: (v: string) => void,
    find: { name: string; kind: PictureKind },
    label = 'Логотип',
  ) => (
    <Field label={label} hint="можно подобрать помощником">
      <div className="row wrap">
        <label className="btn btn-soft">
          <Icon name="upload" />
          <span>Файл</span>
          <input
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) pickLogo(f, apply);
            }}
          />
        </label>
        <Button
          icon="ai"
          onClick={() => onFindPicture({ name: find.name, kind: find.kind, apply })}
          disabled={find.name.trim() === ''}
        >
          Найти
        </Button>
        <TextInput
          value={value.startsWith('data:') ? '' : value}
          placeholder="Ссылка"
          onChange={(e) => apply(e.target.value)}
        />
        {value ? (
          <Button variant="danger" icon="trash" onClick={() => apply('')} />
        ) : null}
      </div>
    </Field>
  );

  return (
    <Modal
      open
      title={editor.id ? `Изменить ${titles[editor.kind]}` : `Новая ${titles[editor.kind]}`}
      onClose={onClose}
      footer={
        <>
          {editor.id ? (
            <Button variant="danger" icon="trash" onClick={() => onDelete(editor.kind, editor.id!)}>
              Удалить
            </Button>
          ) : null}
          <span style={{ flex: 1 }} />
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" icon="check" onClick={save}>
            Сохранить
          </Button>
        </>
      }
    >
      {editor.kind === 'companies' && company ? (
        <>
          <Field label="Фирма" required>
            <TextInput value={company.name} onChange={(e) => setCompany({ ...company, name: e.target.value })} />
          </Field>
          <Field label="Типовой груз">
            <Select
              value={company.cargo_type_id}
              onChange={(v) => setCompany({ ...company, cargo_type_id: v })}
              options={refs.cargoTypes().map((c) => ({ value: c.id, label: c.name }))}
              placeholder="Не выбран"
            />
          </Field>
          {logoRow(company.logo, (v) => setCompany({ ...company, logo: v }), {
            name: company.name,
            kind: 'company',
          })}
          <Field label="Примечания">
            <TextInput value={company.note} onChange={(e) => setCompany({ ...company, note: e.target.value })} />
          </Field>
        </>
      ) : null}

      {editor.kind === 'places' && place ? (
        <>
          <Field label="Место" required>
            <TextInput value={place.name} onChange={(e) => setPlace({ ...place, name: e.target.value })} />
          </Field>
          <Field label="Фирма">
            <Select
              value={place.company_id}
              onChange={(v) => setPlace({ ...place, company_id: v })}
              options={refs.companies().map((c) => ({ value: c.id, label: c.name }))}
              placeholder="Не выбрана"
            />
          </Field>
          <Field label="Полный адрес">
            <TextInput value={place.address} onChange={(e) => setPlace({ ...place, address: e.target.value })} />
          </Field>
          <Field label="Контакт">
            <TextInput
              value={place.contact}
              inputMode="tel"
              onChange={(e) => setPlace({ ...place, contact: e.target.value })}
            />
          </Field>
          <Field label="Координаты" hint="Формат: 56.001765,37.531211">
            <div className="row">
              <TextInput
                value={fmtCoords(place.lat, place.lon)}
                onChange={(e) => {
                  const c = parseCoords(e.target.value);
                  setPlace({ ...place, lat: c?.lat ?? null, lon: c?.lon ?? null });
                }}
              />
              <Button
                icon="pin"
                title="Взять текущие координаты"
                onClick={() => {
                  if (!navigator.geolocation) return;
                  navigator.geolocation.getCurrentPosition(
                    (pos) => setPlace({ ...place, lat: pos.coords.latitude, lon: pos.coords.longitude }),
                    () => onSaved('Не удалось получить координаты'),
                  );
                }}
              />
            </div>
          </Field>
          <Field label="Тип загрузки">
            <Select
              value={place.load_type}
              onChange={(v) => setPlace({ ...place, load_type: v })}
              options={LOAD_TYPES}
              placeholder="Не выбран"
            />
          </Field>
          <Field label="Типовой груз">
            <Select
              value={place.cargo_type_id}
              onChange={(v) => setPlace({ ...place, cargo_type_id: v })}
              options={refs.cargoTypes().map((c) => ({ value: c.id, label: c.name }))}
              placeholder="Не выбран"
            />
          </Field>
          <Field label="Примечания">
            <textarea
              className="input"
              rows={2}
              value={place.note}
              onChange={(e) => setPlace({ ...place, note: e.target.value })}
            />
          </Field>
        </>
      ) : null}

      {editor.kind === 'cargo' && cargo ? (
        <>
          <Field label="Груз" required>
            <TextInput value={cargo.name} onChange={(e) => setCargo({ ...cargo, name: e.target.value })} />
          </Field>
          {logoRow(
            cargo.icon,
            (v) => setCargo({ ...cargo, icon: v }),
            { name: cargo.name, kind: 'cargo' },
            'Значок',
          )}
          <Field label="Примечания">
            <TextInput value={cargo.note} onChange={(e) => setCargo({ ...cargo, note: e.target.value })} />
          </Field>
        </>
      ) : null}

      {editor.kind === 'stations' && station ? (
        <>
          <Field label="АЗС" required>
            <TextInput value={station.name} onChange={(e) => setStation({ ...station, name: e.target.value })} />
          </Field>
          {logoRow(station.logo, (v) => setStation({ ...station, logo: v }), {
            name: station.name,
            kind: 'station',
          })}
          <Field label="Примечания">
            <TextInput value={station.note} onChange={(e) => setStation({ ...station, note: e.target.value })} />
          </Field>
        </>
      ) : null}
    </Modal>
  );
}

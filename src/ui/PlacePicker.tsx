/** Выбор места из справочника с возможностью создать новое на месте. */

import { useMemo, useState } from 'react';
import { Button, Field, Icon, Modal, SearchBar, Select, TextInput } from './components';
import { insertRow, refs, uid } from '../db/repo';
import { useApp } from '../store';
import { fmtCoords, parseCoords } from '../lib/format';
import { LOAD_TYPES, type Id, type LoadType, type Place } from '../types';

export function PlacePicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (place: Place) => void;
}) {
  const revision = useApp((s) => s.revision);
  const touch = useApp((s) => s.touch);
  const notify = useApp((s) => s.notify);
  const [mode, setMode] = useState<'list' | 'new'>('list');
  const [query, setQuery] = useState('');

  const [name, setName] = useState('');
  const [companyId, setCompanyId] = useState<Id | null>(null);
  const [address, setAddress] = useState('');
  const [contact, setContact] = useState('');
  const [coords, setCoords] = useState('');
  const [loadType, setLoadType] = useState<LoadType | null>(null);
  const [cargoId, setCargoId] = useState<Id | null>(null);

  const places = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return refs.places().filter((p) => {
      if (!needle) return true;
      const company = refs.company(p.company_id)?.name ?? '';
      return `${p.name} ${p.address} ${company}`.toLowerCase().includes(needle);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, query]);

  function reset() {
    setMode('list');
    setQuery('');
    setName('');
    setCompanyId(null);
    setAddress('');
    setContact('');
    setCoords('');
    setLoadType(null);
    setCargoId(null);
  }

  function createAndPick() {
    if (!name.trim()) {
      notify('Укажите название места', 'err');
      return;
    }
    const parsed = parseCoords(coords);
    const id = uid();
    insertRow('places', {
      id,
      name: name.trim(),
      company_id: companyId,
      address: address.trim(),
      lat: parsed?.lat ?? null,
      lon: parsed?.lon ?? null,
      contact: contact.trim(),
      load_type: loadType,
      cargo_type_id: cargoId,
      note: '',
    });
    touch();
    const created = refs.place(id);
    reset();
    if (created) onPick(created);
    onClose();
  }

  return (
    <Modal
      open={open}
      title={mode === 'list' ? 'Выбор места' : 'Новое место'}
      onClose={() => {
        reset();
        onClose();
      }}
      footer={
        mode === 'new' ? (
          <>
            <Button onClick={() => setMode('list')}>Назад</Button>
            <Button variant="primary" icon="check" onClick={createAndPick}>
              Создать и выбрать
            </Button>
          </>
        ) : (
          <Button variant="primary" icon="plus" onClick={() => setMode('new')}>
            Новое место
          </Button>
        )
      }
    >
      {mode === 'list' ? (
        <>
          <SearchBar value={query} onChange={setQuery} />
          {places.length === 0 ? (
            <div className="empty small">Справочник пуст</div>
          ) : (
            <div className="list">
              {places.map((p) => {
                const company = refs.company(p.company_id);
                const cargo = refs.cargoType(p.cargo_type_id);
                return (
                  <button
                    key={p.id}
                    className="list-item"
                    onClick={() => {
                      reset();
                      onPick(p);
                      onClose();
                    }}
                  >
                    <span className="avatar">
                      {company?.logo ? <img src={company.logo} alt="" /> : <Icon name="pin" />}
                    </span>
                    <span className="li-main">
                      <span className="li-title">{p.name}</span>
                      <span className="li-sub">
                        {company?.name ?? 'Без фирмы'}
                        {cargo?.name ? ` · ${cargo.name}` : ''}
                      </span>
                      <span className="li-sub">{p.address}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <>
          <Field label="Место" required>
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Например, Заплюсье" />
          </Field>
          <Field label="Фирма">
            <Select
              value={companyId}
              onChange={setCompanyId}
              options={refs.companies().map((c) => ({ value: c.id, label: c.name, logo: c.logo }))}
              placeholder="Не выбрана"
            />
          </Field>
          <Field label="Полный адрес">
            <TextInput value={address} onChange={(e) => setAddress(e.target.value)} />
          </Field>
          <Field label="Контакт">
            <TextInput
              value={contact}
              inputMode="tel"
              onChange={(e) => setContact(e.target.value)}
              placeholder="Телефон"
            />
          </Field>
          <Field label="Координаты" hint="Формат: 56.001765,37.531211">
            <TextInput value={coords} onChange={(e) => setCoords(e.target.value)} placeholder="56.001765,37.531211" />
          </Field>
          <Field label="Тип загрузки">
            <Select
              value={loadType}
              onChange={setLoadType}
              options={LOAD_TYPES}
              placeholder="Не выбран"
            />
          </Field>
          <Field label="Типовой груз">
            <Select
              value={cargoId}
              onChange={setCargoId}
              options={refs.cargoTypes().map((c) => ({ value: c.id, label: c.name, logo: c.icon }))}
              placeholder="Не выбран"
            />
          </Field>
          <div className="small muted">Координаты: {coords ? fmtCoords(parseCoords(coords)?.lat ?? null, parseCoords(coords)?.lon ?? null) : '—'}</div>
        </>
      )}
    </Modal>
  );
}

/** Общие элементы интерфейса. */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { monthChoices, monthLabel } from '../lib/format';
import { usedMonths } from '../db/repo';
import { useApp } from '../store';
import { SELECT_SEARCH_FROM, filterOptions, type SelectOption } from './select';
import { SaveBadge } from './SaveBadge';

/** Месяцы с данными; база может быть ещё не готова */
function safeUsedMonths(): string[] {
  try {
    return usedMonths();
  } catch {
    return [];
  }
}

/**
 * Месяц для фильтра по умолчанию — один и тот же порядок во всех списках:
 * текущий месяц, если в нём уже что-то есть; иначе показываем всё.
 * Так после сдачи смены список не выглядит пустым из-за пустого месяца.
 */
export function defaultFilterMonth(): string {
  const now = new Date();
  const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return safeUsedMonths().includes(cur) ? cur : '';
}

export function Page({
  title,
  actions,
  children,
  onBack,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  onBack?: () => void;
}) {
  return (
    <div className="page">
      <header className="topbar">
        {onBack ? (
          <button className="icon-btn" onClick={onBack} aria-label="Назад">
            <Icon name="back" />
          </button>
        ) : null}
        <h1>{title}</h1>
        <SaveBadge />
        <div className="topbar-actions">{actions}</div>
      </header>
      <div className="page-body">{children}</div>
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
  className = '',
  onClick,
}: {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <section className={`card ${className}`} onClick={onClick}>
      {title || actions ? (
        <div className="card-head">
          <div className="card-title">{title}</div>
          <div className="card-actions">{actions}</div>
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Row({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`row ${className}`}>{children}</div>;
}

export function KV({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="kv">
      <div className="kv-label">{label}</div>
      <div className="kv-value">{value}</div>
      {hint ? <div className="kv-hint">{hint}</div> : null}
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
  required,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
  required?: boolean;
}) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {required ? <b className="req"> *</b> : null}
      </span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export function TextInput(props: InputProps) {
  return <input {...props} className={`input ${props.className ?? ''}`} />;
}

type TextAreaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export function TextArea(props: TextAreaProps) {
  return <textarea {...props} className={`input textarea ${props.className ?? ''}`} />;
}

export function NumberInput({
  value,
  onValue,
  steppers,
  step = 1,
  ...rest
}: {
  value: number | null;
  onValue: (v: number | null) => void;
  /** Кнопки «−/+» рядом с полем — удобно вводить одной рукой, без клавиатуры */
  steppers?: boolean;
  /** Шаг кнопок */
  step?: number;
} & Omit<InputProps, 'value' | 'onChange'>) {
  const [text, setText] = useState(value === null || value === undefined ? '' : String(value));
  useEffect(() => {
    const next = value === null || value === undefined ? '' : String(value);
    setText((prev) => (Number(prev.replace(',', '.')) === value ? prev : next));
  }, [value]);
  const input = (
    <input
      {...rest}
      className={`input ${rest.className ?? ''}`}
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        const cleaned = raw.replace(/\s/g, '').replace(',', '.');
        if (cleaned === '') onValue(null);
        else {
          const n = Number(cleaned);
          if (Number.isFinite(n)) onValue(n);
        }
      }}
      onBlur={() => {
        const cleaned = text.replace(/\s/g, '').replace(',', '.');
        setText(cleaned === '' ? '' : String(Number(cleaned)));
      }}
    />
  );
  if (!steppers) return input;

  const bump = (dir: -1 | 1) => {
    const base = value === null || value === undefined || Number.isNaN(value) ? 0 : value;
    onValue(Math.max(0, Math.round((base + dir * step) * 100) / 100));
  };
  return (
    <div className="num-stepper">
      <button type="button" className="num-step" onClick={() => bump(-1)} aria-label="Меньше">
        −
      </button>
      {input}
      <button type="button" className="num-step" onClick={() => bump(1)} aria-label="Больше">
        +
      </button>
    </div>
  );
}

/**
 * Логотип или значок записи в списке выбора. У записи без картинки остаётся
 * невидимое место — так названия в списке стоят ровно в столбик.
 */
export function OptionAvatar({ logo }: { logo?: string }) {
  if (!logo) return <span className="opt-avatar is-empty" />;
  return (
    <span className="opt-avatar">
      <img src={logo} alt="" loading="lazy" />
    </span>
  );
}

/**
 * Поле выбора из списка. У записи с логотипом (фирма, груз, АЗС, автомобиль)
 * логотип виден и в самом поле, и в раскрытом списке — поэтому это не <select>,
 * а своя раскрывашка: в <option> картинку поставить нельзя.
 */
export function Select<T extends string>({
  value,
  onChange,
  options,
  placeholder = '—',
  disabled,
  className = '',
  title,
  id,
  'aria-label': ariaLabel,
}: {
  value: T | null;
  onChange: (v: T | null) => void;
  options: SelectOption<T>[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  title?: string;
  id?: string;
  'aria-label'?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value) ?? null;

  useEffect(() => {
    if (!open) return;
    function onDocDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  function pick(v: T | null) {
    setOpen(false);
    onChange(v);
  }

  return (
    <div
      ref={wrapRef}
      className={`select-wrap ${className}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false);
      }}
    >
      <button
        type="button"
        id={id}
        title={title}
        aria-label={ariaLabel}
        className="input select select-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {selected?.logo ? <OptionAvatar logo={selected.logo} /> : null}
        <span className="select-label">{selected ? selected.label : placeholder}</span>
      </button>
      {open ? (
        <SelectMenu value={value} options={options} placeholder={placeholder} onPick={pick} />
      ) : null}
    </div>
  );
}

/** Раскрытый список поля выбора: поиск по буквам, строки с логотипами и значками */
export function SelectMenu<T extends string>({
  value,
  options,
  placeholder,
  onPick,
}: {
  value: T | null;
  options: SelectOption<T>[];
  placeholder: string;
  onPick: (v: T | null) => void;
}) {
  const [query, setQuery] = useState('');
  const searchable = options.length >= SELECT_SEARCH_FROM;
  const shown = filterOptions(options, query);
  const anyLogo = options.some((o) => o.logo);

  return (
    <div className="select-menu">
      {searchable ? (
        <input
          className="input select-search"
          placeholder="Поиск по списку"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            const first = shown[0];
            if (first) onPick(first.value);
          }}
        />
      ) : null}
      <div className="select-options" role="listbox">
        {query.trim() === '' ? (
          <button
            type="button"
            role="option"
            aria-selected={value === null}
            className={`select-option ${value === null ? 'is-active' : ''}`}
            onClick={() => onPick(null)}
          >
            <span className="select-label muted">{placeholder}</span>
          </button>
        ) : null}
        {shown.map((o) => (
          <button
            key={o.value}
            type="button"
            role="option"
            aria-selected={o.value === value}
            className={`select-option ${o.value === value ? 'is-active' : ''}`}
            onClick={() => onPick(o.value)}
          >
            {o.logo ? <OptionAvatar logo={o.logo} /> : anyLogo ? <OptionAvatar /> : null}
            <span className="select-label">{o.label}</span>
            {o.hint ? <span className="select-hint">{o.hint}</span> : null}
          </button>
        ))}
        {shown.length === 0 ? <div className="select-empty">Ничего не найдено</div> : null}
      </div>
    </div>
  );
}

export function DateInput({
  value,
  onChange,
  ...rest
}: { value: string | null; onChange: (v: string | null) => void } & Omit<InputProps, 'value' | 'onChange'>) {
  return (
    <input
      {...rest}
      type="date"
      className={`input ${rest.className ?? ''}`}
      value={value ? value.slice(0, 10) : ''}
      onChange={(e) => onChange(e.target.value || null)}
    />
  );
}

export function DateTimeInput({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const local = value ? toLocal(value) : '';
  return (
    <input
      type="datetime-local"
      className="input"
      value={local}
      onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)}
    />
  );
}

function toLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger' | 'success' | 'soft';
  icon?: IconName;
  block?: boolean;
};

export function Button({ variant = 'soft', icon, block, children, ...rest }: BtnProps) {
  return (
    <button {...rest} className={`btn btn-${variant} ${block ? 'btn-block' : ''} ${rest.className ?? ''}`}>
      {icon ? <Icon name={icon} /> : null}
      {children ? <span>{children}</span> : null}
    </button>
  );
}

export function IconButton({ icon, ...rest }: { icon: IconName } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} className={`icon-btn ${rest.className ?? ''}`} aria-label={rest.title ?? 'Действие'}>
      <Icon name={icon} />
    </button>
  );
}

export type AvatarTone = 'brand' | 'ok' | 'info' | 'warn' | 'err' | 'accent';

/**
 * Цветной значок строки: пиктограмма по смыслу, цвет — по типу записи.
 * Логотип, если он есть, показывается вместо пиктограммы.
 */
export function Avatar({
  tone = 'brand',
  logo,
  icon,
  children,
}: {
  tone?: AvatarTone;
  logo?: string | null;
  icon?: IconName;
  children?: React.ReactNode;
}) {
  return (
    <span className={`avatar avatar-${tone}`}>
      {children ?? (logo ? <img src={logo} alt="" /> : icon ? <Icon name={icon} /> : null)}
    </span>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'ok' | 'warn' | 'err' | 'info';
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Chip({
  active,
  children,
  onClick,
}: {
  active?: boolean;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button type="button" className={`chip ${active ? 'chip-active' : ''}`} onClick={onClick}>
      {children}
    </button>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { value: T; label: string }[];
}) {
  return (
    <div className="tabs">
      {items.map((i) => (
        <button
          key={i.value}
          type="button"
          className={`tab ${value === i.value ? 'tab-active' : ''}`}
          onClick={() => onChange(i.value)}
        >
          {i.label}
        </button>
      ))}
    </div>
  );
}

export function StatCard({
  label,
  value,
  tone = 'neutral',
  icon,
  onClick,
}: {
  label: string;
  value: React.ReactNode;
  tone?: 'neutral' | 'ok' | 'warn' | 'err' | 'info';
  icon?: IconName;
  onClick?: () => void;
}) {
  const inner = (
    <>
      <div className="stat-head">
        <span>{label}</span>
        {icon ? <Icon name={icon} /> : null}
      </div>
      <div className="stat-value">{value}</div>
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={`stat stat-${tone} stat-clickable`} onClick={onClick}>
        {inner}
      </button>
    );
  }
  return <div className={`stat stat-${tone}`}>{inner}</div>;
}

/**
 * Ряд показателей. Число столбцов подбирается по ширине само: на телефоне две
 * плашки в строку и крупные цифры, на планшете — сколько поместится.
 */
export function StatGrid({ children }: { children: React.ReactNode }) {
  return <div className="stat-grid">{children}</div>;
}

export function SearchBar({
  value,
  onChange,
  autoFocus,
  placeholder = 'Поиск',
}: {
  value: string;
  onChange: (v: string) => void;
  /** Сразу ставим курсор в поле — для отдельного экрана поиска */
  autoFocus?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="searchbar">
      <Icon name="search" />
      <input
        className="search-input"
        placeholder={placeholder}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
      />
      {value ? (
        <button className="search-clear" onClick={() => onChange('')} aria-label="Очистить">
          <Icon name="close" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Поле-приглашение: выглядит как строка поиска, а открывает отдельный экран
 * поиска по всей базе — так на «Главной» сразу понятно, что искать можно везде.
 */
export function SearchEntry({ text, onClick }: { text: string; onClick: () => void }) {
  return (
    <button type="button" className="searchbar search-entry" onClick={onClick}>
      <Icon name="search" />
      <span className="search-input search-entry-text">{text}</span>
      <Icon name="nav" size={16} />
    </button>
  );
}

export function MonthPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  // Список строится по данным базы: пустые годы и месяцы не показываем
  const options = useMemo(() => monthChoices(safeUsedMonths(), value), [value]);
  return (
    <div className="month-picker">
      <select className="input select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Все месяцы</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {monthLabel(o)}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Empty({ text, action }: { text: string; action?: React.ReactNode }) {
  return (
    <div className="empty">
      <p>{text}</p>
      {action}
    </div>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <IconButton icon="close" onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Confirm({
  open,
  title,
  text,
  onCancel,
  onConfirm,
  confirmLabel = 'Удалить',
  confirmVariant = 'danger',
}: {
  open: boolean;
  title: string;
  text: string;
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel?: string;
  confirmVariant?: 'danger' | 'primary' | 'success';
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Отмена</Button>
          <Button variant={confirmVariant} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p>{text}</p>
    </Modal>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismiss);
  if (toasts.length === 0) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export type IconName =
  | 'back'
  | 'close'
  | 'plus'
  | 'trash'
  | 'check'
  | 'search'
  | 'doc'
  | 'route'
  | 'home'
  | 'menu'
  | 'car'
  | 'fuel'
  | 'money'
  | 'pin'
  | 'phone'
  | 'nav'
  | 'box'
  | 'edit'
  | 'up'
  | 'down'
  | 'share'
  | 'download'
  | 'upload'
  | 'ai'
  | 'refresh'
  | 'warning'
  | 'settings'
  | 'copy'
  | 'send'
  | 'clock'
  | 'undo'
  | 'eye'
  | 'power'
  | 'family'
  | 'flag'
  | 'truck'
  | 'receipt'
  | 'yadisk';

const PATHS: Record<IconName, React.ReactNode> = {
  back: <path d="M15 5l-7 7 7 7" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  trash: <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />,
  check: <path d="M5 13l4 4L19 7" />,
  search: <path d="M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4" />,
  doc: <path d="M7 3h7l5 5v13H7zM14 3v5h5M9 13h8M9 17h5" />,
  route: <path d="M6 4v10a4 4 0 004 4h8M18 4v6a4 4 0 01-4 4H6M16 2l2 2-2 2M8 16l-2 2 2 2" />,
  home: <path d="M4 11l8-7 8 7v9H4z" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  car: <path d="M5 16h14l-1-6-2-3H8L6 10zM5 16v3M19 16v3M8 12h8" />,
  fuel: <path d="M6 21V5a2 2 0 012-2h5a2 2 0 012 2v16M6 21h9M15 9h2a2 2 0 012 2v6a2 2 0 004 0v-8l-3-3" />,
  money: <path d="M3 6h18v12H3zM12 12a2 2 0 100-4 2 2 0 000 4zM6 9v6M18 9v6" />,
  pin: <path d="M12 21s7-6.3 7-11a7 7 0 10-14 0c0 4.7 7 11 7 11zM12 12a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />,
  phone: <path d="M5 4h4l2 5-2 2a12 12 0 006 6l2-2 5 2v4a1 1 0 01-1 1A17 17 0 014 5a1 1 0 011-1z" />,
  nav: <path d="M21 3L3 11l8 2 2 8z" />,
  box: <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9" />,
  edit: <path d="M4 20h4L20 8l-4-4L4 16zM14 6l4 4" />,
  up: <path d="M12 19V5M6 11l6-6 6 6" />,
  down: <path d="M12 5v14M6 13l6 6 6-6" />,
  share: <path d="M12 16V4M8 8l4-4 4 4M5 14v5h14v-5" />,
  download: <path d="M12 4v12M8 12l4 4 4-4M5 20h14" />,
  upload: <path d="M12 16V4M8 8l4-4 4 4M5 20h14" />,
  ai: <path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2zM18 15l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" />,
  refresh: <path d="M20 12a8 8 0 10-3 6M20 5v7h-7" />,
  warning: <path d="M12 3l9 17H3zM12 9v5M12 17h.01" />,
  settings: <path d="M12 15a3 3 0 100-6 3 3 0 000 6zM19 12l2-1-2-4-2 1-2-1-1-2h-4l-1 2-2 1-2-1-2 4 2 1v2l-2 1 2 4 2-1 2 1 1 2h4l1-2 2-1 2 1 2-4-2-1z" />,
  copy: <path d="M9 9h11v11H9zM5 15V3h11" />,
  send: <path d="M4 12l16-8-6 16-2-6z" />,
  clock: <path d="M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2" />,
  undo: <path d="M4 10h11a5 5 0 010 10h-4M4 10l4-4M4 10l4 4" />,
  eye: <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6zM14.5 12a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z" />,
  power: <path d="M12 3v9M18.4 6.6a9 9 0 11-12.8 0" />,
  family: (
    <path d="M8 11a3 3 0 100-6 3 3 0 000 6zM16 11a3 3 0 100-6 3 3 0 000 6zM2 20v-1a5 5 0 015-5h2a5 5 0 015 5v1M14 14h1a5 5 0 015 5v1" />
  ),
  // Финишный флажок — понятный знак «смена окончена»
  flag: (
    <>
      <path d="M5 21V4" />
      <path d="M5 4h12l-3 4 3 4H5z" />
    </>
  ),
  // Фура: кабина с прицепом — узнаётся с первого взгляда
  truck: (
    <>
      <path d="M2 7h11v10H2z" />
      <path d="M13 10h4l3 3v4h-7z" />
      <circle cx="6.4" cy="17.6" r="1.7" />
      <circle cx="16.3" cy="17.6" r="1.7" />
    </>
  ),
  // Начисление: документ-квитанция с отрывным низом
  receipt: (
    <>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
      <path d="M9 8h6M9 12h6" />
    </>
  ),
  // Фирменный знак Яндекс Диска: красный круг с диском
  yadisk: (
    <>
      <circle cx="12" cy="12" r="10.5" fill="#FC3F1D" stroke="none" />
      <circle cx="12" cy="12" r="5" fill="none" stroke="#ffffff" strokeWidth="2.4" />
      <circle cx="12" cy="12" r="1.7" fill="#ffffff" stroke="none" />
    </>
  ),
};

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

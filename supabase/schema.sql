-- Автотрекер — схема облака Supabase.
--
-- Как включить синхронизацию:
-- 1. Создайте проект на https://supabase.com (бесплатного тарифа достаточно).
-- 2. Откройте «SQL Editor» и выполните весь этот файл целиком.
-- 3. В разделе «Project Settings → API» скопируйте Project URL и ключ anon public.
-- 4. В приложении: Настройки → Облачная синхронизация → вставьте адрес и ключ.
-- 5. Там же создайте учётную запись (почта и пароль) и нажмите «Создать запись».
--    Если в проекте включено подтверждение почты, подтвердите адрес по письму и войдите.
-- 6. Дальше пользуйтесь кнопкой «Отправить» на главном экране.
--
-- Доступ: каждая строка помечена user_id, и правила RLS разрешают работать
-- только со своими строками. Чужие данные недоступны даже при утечке ключа anon.

-- ---------- Таблицы ----------
-- Структура повторяет локальную базу приложения.
-- id — текстовый, его создаёт приложение (это важно для синхронизации).
-- updated_at — время последнего изменения, по нему определяется, кто «новее».

create table if not exists public.vehicles (
  id text primary key,
  name text not null default '',
  plate text not null default '',
  kind text not null default 'tractor',
  brand text not null default '',
  model text not null default '',
  vin text not null default '',
  year text not null default '',
  fuel_norm double precision,
  note text not null default '',
  logo text not null default '',
  archived integer not null default 0,
  created_at text not null,
  updated_at text not null,
  deleted integer not null default 0,
  user_id uuid not null default auth.uid()
);

create table if not exists public.vehicle_periods (
  id text primary key,
  vehicle_id text not null,
  start_date text not null default '',
  end_date text,
  note text not null default '',
  created_at text not null,
  updated_at text not null,
  deleted integer not null default 0,
  user_id uuid not null default auth.uid()
);

create table if not exists public.vehicle_links (
  id text primary key,
  tractor_id text not null,
  trailer_id text not null,
  start_date text not null default '',
  end_date text,
  created_at text not null,
  updated_at text not null,
  deleted integer not null default 0,
  user_id uuid not null default auth.uid()
);

create table if not exists public.companies (
  id text primary key,
  name text not null default '',
  cargo_type_id text,
  logo text not null default '',
  note text not null default '',
  created_at text not null,
  updated_at text not null,
  deleted integer not null default 0,
  user_id uuid not null default auth.uid()
);

create table if not exists public.cargo_types (
  id text primary key,
  name text not null default '',
  icon text not null default '',
  note text not null default '',
  created_at text not null,
  updated_at text not null,
  deleted integer not null default 0,
  user_id uuid not null default auth.uid()
);

create table if not exists public.fuel_stations (
  id text primary key,
  name text not null default '',
  logo text not null default '',
  note text not null default '',
  created_at text not null,
  updated_at text not null,
  deleted integer not null default 0,
  user_id uuid not null default auth.uid()
);

create table if not exists public.places (
  id text primary key,
  name text not null default '',
  company_id text,
  address text not null default '',
  lat double precision,
  lon double precision,
  contact text not null default '',
  load_type text,
  cargo_type_id text,
  note text not null default '',
  created_at text not null,
  updated_at text not null,
  deleted integer not null default 0,
  user_id uuid not null default auth.uid()
);

create table if not exists public.waybills (
  id text primary key,
  number text not null default '',
  name text not null default '',
  date_out text not null default '',
  odometer_out double precision,
  fuel_out double precision,
  date_in text,
  odometer_in double precision,
  fuel_in double precision,
  vehicle_id text,
  trailer_id text,
  note text not null default '',
  status text not null default 'open',
  created_at text not null,
  updated_at text not null,
  deleted integer not null default 0,
  user_id uuid not null default auth.uid()
);

create table if not exists public.trips (
  id text primary key,
  waybill_id text not null,
  cargo_type_id text,
  weight double precision,
  amount double precision,
  note text not null default '',
  status text not null default 'planned',
  created_at text not null,
  updated_at text not null,
  deleted integer not null default 0,
  user_id uuid not null default auth.uid()
);

create table if not exists public.trip_points (
  id text primary key,
  trip_id text not null,
  seq integer not null default 1,
  kind text not null default 'load',
  place_id text,
  plan_date text,
  fact_date text,
  load_type text,
  cargo_type_id text,
  weight double precision,
  status text not null default 'planned',
  note text not null default '',
  created_at text not null,
  updated_at text not null,
  deleted integer not null default 0,
  user_id uuid not null default auth.uid()
);

create table if not exists public.refuelings (
  id text primary key,
  waybill_id text,
  date text not null default '',
  volume double precision not null default 0,
  kind text not null default 'barrel',
  station_id text,
  note text not null default '',
  created_at text not null,
  updated_at text not null,
  deleted integer not null default 0,
  user_id uuid not null default auth.uid()
);

create table if not exists public.finance_ops (
  id text primary key,
  date text not null default '',
  kind text not null default 'charge',
  amount double precision not null default 0,
  pay_month text,
  trip_id text,
  waybill_id text,
  note text not null default '',
  auto integer not null default 0,
  created_at text not null,
  updated_at text not null,
  deleted integer not null default 0,
  user_id uuid not null default auth.uid()
);

create table if not exists public.attachments (
  id text primary key,
  owner_table text not null,
  owner_id text not null,
  title text not null default '',
  mime text not null default '',
  path text not null default '',
  thumb_path text not null default '',
  size bigint not null default 0,
  created_at text not null,
  updated_at text not null,
  deleted integer not null default 0,
  user_id uuid not null default auth.uid()
);

-- Индексы по времени изменения: ускоряют выборку «что нового»
do $$
declare t text;
begin
  foreach t in array array[
    'vehicles','vehicle_periods','vehicle_links','companies','cargo_types','fuel_stations',
    'places','waybills','trips','trip_points','refuelings','finance_ops','attachments'
  ]
  loop
    execute format('create index if not exists %I on public.%I (user_id, updated_at)', t || '_user_updated_idx', t);
  end loop;
end $$;

-- ---------- Правила доступа ----------
-- Включить RLS и разрешить работать только со своими строками.

do $$
declare t text;
begin
  foreach t in array array[
    'vehicles','vehicle_periods','vehicle_links','companies','cargo_types','fuel_stations',
    'places','waybills','trips','trip_points','refuelings','finance_ops','attachments'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_own_rows', t);
    execute format(
      'create policy %I on public.%I for all using (auth.uid() = user_id) with check (auth.uid() = user_id)',
      t || '_own_rows', t
    );
  end loop;
end $$;

-- ---------- Хранилище фотографий ----------
-- Файлы лежат в бакете documents в папке с номером пользователя.
-- Размер одного файла ограничен 20 МБ (приложение сжимает снимки само).

insert into storage.buckets (id, name, public, file_size_limit)
values ('documents', 'documents', false, 20971520)
on conflict (id) do update set file_size_limit = excluded.file_size_limit;

drop policy if exists "documents: свои файлы" on storage.objects;
create policy "documents: свои файлы"
  on storage.objects for all
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text);

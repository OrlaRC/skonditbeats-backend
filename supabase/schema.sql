-- ══════════════════════════════════════════════════════════════════════════════
-- SkonditBeats — Schema definitivo para Supabase
-- Ejecuta en: Dashboard → SQL Editor → New Query
-- ══════════════════════════════════════════════════════════════════════════════

-- 0. Extensiones
create extension if not exists "uuid-ossp";


-- ══════════════════════════════════════════════════════════════════════════════
-- ENUMS
-- ══════════════════════════════════════════════════════════════════════════════

create type user_rol as enum ('SUPER_ADMIN', 'ADMIN', 'MODERADOR', 'CLIENTE');

create type order_status as enum ('PENDIENTE', 'COMPLETADO', 'CANCELADO');


-- ══════════════════════════════════════════════════════════════════════════════
-- TABLA: users
-- ══════════════════════════════════════════════════════════════════════════════

create table if not exists public.users (
  id             uuid         primary key default uuid_generate_v4(),
  username       varchar(50)  unique,
  email          varchar(150) not null unique,
  password       text         not null,        -- bcrypt hash, nunca texto plano
  nombre         varchar(100) not null,
  rol            user_rol     not null default 'CLIENTE',
  permissions    text[]       not null default '{}',
  foto_url       text,
  direccion      text,
  telefono       text,
  edad           integer,
  activo         boolean      not null default true,
  fecha_registro timestamptz  not null default now(),
  created_at     timestamptz  not null default now(),
  updated_at     timestamptz  not null default now()
);

create index if not exists idx_users_email    on public.users (email);
create index if not exists idx_users_username on public.users (username);
create index if not exists idx_users_rol      on public.users (rol);


-- ══════════════════════════════════════════════════════════════════════════════
-- TABLA: beats
-- ══════════════════════════════════════════════════════════════════════════════

create table if not exists public.beats (
  id          uuid           primary key default uuid_generate_v4(),
  nombre      varchar(150)   not null,
  genero      varchar(80)    not null,
  bpm         integer        not null default 120 check (bpm > 0 and bpm < 300),
  precio      numeric(10,2)  not null check (precio >= 0),
  imagen_url  text,
  audio_url   text,
  descripcion text,
  activo      boolean        not null default true,
  created_at  timestamptz    not null default now(),
  updated_at  timestamptz    not null default now()
);

create index if not exists idx_beats_genero on public.beats (genero);
create index if not exists idx_beats_activo on public.beats (activo);
create index if not exists idx_beats_precio on public.beats (precio);
create index if not exists idx_beats_bpm    on public.beats (bpm);


-- ══════════════════════════════════════════════════════════════════════════════
-- TABLA: orders
-- ══════════════════════════════════════════════════════════════════════════════

create table if not exists public.orders (
  id         uuid          primary key default uuid_generate_v4(),
  user_id    uuid          not null references public.users(id) on delete restrict,
  total      numeric(10,2) not null check (total >= 0),
  status     order_status  not null default 'PENDIENTE',
  created_at timestamptz   not null default now()
);

create index if not exists idx_orders_user   on public.orders (user_id);
create index if not exists idx_orders_status on public.orders (status);


-- ══════════════════════════════════════════════════════════════════════════════
-- TABLA: order_items
-- ══════════════════════════════════════════════════════════════════════════════

create table if not exists public.order_items (
  id              uuid          primary key default uuid_generate_v4(),
  order_id        uuid          not null references public.orders(id)  on delete cascade,
  beat_id         uuid          not null references public.beats(id)   on delete restrict,
  precio_unitario numeric(10,2) not null check (precio_unitario >= 0),
  unique (order_id, beat_id)    -- un beat una sola vez por orden
);

create index if not exists idx_order_items_order on public.order_items (order_id);
create index if not exists idx_order_items_beat  on public.order_items (beat_id);


-- ══════════════════════════════════════════════════════════════════════════════
-- TABLA: contact_messages
-- ══════════════════════════════════════════════════════════════════════════════

create table if not exists public.contact_messages (
  id         uuid         primary key default uuid_generate_v4(),
  nombre     text         not null,
  email      text         not null,
  mensaje    text         not null,
  created_at timestamptz  not null default now()
);


-- ══════════════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- El backend usa service_role_key → bypasea RLS automáticamente.
-- Lo activamos como buena práctica; las policies aplican solo si alguien
-- accede directo vía anon key (ej. desde el frontend sin pasar por la API).
-- ══════════════════════════════════════════════════════════════════════════════

alter table public.users            enable row level security;
alter table public.beats            enable row level security;
alter table public.orders           enable row level security;
alter table public.order_items      enable row level security;
alter table public.contact_messages enable row level security;

-- Beats activos: visibles públicamente (la tienda puede leerlos directo si hace falta)
create policy "beats_public_read"
  on public.beats for select
  using (activo = true);

-- Órdenes: solo el dueño ve las suyas
create policy "orders_own_select"
  on public.orders for select
  using (auth.uid()::text = user_id::text);

create policy "order_items_own_select"
  on public.order_items for select
  using (
    order_id in (
      select id from public.orders where user_id::text = auth.uid()::text
    )
  );


-- ══════════════════════════════════════════════════════════════════════════════
-- STORAGE BUCKETS
-- ══════════════════════════════════════════════════════════════════════════════

insert into storage.buckets (id, name, public)
values ('beats-images', 'beats-images', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('beats-audio', 'beats-audio', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- Lectura pública (cualquiera puede ver imágenes, audio y avatars)
create policy "public_read_beats_images"
  on storage.objects for select
  using (bucket_id = 'beats-images');

create policy "public_read_beats_audio"
  on storage.objects for select
  using (bucket_id = 'beats-audio');

create policy "public_read_avatars"
  on storage.objects for select
  using (bucket_id = 'avatars');


-- ══════════════════════════════════════════════════════════════════════════════
-- SUPER ADMIN SEED
-- Contraseña: Admin12345!
-- Hash generado con bcrypt 12 rounds — cámbialo en producción si lo deseas
-- ══════════════════════════════════════════════════════════════════════════════

insert into public.users (username, email, password, nombre, rol, permissions)
values (
  'admin',
  'admin@skonditbeats.com',
  '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMqJqhcanFp8/Qf1MpRwmxZqyq',
  'Super Admin',
  'SUPER_ADMIN',
  array['*']
)
on conflict (email) do nothing;


-- ══════════════════════════════════════════════════════════════════════════════
-- DATOS DE EJEMPLO (beats) — borra este bloque si no los necesitas
-- ══════════════════════════════════════════════════════════════════════════════

insert into public.beats (nombre, genero, bpm, precio, descripcion)
values
  ('Dark Trap Flow',  'Trap',    140, 299, 'Beat oscuro con 808s profundos'),
  ('Golden Rap',      'Rap',      90, 249, 'Boom bap clásico, sample de jazz'),
  ('Night Drill',     'Drill',   145, 320, 'UK Drill con hi-hats rápidos'),
  ('Chill LoFi',      'LoFi',     75, 180, 'Atmosférico, ideal para estudiar'),
  ('Rock Anthem',     'Rock',    120, 350, 'Guitarras distorsionadas')
on conflict do nothing;

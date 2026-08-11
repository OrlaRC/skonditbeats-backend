-- ══════════════════════════════════════════════════════════════════════════════
-- SkonditBeats — Migración: Paquete de beats (packs) + intercambio
-- Ejecuta en: Dashboard → SQL Editor → New Query
-- ══════════════════════════════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════════════════════════
-- TABLA: packs
-- Un paquete agrupa varios beats con un precio (generalmente con descuento).
-- ══════════════════════════════════════════════════════════════════════════════

create table if not exists public.packs (
  id          uuid         primary key default uuid_generate_v4(),
  nombre      text         not null,
  descripcion text,
  imagen_url  text,
  precio      numeric      not null default 0,
  activo      boolean      not null default true,
  created_at  timestamptz  not null default now(),
  updated_at  timestamptz  not null default now()
);

create index if not exists idx_packs_activo on public.packs (activo);


-- ══════════════════════════════════════════════════════════════════════════════
-- TABLA: pack_beats (relación N:M pack ↔ beat)
-- ══════════════════════════════════════════════════════════════════════════════

create table if not exists public.pack_beats (
  pack_id  uuid not null references public.packs(id) on delete cascade,
  beat_id  uuid not null references public.beats(id) on delete cascade,
  primary key (pack_id, beat_id)
);

create index if not exists idx_pack_beats_beat on public.pack_beats (beat_id);


-- ══════════════════════════════════════════════════════════════════════════════
-- ORDERS: columna pack_id (opcional)
-- Sirve para saber que una orden corresponde a la compra de un paquete.
-- ══════════════════════════════════════════════════════════════════════════════

alter table public.orders add column if not exists pack_id uuid references public.packs(id);
create index if not exists idx_orders_pack on public.orders (pack_id);


-- ══════════════════════════════════════════════════════════════════════════════
-- TABLA: pack_intercambios
-- Registra qué beat se cambió por cuál dentro de un paquete comprado.
-- ══════════════════════════════════════════════════════════════════════════════

create table if not exists public.pack_intercambios (
  id            uuid        primary key default uuid_generate_v4(),
  user_id       uuid        not null references public.users(id),
  order_id      uuid        not null references public.orders(id),
  pack_id       uuid        not null references public.packs(id),
  beat_origen   uuid        not null references public.beats(id),
  beat_cambia   uuid        not null references public.beats(id),
  created_at    timestamptz not null default now()
);

create index if not exists idx_pack_intercambios_user on public.pack_intercambios (user_id);
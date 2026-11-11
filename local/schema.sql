-- Esquema completo de SkonditBeats para el PostgreSQL local (entorno de pruebas).
-- Equivale a schema.sql + packs.sql + audit.sql + contacto_respuestas.sql + tickets.sql
-- de la carpeta supabase/, sin lo que solo existe en Supabase (auth.uid, storage.*).
-- Lo ejecuta local/preparar.ps1 sobre la base skondit_local.

create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;

-- Rol con el que PostgREST atiende a la API (equivale a service_role en Supabase).
do $$ begin
  if not exists (select from pg_roles where rolname = 'skondit_api') then
    create role skondit_api nologin;
  end if;
end $$;

do $$ begin
  create type user_rol as enum ('SUPER_ADMIN', 'ADMIN', 'MODERADOR', 'CLIENTE');
exception when duplicate_object then null; end $$;

do $$ begin
  create type order_status as enum ('PENDIENTE', 'COMPLETADO', 'CANCELADO');
exception when duplicate_object then null; end $$;

create table if not exists users (
  id                uuid         primary key default uuid_generate_v4(),
  username          varchar(50)  unique,
  email             varchar(150) not null unique,
  password          text         not null,
  nombre            varchar(100) not null,
  rol               user_rol     not null default 'CLIENTE',
  permissions       text[]       not null default '{}',
  foto_url          text,
  direccion         text,
  telefono          text,
  edad              integer,
  activo            boolean      not null default true,
  intentos_fallidos integer      not null default 0,
  bloqueado_hasta   timestamptz,
  fecha_registro    timestamptz  not null default now(),
  created_at        timestamptz  not null default now(),
  updated_at        timestamptz  not null default now()
);
create index if not exists idx_users_rol on users (rol);

create table if not exists beats (
  id          uuid          primary key default uuid_generate_v4(),
  nombre      varchar(150)  not null,
  genero      varchar(80)   not null,
  bpm         integer       not null default 120 check (bpm > 0 and bpm < 300),
  precio      numeric(10,2) not null check (precio >= 0),
  imagen_url  text,
  audio_url   text,
  descripcion text,
  activo      boolean       not null default true,
  client_ref  uuid          unique,
  created_at  timestamptz   not null default now(),
  updated_at  timestamptz   not null default now()
);
create index if not exists idx_beats_genero on beats (genero);
create index if not exists idx_beats_activo on beats (activo);
create index if not exists idx_beats_precio on beats (precio);
create index if not exists idx_beats_bpm    on beats (bpm);

create table if not exists packs (
  id          uuid        primary key default uuid_generate_v4(),
  nombre      text        not null,
  descripcion text,
  imagen_url  text,
  precio      numeric     not null default 0,
  activo      boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists pack_beats (
  pack_id uuid not null references packs(id) on delete cascade,
  beat_id uuid not null references beats(id) on delete cascade,
  primary key (pack_id, beat_id)
);
create index if not exists idx_pack_beats_beat on pack_beats (beat_id);

create table if not exists orders (
  id         uuid          primary key default uuid_generate_v4(),
  user_id    uuid          not null references users(id) on delete restrict,
  total      numeric(10,2) not null check (total >= 0),
  status     order_status  not null default 'PENDIENTE',
  pack_id    uuid          references packs(id),
  client_ref uuid          unique,
  created_at timestamptz   not null default now()
);
create index if not exists idx_orders_user   on orders (user_id);
create index if not exists idx_orders_status on orders (status);

create table if not exists order_items (
  id              uuid          primary key default uuid_generate_v4(),
  order_id        uuid          not null references orders(id) on delete cascade,
  beat_id         uuid          not null references beats(id)  on delete restrict,
  precio_unitario numeric(10,2) not null check (precio_unitario >= 0),
  unique (order_id, beat_id)
);
create index if not exists idx_order_items_order on order_items (order_id);
create index if not exists idx_order_items_beat  on order_items (beat_id);

create table if not exists pack_intercambios (
  id          uuid        primary key default uuid_generate_v4(),
  user_id     uuid        not null references users(id),
  order_id    uuid        not null references orders(id),
  pack_id     uuid        not null references packs(id),
  beat_origen uuid        not null references beats(id),
  beat_cambia uuid        not null references beats(id),
  created_at  timestamptz not null default now()
);

create table if not exists otp_codes (
  id         uuid        primary key default uuid_generate_v4(),
  user_id    uuid        not null references users(id) on delete cascade,
  code       text        not null,
  expires_at timestamptz not null,
  used       boolean     not null default false,
  created_at timestamptz not null default now()
);

create table if not exists bitacora (
  id         uuid        primary key default uuid_generate_v4(),
  user_id    uuid,
  email      text,
  accion     text        not null,
  detalle    text,
  ip         text,
  created_at timestamptz not null default now()
);
create index if not exists idx_bitacora_created on bitacora (created_at desc);
create index if not exists idx_bitacora_accion  on bitacora (accion);

create sequence if not exists ticket_folio_seq;

create table if not exists contact_messages (
  id         uuid        primary key default uuid_generate_v4(),
  folio      bigint      not null default nextval('ticket_folio_seq') unique,
  nombre     text        not null,
  email      text        not null,
  asunto     text,
  mensaje    text        not null,
  tipo       text        not null default 'MENSAJE' check (tipo in ('MENSAJE', 'ERROR')),
  estado     text        not null default 'ABIERTO'
             check (estado in ('ABIERTO', 'EN_PROCESO', 'RESPONDIDO', 'DEVUELTO', 'RESUELTO', 'CERRADO')),
  prioridad  text        not null default 'MEDIA' check (prioridad in ('BAJA', 'MEDIA', 'ALTA')),
  user_id    uuid        references users(id) on delete set null,
  asignado_a uuid,
  client_ref uuid        unique,
  no_leido_cliente boolean not null default false,
  no_leido_admin   boolean not null default true,
  cerrado_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contact_messages_asignado_a_fkey foreign key (asignado_a) references users(id) on delete set null
);

create table if not exists contact_replies (
  id           uuid        primary key default uuid_generate_v4(),
  message_id   uuid        not null references contact_messages(id) on delete cascade,
  autor_id     uuid        references users(id) on delete set null,
  autor_nombre text        not null,
  es_admin     boolean     not null,
  texto        text        not null,
  client_ref   uuid        unique,
  created_at   timestamptz not null default now()
);
create index if not exists idx_contact_replies_message on contact_replies (message_id);

grant usage on schema public to skondit_api;
grant all on all tables in schema public to skondit_api;
grant all on all sequences in schema public to skondit_api;

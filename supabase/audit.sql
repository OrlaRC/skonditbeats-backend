-- ══════════════════════════════════════════════════════════════════════════════
-- SkonditBeats — Migración: Módulo administrativo (auditoría + seguridad)
-- Ejecuta en: Dashboard → SQL Editor → New Query
-- ══════════════════════════════════════════════════════════════════════════════

-- 0. Extensiones (idempotente)
create extension if not exists "uuid-ossp";


-- ══════════════════════════════════════════════════════════════════════════════
-- TABLA: bitacora (auditoría)
-- Registra: login, logout, cambio de contraseña, alta/edición/eliminación,
-- cambios de rol y de permisos. Con usuario, fecha/hora, IP y acción.
-- ══════════════════════════════════════════════════════════════════════════════

create table if not exists public.bitacora (
  id         uuid         primary key default uuid_generate_v4(),
  user_id    uuid,
  email      text,
  accion     text         not null,
  detalle    text,
  ip         text,
  created_at timestamptz  not null default now()
);

create index if not exists idx_bitacora_created on public.bitacora (created_at desc);
create index if not exists idx_bitacora_user   on public.bitacora (user_id);
create index if not exists idx_bitacora_accion on public.bitacora (accion);

alter table public.bitacora enable row level security;


-- ══════════════════════════════════════════════════════════════════════════════
-- USERS: columnas de seguridad
-- intentos_fallidos → contador de intentos de login fallidos
-- bloqueado_hasta  → timestamp hasta el que la cuenta queda bloqueada
-- ══════════════════════════════════════════════════════════════════════════════

alter table public.users add column if not exists intentos_fallidos integer     not null default 0;
alter table public.users add column if not exists bloqueado_hasta   timestamptz;

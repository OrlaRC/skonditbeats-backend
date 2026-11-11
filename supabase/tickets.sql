-- Tickets de soporte + idempotencia de escrituras + índices (Práctica 12).
-- Ejecutar una vez en Supabase > SQL Editor ANTES de levantar o publicar la API nueva.
-- Requiere haber corrido antes contacto_respuestas.sql.
-- Solo agrega columnas, índices y restricciones: no borra datos. Se puede repetir.

-- ── Tickets ──────────────────────────────────────────────────────────────────
-- Cada mensaje o reporte es un ticket con folio consecutivo, prioridad y estado.
create sequence if not exists public.ticket_folio_seq;

alter table public.contact_messages
  add column if not exists folio      bigint not null default nextval('public.ticket_folio_seq'),
  add column if not exists asunto     text,
  add column if not exists prioridad  text not null default 'MEDIA',
  add column if not exists cerrado_at timestamptz,
  add column if not exists client_ref uuid;

alter table public.contact_messages
  drop constraint if exists contact_messages_estado_check,
  add constraint contact_messages_estado_check
    check (estado in ('ABIERTO', 'EN_PROCESO', 'RESPONDIDO', 'DEVUELTO', 'RESUELTO', 'CERRADO')),
  drop constraint if exists contact_messages_prioridad_check,
  add constraint contact_messages_prioridad_check check (prioridad in ('BAJA', 'MEDIA', 'ALTA')),
  drop constraint if exists contact_messages_folio_key,
  add constraint contact_messages_folio_key unique (folio),
  drop constraint if exists contact_messages_client_ref_key,
  add constraint contact_messages_client_ref_key unique (client_ref);

-- La bandeja se consulta por estado y fecha, por dueño y por admin asignado.
create index if not exists idx_contact_messages_estado_fecha on public.contact_messages (estado, created_at desc);
create index if not exists idx_contact_messages_user_fecha   on public.contact_messages (user_id, created_at desc);
create index if not exists idx_contact_messages_asignado     on public.contact_messages (asignado_a);

-- ── Idempotencia ─────────────────────────────────────────────────────────────
-- La app manda una clave única por operación (cabecera Idempotency-Key). Si la
-- respuesta se pierde y la app reintenta, la restricción UNIQUE impide el duplicado.
alter table public.contact_replies add column if not exists client_ref uuid;
alter table public.orders          add column if not exists client_ref uuid;
alter table public.beats           add column if not exists client_ref uuid;

alter table public.contact_replies
  drop constraint if exists contact_replies_client_ref_key,
  add constraint contact_replies_client_ref_key unique (client_ref);
alter table public.orders
  drop constraint if exists orders_client_ref_key,
  add constraint orders_client_ref_key unique (client_ref);
alter table public.beats
  drop constraint if exists beats_client_ref_key,
  add constraint beats_client_ref_key unique (client_ref);

-- ── Índices del catálogo ─────────────────────────────────────────────────────
-- GET /api/beats filtra por activo y ordena por fecha: un solo índice parcial
-- resuelve la página sin ordenar toda la tabla.
create index if not exists idx_beats_activo_fecha on public.beats (created_at desc) where activo;
create index if not exists idx_orders_user_status on public.orders (user_id, status);

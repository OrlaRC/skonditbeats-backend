-- Índices de la optimización (los mismos que agrega supabase/tickets.sql).
-- Van aparte del esquema para poder medir las consultas ANTES y DESPUÉS de crearlos:
--   psql -d skondit_local -f local/indices.sql          (crear)
--   psql -d skondit_local -v quitar=1 -f local/indices.sql   (quitar, para repetir el "antes")
\if :{?quitar}
  drop index if exists idx_beats_activo_fecha;
  drop index if exists idx_orders_user_status;
  drop index if exists idx_contact_messages_estado_fecha;
  drop index if exists idx_contact_messages_user_fecha;
  drop index if exists idx_contact_messages_asignado;
\else
  create index if not exists idx_beats_activo_fecha on beats (created_at desc) where activo;
  create index if not exists idx_orders_user_status on orders (user_id, status);
  create index if not exists idx_contact_messages_estado_fecha on contact_messages (estado, created_at desc);
  create index if not exists idx_contact_messages_user_fecha   on contact_messages (user_id, created_at desc);
  create index if not exists idx_contact_messages_asignado     on contact_messages (asignado_a);
\endif
analyze;

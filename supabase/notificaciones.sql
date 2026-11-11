-- Avisos de tickets no leídos (notificaciones de la app) y rol SUPER_ADMIN.
-- Ejecutar una vez en Supabase > SQL Editor, después de tickets.sql.
-- Solo agrega columnas e índices; se puede repetir.

-- Cada ticket sabe si tiene algo nuevo para su dueño o para los administradores:
--   no_leido_cliente  el admin respondió o cambió el estado y el cliente no lo ha visto
--   no_leido_admin    ticket nuevo o el cliente respondió y ningún admin lo ha visto
alter table public.contact_messages
  add column if not exists no_leido_cliente boolean not null default false,
  add column if not exists no_leido_admin   boolean not null default true;

-- Los tickets que ya existían se consideran vistos para no inundar de avisos.
update public.contact_messages set no_leido_admin = false
where no_leido_admin and created_at < now() - interval '1 minute';

create index if not exists idx_contact_no_leido_cliente on public.contact_messages (user_id) where no_leido_cliente;
create index if not exists idx_contact_no_leido_admin   on public.contact_messages (updated_at desc) where no_leido_admin;

-- ── Super administrador ──────────────────────────────────────────────────────
-- El rol SUPER_ADMIN ya existe en el tipo user_rol. Para nombrar al primero,
-- descomenta la línea y pon tu correo (debe haber al menos uno):
-- update public.users set rol = 'SUPER_ADMIN' where email = 'tu-correo@ejemplo.com';

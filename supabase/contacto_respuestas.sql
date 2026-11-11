-- Contacto: respuestas, reportes de error, devolución al cliente y asignación entre admins.
-- Ejecutar una vez en Supabase > SQL Editor ANTES de levantar o publicar la API nueva.
-- Solo agrega columnas y una tabla: no borra ni modifica datos existentes.

alter table public.contact_messages
  add column if not exists user_id    uuid references public.users(id) on delete set null,
  add column if not exists tipo       text not null default 'MENSAJE',
  add column if not exists estado     text not null default 'ABIERTO',
  add column if not exists asignado_a uuid,
  add column if not exists updated_at timestamptz not null default now();

alter table public.contact_messages
  drop constraint if exists contact_messages_tipo_check,
  add constraint contact_messages_tipo_check check (tipo in ('MENSAJE', 'ERROR')),
  drop constraint if exists contact_messages_estado_check,
  add constraint contact_messages_estado_check check (estado in ('ABIERTO', 'RESPONDIDO', 'DEVUELTO')),
  drop constraint if exists contact_messages_asignado_a_fkey,
  add constraint contact_messages_asignado_a_fkey foreign key (asignado_a) references public.users(id) on delete set null;

create index if not exists idx_contact_messages_user on public.contact_messages (user_id);

create table if not exists public.contact_replies (
  id           uuid        primary key default uuid_generate_v4(),
  message_id   uuid        not null references public.contact_messages(id) on delete cascade,
  autor_id     uuid        references public.users(id) on delete set null,
  autor_nombre text        not null,
  es_admin     boolean     not null,
  texto        text        not null,
  created_at   timestamptz not null default now()
);

create index if not exists idx_contact_replies_message on public.contact_replies (message_id);

-- Sin políticas: solo la API (service_role) puede leer y escribir.
alter table public.contact_replies enable row level security;

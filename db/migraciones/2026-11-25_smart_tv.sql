-- Smart TV vinculada a una cuenta (2026-11-25).
-- Idempotente: se puede correr más de una vez. Aplicar en Neon ANTES de desplegar la API:
--   psql "$DATABASE_URL" -f db/migraciones/2026-11-25_smart_tv.sql
--
-- Antes la TV leía un único renglón global (now_playing, id = 1) con una clave de
-- dispositivo compartida: todos los usuarios se pisaban. Ahora cada TV se empareja con
-- una cuenta (código de 6 dígitos o QR que se escanea desde la app móvil) y cada cuenta
-- tiene su propio estado de reproducción.

-- Una fila por TV. La TV se identifica con un token aleatorio que solo ella conoce;
-- en la base se guarda su SHA-256, nunca el token.
CREATE TABLE IF NOT EXISTS public.tv_dispositivos (
    id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    token_hash       text NOT NULL UNIQUE,
    nombre           text NOT NULL DEFAULT 'Smart TV',
    codigo           text,
    codigo_expira_at timestamp with time zone,
    user_id          uuid REFERENCES public.users(id) ON DELETE CASCADE,
    created_at       timestamp with time zone DEFAULT now() NOT NULL,
    vinculado_at     timestamp with time zone,
    ultimo_contacto  timestamp with time zone,
    revocado_at      timestamp with time zone,
    CONSTRAINT tv_codigo_formato CHECK (codigo IS NULL OR codigo ~ '^[0-9]{6}$')
);

-- Un código solo puede estar pendiente en una TV a la vez.
CREATE UNIQUE INDEX IF NOT EXISTS tv_codigo_pendiente_idx
    ON public.tv_dispositivos (codigo) WHERE user_id IS NULL AND revocado_at IS NULL;
CREATE INDEX IF NOT EXISTS tv_user_idx
    ON public.tv_dispositivos (user_id) WHERE revocado_at IS NULL;

-- Lo que suena para cada cuenta. El teléfono manda órdenes (comando sube en cada una)
-- y la TV reporta su posición real en las columnas tv_*.
CREATE TABLE IF NOT EXISTS public.tv_reproduccion (
    user_id         uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    beat_id         uuid REFERENCES public.beats(id) ON DELETE SET NULL,
    position_sec    integer NOT NULL DEFAULT 0 CHECK (position_sec >= 0),
    duration_sec    integer NOT NULL DEFAULT 0 CHECK (duration_sec >= 0),
    playing         boolean NOT NULL DEFAULT false,
    destino         text NOT NULL DEFAULT 'app' CHECK (destino IN ('app', 'tv')),
    volumen         smallint NOT NULL DEFAULT 100 CHECK (volumen BETWEEN 0 AND 100),
    comando         bigint NOT NULL DEFAULT 0,
    tv_position_sec integer,
    tv_playing      boolean,
    tv_reportado_at timestamp with time zone,
    updated_at      timestamp with time zone DEFAULT now() NOT NULL
);

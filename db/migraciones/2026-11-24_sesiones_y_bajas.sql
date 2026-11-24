-- Sesiones revocables y baja definitiva de cuentas (2026-11-24).
-- Idempotente: se puede correr más de una vez. Aplicar en Neon ANTES de desplegar la API:
--   psql "$DATABASE_URL" -f db/migraciones/2026-11-24_sesiones_y_bajas.sql

-- Cada inicio de sesión (web o app) es una fila; el token lleva su id en "jti".
-- Cerrar sesión, cambiar la contraseña o dar de baja la cuenta la revocan.
CREATE TABLE IF NOT EXISTS public.sesiones (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    dispositivo text,
    ip          text,
    created_at  timestamp with time zone DEFAULT now() NOT NULL,
    ultimo_uso  timestamp with time zone DEFAULT now() NOT NULL,
    expira_at   timestamp with time zone NOT NULL,
    revocada_at timestamp with time zone
);

CREATE INDEX IF NOT EXISTS sesiones_user_activas_idx
    ON public.sesiones (user_id) WHERE revocada_at IS NULL;

-- Cuenta dada de baja: sus datos personales se borran y ya no aparece en el gestor.
-- Si tenía compras, la fila se conserva anonimizada para no romper el historial de ventas.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS eliminado_at timestamp with time zone;

-- Alta de paquetes idempotente (cabecera Idempotency-Key), igual que beats y tickets:
-- si la app reintenta tras un corte de red, no se crea un paquete duplicado.
ALTER TABLE public.packs ADD COLUMN IF NOT EXISTS client_ref uuid UNIQUE;

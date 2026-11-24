-- Esquema de la base de SkonditBeats (estructura, sin datos).
-- Generado desde Neon con pg_dump --schema-only; compatible con PostgreSQL 16+.
-- Lo usan las pruebas de la API (scripts/pruebas/entorno.ts) para crear skondit_test.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

CREATE TYPE public.order_status AS ENUM (
    'PENDIENTE',
    'COMPLETADO',
    'CANCELADO'
);

CREATE TYPE public.user_rol AS ENUM (
    'SUPER_ADMIN',
    'ADMIN',
    'MODERADOR',
    'CLIENTE'
);

CREATE FUNCTION public.evitar_compra_repetida() RETURNS trigger
    LANGUAGE plpgsql
    AS $$

declare

  v_usuario uuid;

begin

  select user_id into v_usuario from orders where id = new.order_id;

  perform pg_advisory_xact_lock(hashtextextended('compra:' || v_usuario::text, 0));

  if exists (

    select 1

      from order_items i

      join orders o on o.id = i.order_id

     where o.user_id = v_usuario

       and o.status = 'COMPLETADO'

       and i.beat_id = new.beat_id

       and i.order_id <> new.order_id

  ) then

    raise exception 'El usuario ya compró el beat %', new.beat_id

      using errcode = '23505', hint = 'compra_repetida';

  end if;

  return new;

end;

$$;

CREATE FUNCTION public.skondit_auth_user(p_email text, p_password text) RETURNS TABLE(ok boolean, nombre text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$

declare v_nombre text;

begin

  select u.nombre into v_nombre

  from public.users u

  where lower(u.email) = lower(p_email)

    and (

      u."password" = p_password

      or u."password" = crypt(p_password, u."password")

    )

  limit 1;

  if v_nombre is null then

    return query select false::boolean, null::text;

  else

    return query select true::boolean, v_nombre;

  end if;

end;

$$;

SET default_tablespace = '';

SET default_table_access_method = heap;

CREATE TABLE public.beats (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    nombre character varying(150) NOT NULL,
    genero character varying(80) NOT NULL,
    bpm integer DEFAULT 120 NOT NULL,
    precio numeric(10,2) NOT NULL,
    imagen_url text,
    audio_url text,
    descripcion text,
    activo boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    client_ref uuid,
    CONSTRAINT beats_bpm_check CHECK (((bpm > 0) AND (bpm < 300))),
    CONSTRAINT beats_precio_check CHECK ((precio >= (0)::numeric))
);

CREATE TABLE public.bitacora (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    email text,
    accion text NOT NULL,
    detalle text,
    ip text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.ticket_folio_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE public.contact_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    nombre text NOT NULL,
    email text NOT NULL,
    mensaje text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid,
    tipo text DEFAULT 'MENSAJE'::text NOT NULL,
    estado text DEFAULT 'ABIERTO'::text NOT NULL,
    asignado_a uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    folio bigint DEFAULT nextval('public.ticket_folio_seq'::regclass) NOT NULL,
    asunto text,
    prioridad text DEFAULT 'MEDIA'::text NOT NULL,
    cerrado_at timestamp with time zone,
    client_ref uuid,
    no_leido_cliente boolean DEFAULT false NOT NULL,
    no_leido_admin boolean DEFAULT true NOT NULL,
    CONSTRAINT contact_messages_estado_check CHECK ((estado = ANY (ARRAY['ABIERTO'::text, 'EN_PROCESO'::text, 'RESPONDIDO'::text, 'DEVUELTO'::text, 'RESUELTO'::text, 'CERRADO'::text]))),
    CONSTRAINT contact_messages_prioridad_check CHECK ((prioridad = ANY (ARRAY['BAJA'::text, 'MEDIA'::text, 'ALTA'::text]))),
    CONSTRAINT contact_messages_tipo_check CHECK ((tipo = ANY (ARRAY['MENSAJE'::text, 'ERROR'::text])))
);

CREATE TABLE public.contact_replies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id uuid NOT NULL,
    autor_id uuid,
    autor_nombre text NOT NULL,
    es_admin boolean NOT NULL,
    texto text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    client_ref uuid
);

CREATE TABLE public.now_playing (
    id integer DEFAULT 1 NOT NULL,
    beat_id text,
    beat_name text,
    genre text,
    bpm integer,
    position_sec integer,
    duration_sec integer,
    playing boolean DEFAULT false,
    updated_at timestamp with time zone DEFAULT now(),
    target text DEFAULT 'app'::text,
    CONSTRAINT now_playing_id_check CHECK ((id = 1))
);

CREATE TABLE public.order_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    beat_id uuid NOT NULL,
    precio_unitario numeric(10,2) NOT NULL,
    CONSTRAINT order_items_precio_unitario_check CHECK ((precio_unitario >= (0)::numeric))
);

CREATE TABLE public.orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    total numeric(10,2) NOT NULL,
    status public.order_status DEFAULT 'PENDIENTE'::public.order_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    pack_id uuid,
    client_ref uuid,
    CONSTRAINT orders_total_check CHECK ((total >= (0)::numeric))
);

CREATE TABLE public.otp_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    code character varying(6) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.pack_beats (
    pack_id uuid NOT NULL,
    beat_id uuid NOT NULL
);

CREATE TABLE public.pack_intercambios (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    order_id uuid NOT NULL,
    pack_id uuid NOT NULL,
    beat_origen uuid NOT NULL,
    beat_cambia uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.packs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    nombre text NOT NULL,
    descripcion text,
    imagen_url text,
    precio numeric DEFAULT 0 NOT NULL,
    activo boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    username character varying(50),
    email character varying(150) NOT NULL,
    password text NOT NULL,
    nombre character varying(100) NOT NULL,
    rol public.user_rol DEFAULT 'CLIENTE'::public.user_rol NOT NULL,
    permissions text[] DEFAULT '{}'::text[] NOT NULL,
    foto_url text,
    direccion text,
    telefono text,
    edad integer,
    activo boolean DEFAULT true NOT NULL,
    fecha_registro timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    intentos_fallidos integer DEFAULT 0 NOT NULL,
    bloqueado_hasta timestamp with time zone
);

ALTER TABLE ONLY public.beats
    ADD CONSTRAINT beats_client_ref_key UNIQUE (client_ref);

ALTER TABLE ONLY public.beats
    ADD CONSTRAINT beats_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.bitacora
    ADD CONSTRAINT bitacora_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.contact_messages
    ADD CONSTRAINT contact_messages_client_ref_key UNIQUE (client_ref);

ALTER TABLE ONLY public.contact_messages
    ADD CONSTRAINT contact_messages_folio_key UNIQUE (folio);

ALTER TABLE ONLY public.contact_messages
    ADD CONSTRAINT contact_messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.contact_replies
    ADD CONSTRAINT contact_replies_client_ref_key UNIQUE (client_ref);

ALTER TABLE ONLY public.contact_replies
    ADD CONSTRAINT contact_replies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.now_playing
    ADD CONSTRAINT now_playing_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_order_id_beat_id_key UNIQUE (order_id, beat_id);

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_client_ref_key UNIQUE (client_ref);

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.otp_codes
    ADD CONSTRAINT otp_codes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pack_beats
    ADD CONSTRAINT pack_beats_pkey PRIMARY KEY (pack_id, beat_id);

ALTER TABLE ONLY public.pack_intercambios
    ADD CONSTRAINT pack_intercambios_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.packs
    ADD CONSTRAINT packs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);

CREATE INDEX idx_beats_activo ON public.beats USING btree (activo);

CREATE INDEX idx_beats_activo_fecha ON public.beats USING btree (created_at DESC) WHERE activo;

CREATE INDEX idx_beats_bpm ON public.beats USING btree (bpm);

CREATE INDEX idx_beats_genero ON public.beats USING btree (genero);

CREATE INDEX idx_beats_precio ON public.beats USING btree (precio);

CREATE INDEX idx_bitacora_accion ON public.bitacora USING btree (accion);

CREATE INDEX idx_bitacora_created ON public.bitacora USING btree (created_at DESC);

CREATE INDEX idx_bitacora_user ON public.bitacora USING btree (user_id);

CREATE INDEX idx_contact_messages_asignado ON public.contact_messages USING btree (asignado_a);

CREATE INDEX idx_contact_messages_estado_fecha ON public.contact_messages USING btree (estado, created_at DESC);

CREATE INDEX idx_contact_messages_user ON public.contact_messages USING btree (user_id);

CREATE INDEX idx_contact_messages_user_fecha ON public.contact_messages USING btree (user_id, created_at DESC);

CREATE INDEX idx_contact_no_leido_admin ON public.contact_messages USING btree (updated_at DESC) WHERE no_leido_admin;

CREATE INDEX idx_contact_no_leido_cliente ON public.contact_messages USING btree (user_id) WHERE no_leido_cliente;

CREATE INDEX idx_contact_replies_message ON public.contact_replies USING btree (message_id);

CREATE INDEX idx_order_items_beat ON public.order_items USING btree (beat_id);

CREATE INDEX idx_order_items_order ON public.order_items USING btree (order_id);

CREATE INDEX idx_orders_pack ON public.orders USING btree (pack_id);

CREATE INDEX idx_orders_status ON public.orders USING btree (status);

CREATE INDEX idx_orders_user ON public.orders USING btree (user_id);

CREATE INDEX idx_orders_user_status ON public.orders USING btree (user_id, status);

CREATE INDEX idx_otp_code ON public.otp_codes USING btree (code);

CREATE INDEX idx_otp_user ON public.otp_codes USING btree (user_id);

CREATE INDEX idx_pack_beats_beat ON public.pack_beats USING btree (beat_id);

CREATE INDEX idx_pack_intercambios_user ON public.pack_intercambios USING btree (user_id);

CREATE INDEX idx_packs_activo ON public.packs USING btree (activo);

CREATE INDEX idx_users_email ON public.users USING btree (email);

CREATE INDEX idx_users_rol ON public.users USING btree (rol);

CREATE INDEX idx_users_username ON public.users USING btree (username);

CREATE TRIGGER trg_compra_unica BEFORE INSERT ON public.order_items FOR EACH ROW EXECUTE FUNCTION public.evitar_compra_repetida();

ALTER TABLE ONLY public.contact_messages
    ADD CONSTRAINT contact_messages_asignado_a_fkey FOREIGN KEY (asignado_a) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.contact_messages
    ADD CONSTRAINT contact_messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.contact_replies
    ADD CONSTRAINT contact_replies_autor_id_fkey FOREIGN KEY (autor_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.contact_replies
    ADD CONSTRAINT contact_replies_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.contact_messages(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_beat_id_fkey FOREIGN KEY (beat_id) REFERENCES public.beats(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pack_id_fkey FOREIGN KEY (pack_id) REFERENCES public.packs(id);

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.otp_codes
    ADD CONSTRAINT otp_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.pack_beats
    ADD CONSTRAINT pack_beats_beat_id_fkey FOREIGN KEY (beat_id) REFERENCES public.beats(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.pack_beats
    ADD CONSTRAINT pack_beats_pack_id_fkey FOREIGN KEY (pack_id) REFERENCES public.packs(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.pack_intercambios
    ADD CONSTRAINT pack_intercambios_beat_cambia_fkey FOREIGN KEY (beat_cambia) REFERENCES public.beats(id);

ALTER TABLE ONLY public.pack_intercambios
    ADD CONSTRAINT pack_intercambios_beat_origen_fkey FOREIGN KEY (beat_origen) REFERENCES public.beats(id);

ALTER TABLE ONLY public.pack_intercambios
    ADD CONSTRAINT pack_intercambios_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id);

ALTER TABLE ONLY public.pack_intercambios
    ADD CONSTRAINT pack_intercambios_pack_id_fkey FOREIGN KEY (pack_id) REFERENCES public.packs(id);

ALTER TABLE ONLY public.pack_intercambios
    ADD CONSTRAINT pack_intercambios_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

-- ── Sesiones revocables y baja de cuentas (db/migraciones/2026-11-24_sesiones_y_bajas.sql)
CREATE TABLE public.sesiones (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    dispositivo text,
    ip          text,
    created_at  timestamp with time zone DEFAULT now() NOT NULL,
    ultimo_uso  timestamp with time zone DEFAULT now() NOT NULL,
    expira_at   timestamp with time zone NOT NULL,
    revocada_at timestamp with time zone
);

CREATE INDEX sesiones_user_activas_idx ON public.sesiones (user_id) WHERE revocada_at IS NULL;

ALTER TABLE public.users ADD COLUMN eliminado_at timestamp with time zone;

ALTER TABLE public.packs ADD COLUMN client_ref uuid UNIQUE;

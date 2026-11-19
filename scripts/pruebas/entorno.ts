// Entorno común de las pruebas de la API contra una base PostgreSQL REAL.
//
// Antes (con Supabase) cada llamada a la base era una petición HTTP a PostgREST y las
// pruebas la interceptaban con un fetch falso. Ahora la API habla SQL con Postgres, así
// que las pruebas usan una base de verdad: skondit_test en el PostgreSQL de la PC (o la
// que indique DATABASE_URL_PRUEBAS, p. ej. el servicio postgres de GitHub Actions).
//
// Cada archivo de pruebas recrea el esquema desde db/esquema.sql (la misma estructura
// que Neon) y cada prueba empieza con las tablas vacías. Solo Supabase Storage (URLs
// de subida) sigue simulado, porque es lo único que la API todavía usa de Supabase.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSigner } from 'fast-jwt';
import bcrypt from 'bcryptjs';

export const SECRETO = 'secreto-solo-para-pruebas';
export const URL_BD = process.env['DATABASE_URL_PRUEBAS'] ?? 'postgres://postgres@127.0.0.1:5432/skondit_test';

process.env['JWT_SECRET'] = SECRETO;
process.env['DATABASE_URL'] = URL_BD;
process.env['SUPABASE_URL'] = 'http://supabase.invalid';
process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'llave-falsa';

// Supabase Storage simulado (solo lo usa /api/uploads).
export const peticionesStorage: { url: string; method: string; body: string }[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = decodeURIComponent(String(input));
  peticionesStorage.push({ url, method: init?.method ?? 'GET', body: String(init?.body ?? '') });
  return new Response(JSON.stringify({ url: '/object/upload/sign/beats-audio/x.mp3?token=tok' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

type App = Awaited<ReturnType<typeof import('../../src/app').buildApp>>;
export let app: App;
export let bd: typeof import('../../src/db/sql').sql;

const TABLAS = ['pack_intercambios', 'order_items', 'orders', 'pack_beats', 'packs', 'contact_replies',
  'contact_messages', 'otp_codes', 'bitacora', 'now_playing', 'beats', 'users'];

/** Crea skondit_test si no existe, recrea el esquema y levanta la app. Llamar en before(). */
export async function iniciar(): Promise<void> {
  const postgres = (await import('postgres')).default;
  const bdUrl = new URL(URL_BD);
  const nombre = bdUrl.pathname.slice(1);
  const admin = postgres({ ...conexion(URL_BD), database: 'postgres', max: 1, onnotice: () => {} });
  const [existe] = await admin`select 1 from pg_database where datname = ${nombre}`;
  if (!existe) await admin.unsafe(`create database "${nombre}"`);
  await admin.end();

  const limpia = postgres({ ...conexion(URL_BD), max: 1, onnotice: () => {} });
  await limpia.unsafe('drop schema if exists public cascade; create schema public;');
  await limpia.unsafe(readFileSync(join(__dirname, '../../db/esquema.sql'), 'utf8'));
  await limpia.end();

  ({ sql: bd } = await import('../../src/db/sql'));
  const { buildApp } = await import('../../src/app');
  app = await buildApp();
  await app.ready();
}

function conexion(url: string) {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 5432), username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password) || undefined, database: u.pathname.slice(1) };
}

/** Cierra la app y la conexión. Llamar en after(). */
export async function terminar(): Promise<void> {
  await app?.close();
  await bd?.end();
}

/**
 * Deja todas las tablas vacías (beforeEach). Con DELETE en orden de dependencias y no
 * con TRUNCATE: en Windows TRUNCATE recrea los archivos de cada tabla e índice y tardaba
 * ~6.5 s por prueba; con tan pocas filas DELETE es instantáneo.
 */
export async function vaciar(): Promise<void> {
  await bd.unsafe(TABLAS.map(t => `delete from ${t};`).join(' '));
}

// ── Datos de prueba ─────────────────────────────────────────────────────────────
export const CONTRASENA = 'Prueba-12345!';
let hash: string | undefined;

export async function usuario(datos: { id?: string; rol?: string; activo?: boolean; email?: string; nombre?: string;
  intentos_fallidos?: number; bloqueado_hasta?: Date | null } = {}) {
  hash ??= await bcrypt.hash(CONTRASENA, 4);
  const [u] = await bd`
    insert into users ${bd({
      ...(datos.id ? { id: datos.id } : {}),
      email: datos.email ?? `u${Math.random().toString(36).slice(2, 8)}@prueba.test`,
      password: hash,
      nombre: datos.nombre ?? 'Ana Prueba',
      rol: datos.rol ?? 'CLIENTE',
      activo: datos.activo ?? true,
      intentos_fallidos: datos.intentos_fallidos ?? 0,
      bloqueado_hasta: datos.bloqueado_hasta ?? null,
    })}
    returning id, email, nombre, rol`;
  return u as { id: string; email: string; nombre: string; rol: string };
}

export async function beat(datos: { nombre?: string; genero?: string; bpm?: number; precio?: number; activo?: boolean } = {}) {
  const [b] = await bd`
    insert into beats ${bd({
      nombre: datos.nombre ?? 'Beat de prueba', genero: datos.genero ?? 'Trap',
      bpm: datos.bpm ?? 140, precio: datos.precio ?? 300, activo: datos.activo ?? true,
    })}
    returning id, nombre, genero, bpm, precio`;
  return b as { id: string; nombre: string; genero: string; bpm: number; precio: number };
}

export async function paquete(beatIds: string[], datos: { nombre?: string; precio?: number } = {}) {
  const [p] = await bd`
    insert into packs (nombre, precio) values (${datos.nombre ?? 'Paquete'}, ${datos.precio ?? 500})
    returning id, nombre, precio`;
  if (beatIds.length) await bd`insert into pack_beats ${bd(beatIds.map(b => ({ pack_id: p.id, beat_id: b })))}`;
  return p as { id: string; nombre: string; precio: number };
}

/** Una compra COMPLETADA ya hecha (con sus renglones). */
export async function compra(userId: string, beatIds: string[], packId: string | null = null) {
  const [o] = await bd`
    insert into orders (user_id, total, status, pack_id) values (${userId}, 300, 'COMPLETADO', ${packId})
    returning id`;
  await bd`insert into order_items ${bd(beatIds.map(b => ({ order_id: o.id, beat_id: b, precio_unitario: 300 })))}`;
  return o as { id: string };
}

export async function ticket(datos: { user_id?: string | null; estado?: string; nombre?: string; email?: string } = {}) {
  const [t] = await bd`
    insert into contact_messages ${bd({
      nombre: datos.nombre ?? 'Ana', email: datos.email ?? 'ana@prueba.test', mensaje: 'Mensaje de prueba largo',
      user_id: datos.user_id ?? null, estado: datos.estado ?? 'ABIERTO',
    })}
    returning id, folio, estado, user_id`;
  return t as { id: string; folio: number; estado: string; user_id: string | null };
}

// ── Peticiones ──────────────────────────────────────────────────────────────────
export const token = (u: { id: string; rol: string; email?: string }, secreto = SECRETO) =>
  createSigner({ key: secreto })({ sub: u.id, email: u.email ?? 'a@b.c', rol: u.rol });

type Metodo = 'GET' | 'POST' | 'PUT' | 'DELETE';
export const pedir = (method: Metodo, url: string, tk?: string, payload?: object, clave?: string) =>
  app.inject({
    method,
    url,
    headers: { ...(tk ? { authorization: `Bearer ${tk}` } : {}), ...(clave ? { 'idempotency-key': clave } : {}) },
    ...(payload ? { payload } : {}),
  });

/**
 * Simula que la base falla en una tabla: la renombra durante `fn` (las consultas a esa
 * tabla responden 42P01) y la restaura al terminar.
 */
export async function conTablaCaida<T>(tabla: string, fn: () => Promise<T>): Promise<T> {
  await bd.unsafe(`alter table ${tabla} rename to ${tabla}_caida`);
  try {
    return await fn();
  } finally {
    await bd.unsafe(`alter table ${tabla}_caida rename to ${tabla}`);
  }
}

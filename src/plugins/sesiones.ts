import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from '../db/sql';
import type { JwtPayload } from '../types/index';
import { ipDeRequest } from './audit';

/** Igual que `sign.expiresIn` del JWT (plugins/jwt.ts). */
export const DURACION_SESION_MS = 7 * 24 * 60 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const esUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/**
 * Nombre legible del dispositivo. La app móvil manda "X-Dispositivo" (p. ej.
 * "HUAWEI FRL-L23 · Android 10"); la web solo el User-Agent, del que se toma
 * el navegador y el sistema.
 */
export function dispositivoDe(request: FastifyRequest): string {
  const propio = request.headers['x-dispositivo'];
  if (typeof propio === 'string' && propio.trim()) return propio.trim().slice(0, 120);

  const ua = String(request.headers['user-agent'] ?? '');
  if (!ua) return 'Dispositivo desconocido';
  const navegador =
    /Edg\//.test(ua) ? 'Edge' :
    /OPR\//.test(ua) ? 'Opera' :
    /Chrome\//.test(ua) ? 'Chrome' :
    /Firefox\//.test(ua) ? 'Firefox' :
    /Safari\//.test(ua) ? 'Safari' :
    /Dart\//.test(ua) ? 'App SkonditBeats' : 'Navegador';
  const sistema =
    /Android/.test(ua) ? 'Android' :
    /iPhone|iPad/.test(ua) ? 'iOS' :
    /Windows/.test(ua) ? 'Windows' :
    /Mac OS X/.test(ua) ? 'macOS' :
    /Linux/.test(ua) ? 'Linux' : '';
  return sistema ? `${navegador} · ${sistema}` : navegador;
}

/**
 * Abre una sesión para el usuario y firma su token con el id de la sesión (jti).
 * Devuelve también cuántas OTRAS sesiones tiene abiertas, para que el cliente
 * pueda avisar "tu cuenta está abierta en otro dispositivo".
 */
export async function abrirSesion(
  app: FastifyInstance,
  request: FastifyRequest,
  payload: JwtPayload,
): Promise<{ token: string; otras_sesiones: number }> {
  const [{ id, otras }] = await sql<{ id: string; otras: number }[]>`
    with nueva as (
      insert into sesiones (user_id, dispositivo, ip, expira_at)
      values (${payload.sub}, ${dispositivoDe(request)}, ${ipDeRequest(request)},
              ${new Date(Date.now() + DURACION_SESION_MS)})
      returning id
    )
    select (select id from nueva) as id,
           (select count(*) from sesiones
             where user_id = ${payload.sub} and revocada_at is null and expira_at > now()) as otras`;
  return { token: app.jwt.sign({ ...payload, jti: id }), otras_sesiones: Number(otras) };
}

/** Revoca todas las sesiones abiertas de un usuario, salvo `excepto` si se da. */
export async function revocarSesiones(userId: string, excepto?: string | null): Promise<number> {
  const filas = await sql`
    update sesiones set revocada_at = now()
    where user_id = ${userId} and revocada_at is null
      and (${excepto ?? null}::uuid is null or id <> ${excepto ?? null}::uuid)
    returning id`;
  return filas.length;
}

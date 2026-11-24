import type { FastifyInstance } from 'fastify';
import { sql } from '../../db/sql';
import { registrarAudit, ipDeRequest } from '../../plugins/audit';
import { esUuid, revocarSesiones } from '../../plugins/sesiones';

/**
 * Sesiones abiertas del usuario que hace la petición (web y app).
 * Fuera de /api/auth a propósito: la app trata un 401 en /auth/* como contraseña
 * incorrecta, y aquí un 401 significa que esta misma sesión ya se cerró.
 */
export async function sesionesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  // ─── GET /api/sesiones ─────────────────────────────────────────────────────
  app.get('/', async (request, reply) => {
    const sesiones = await sql`
      select id, dispositivo, ip, created_at, ultimo_uso, expira_at,
             id = ${request.user.jti ?? null}::uuid as actual
      from sesiones
      where user_id = ${request.user.sub} and revocada_at is null and expira_at > now()
      order by (id = ${request.user.jti ?? null}::uuid) desc, ultimo_uso desc`;
    return reply.send({ sesiones });
  });

  // ─── DELETE /api/sesiones/:id ──────────────────────────────────────────────
  // Cierra una sesión propia (por ejemplo, la de un celular perdido).
  app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { id } = request.params;
    if (!esUuid(id)) return reply.code(404).send({ error: 'Sesión no encontrada' });

    const [sesion] = await sql<{ dispositivo: string | null }[]>`
      update sesiones set revocada_at = now()
      where id = ${id} and user_id = ${request.user.sub} and revocada_at is null
      returning dispositivo`;
    if (!sesion) return reply.code(404).send({ error: 'Sesión no encontrada' });

    await registrarAudit(app, {
      user_id: request.user.sub,
      email:   request.user.email,
      accion:  'CIERRE_SESION_REMOTO',
      detalle: `Cerró la sesión de ${sesion.dispositivo ?? 'un dispositivo'}`,
      ip:      ipDeRequest(request)
    });
    return reply.code(204).send();
  });

  // ─── POST /api/sesiones/cerrar-otras ───────────────────────────────────────
  // Deja abierta solo la sesión desde la que se pide.
  app.post('/cerrar-otras', async (request, reply) => {
    const cerradas = await revocarSesiones(request.user.sub, request.user.jti ?? null);
    if (cerradas > 0) {
      await registrarAudit(app, {
        user_id: request.user.sub,
        email:   request.user.email,
        accion:  'CIERRE_SESION_REMOTO',
        detalle: `Cerró ${cerradas} sesión(es) en otros dispositivos`,
        ip:      ipDeRequest(request)
      });
    }
    return reply.send({ cerradas });
  });
}

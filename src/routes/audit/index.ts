import type { FastifyInstance } from 'fastify';
import { sql }                  from '../../db/sql';
import { isAdminRole }          from '../../types/index';

interface AuditQuery {
  limit?:  number;
  accion?: string;
}

export async function auditRoutes(app: FastifyInstance): Promise<void> {

  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', async (request, reply) => {
    if (!isAdminRole(request.user.rol)) {
      return reply.code(403).send({ error: 'Acceso denegado' });
    }
  });

  // ─── GET /api/audit ────────────────────────────────────────────────────────
  // Consultar el historial de accesos (bitácora)
  app.get<{ Querystring: AuditQuery }>('/', async (request, reply) => {
    const limit  = Math.min(Number(request.query.limit ?? 100), 500);
    const accion = request.query.accion;

    try {
      const [registros, acciones] = await Promise.all([
        sql`
          select id, user_id, email, accion, detalle, ip, created_at
          from bitacora
          ${accion ? sql`where accion = ${accion}` : sql``}
          order by created_at desc
          limit ${limit}`,
        // Acciones distintas para el filtro
        sql<{ accion: string }[]>`select distinct accion from bitacora`,
      ]);
      const accionesUnicas = acciones.map(a => a.accion).sort();
      return reply.send({ registros, acciones: accionesUnicas });
    } catch (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al obtener la bitácora' });
    }
  });
}

import type { FastifyInstance } from 'fastify';
import { supabase }             from '../../db/supabase';
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

    let query = supabase
      .from('bitacora')
      .select('id, user_id, email, accion, detalle, ip, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (accion) {
      query = query.eq('accion', accion);
    }

    const { data, error } = await query;

    if (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al obtener la bitácora' });
    }

    // Acciones distintas para el filtro
    const { data: acciones } = await supabase
      .from('bitacora')
      .select('accion');

    const accionesUnicas = [...new Set((acciones ?? []).map(a => a.accion))].sort();

    return reply.send({ registros: data ?? [], acciones: accionesUnicas });
  });
}

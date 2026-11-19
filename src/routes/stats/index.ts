import type { FastifyInstance } from 'fastify';
import { sql }                  from '../../db/sql';
import { isAdminRole }          from '../../types/index';

export async function statsRoutes(app: FastifyInstance): Promise<void> {

  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', async (request, reply) => {
    if (!isAdminRole(request.user.rol)) {
      return reply.code(403).send({ error: 'Acceso denegado' });
    }
  });

  // ─── GET /api/stats ────────────────────────────────────────────────────────
  app.get('/', async (_request, reply) => {

    // Conteos y destacados en una sola ida a la base.
    const [[resumen], beatMasCaro, ultimoUsuario, orderItems, ordenes, beatsRecientes] = await Promise.all([
      sql<{ total_usuarios: number; total_beats: number }[]>`
        select (select count(*) from users where rol = 'CLIENTE' and activo) as total_usuarios,
               (select count(*) from beats where activo)                    as total_beats`,
      // Beat más caro
      sql`select id, nombre, precio, genero from beats where activo order by precio desc limit 1`,
      // Último cliente registrado
      sql`select id, nombre, email, fecha_registro from users where rol = 'CLIENTE' order by fecha_registro desc limit 1`,
      // Renglones vendidos con su beat (para los más comprados y los géneros)
      sql<{ beat_id: string; nombre: string | null; genero: string | null }[]>`
        select oi.beat_id, b.nombre, b.genero
        from order_items oi left join beats b on b.id = oi.beat_id`,
      // Órdenes completadas con su cliente
      sql<{ user_id: string; total: number; nombre: string | null; email: string | null }[]>`
        select o.user_id, o.total, u.nombre, u.email
        from orders o left join users u on u.id = o.user_id
        where o.status = 'COMPLETADO'`,
      // Beats recientes (últimos 5)
      sql`
        select id, nombre, genero, bpm, precio, imagen_url, created_at
        from beats where activo order by created_at desc limit 5`,
    ]);
    const totalUsuarios = resumen.total_usuarios;
    const totalBeats    = resumen.total_beats;

    // Contar ventas por beat
    const ventasPorBeat: Record<string, { nombre: string; genero: string; ventas: number }> = {};
    for (const item of orderItems) {
      const id = item.beat_id;
      if (!ventasPorBeat[id]) {
        ventasPorBeat[id] = { nombre: item.nombre ?? 'Desconocido', genero: item.genero ?? '-', ventas: 0 };
      }
      ventasPorBeat[id].ventas++;
    }

    const beatsMasComprados = Object.values(ventasPorBeat)
      .sort((a, b) => b.ventas - a.ventas)
      .slice(0, 5);

    // Ventas por género
    const ventasPorGenero: Record<string, number> = {};
    for (const item of orderItems) {
      const genero = item.genero ?? 'Otro';
      ventasPorGenero[genero] = (ventasPorGenero[genero] ?? 0) + 1;
    }

    const generosMasComprados = Object.entries(ventasPorGenero)
      .map(([genero, ventas]) => ({ genero, ventas }))
      .sort((a, b) => b.ventas - a.ventas);

    // Clientes con más compras (top 5)
    const gastosPorUsuario: Record<string, { nombre: string; email: string; total: number; ordenes: number }> = {};
    for (const orden of ordenes) {
      const uid = orden.user_id;
      if (!gastosPorUsuario[uid]) {
        gastosPorUsuario[uid] = { nombre: orden.nombre ?? 'Desconocido', email: orden.email ?? '-', total: 0, ordenes: 0 };
      }
      gastosPorUsuario[uid].total   += Number(orden.total);
      gastosPorUsuario[uid].ordenes += 1;
    }

    const topClientes = Object.values(gastosPorUsuario)
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);

    return reply.send({
      totalUsuarios:      totalUsuarios   ?? 0,
      totalBeats:         totalBeats      ?? 0,
      beatMasCaro:        beatMasCaro[0]   ?? null,
      ultimoUsuario:      ultimoUsuario[0] ?? null,
      beatsMasComprados,
      generosMasComprados,
      topClientes,
      beatsRecientes
    });
  });
}
import type { FastifyInstance } from 'fastify';
import { supabase }             from '../../db/supabase';
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

    // Total clientes
    const { count: totalUsuarios } = await supabase
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('rol', 'CLIENTE')
      .eq('activo', true);

    // Total beats activos
    const { count: totalBeats } = await supabase
      .from('beats')
      .select('id', { count: 'exact', head: true })
      .eq('activo', true);

    // Beat más caro
    const { data: beatMasCaro } = await supabase
      .from('beats')
      .select('id, nombre, precio, genero')
      .eq('activo', true)
      .order('precio', { ascending: false })
      .limit(1)
      .single();

    // Último cliente registrado
    const { data: ultimoUsuario } = await supabase
      .from('users')
      .select('id, nombre, email, fecha_registro')
      .eq('rol', 'CLIENTE')
      .order('fecha_registro', { ascending: false })
      .limit(1)
      .single();

    // Beats más comprados (top 5)
    const { data: orderItems } = await supabase
      .from('order_items')
      .select('beat_id, beats(nombre, genero)');

    // Contar ventas por beat
    const ventasPorBeat: Record<string, { nombre: string; genero: string; ventas: number }> = {};
    for (const item of orderItems ?? []) {
      const id = item.beat_id;
      if (!ventasPorBeat[id]) {
        ventasPorBeat[id] = {
          nombre: (item.beats as any)?.nombre ?? 'Desconocido',
          genero: (item.beats as any)?.genero ?? '-',
          ventas: 0
        };
      }
      ventasPorBeat[id].ventas++;
    }

    const beatsMasComprados = Object.values(ventasPorBeat)
      .sort((a, b) => b.ventas - a.ventas)
      .slice(0, 5);

    // Ventas por género
    const ventasPorGenero: Record<string, number> = {};
    for (const item of orderItems ?? []) {
      const genero = (item.beats as any)?.genero ?? 'Otro';
      ventasPorGenero[genero] = (ventasPorGenero[genero] ?? 0) + 1;
    }

    const generosMasComprados = Object.entries(ventasPorGenero)
      .map(([genero, ventas]) => ({ genero, ventas }))
      .sort((a, b) => b.ventas - a.ventas);

    // Clientes con más compras (top 5)
    const { data: ordenes } = await supabase
      .from('orders')
      .select('user_id, total, users(nombre, email)')
      .eq('status', 'COMPLETADO');

    const gastosPorUsuario: Record<string, { nombre: string; email: string; total: number; ordenes: number }> = {};
    for (const orden of ordenes ?? []) {
      const uid = orden.user_id;
      if (!gastosPorUsuario[uid]) {
        gastosPorUsuario[uid] = {
          nombre:  (orden.users as any)?.nombre ?? 'Desconocido',
          email:   (orden.users as any)?.email  ?? '-',
          total:   0,
          ordenes: 0
        };
      }
      gastosPorUsuario[uid].total   += Number(orden.total);
      gastosPorUsuario[uid].ordenes += 1;
    }

    const topClientes = Object.values(gastosPorUsuario)
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);

    // Beats recientes (últimos 5)
    const { data: beatsRecientes } = await supabase
      .from('beats')
      .select('id, nombre, genero, bpm, precio, imagen_url, created_at')
      .eq('activo', true)
      .order('created_at', { ascending: false })
      .limit(5);

    return reply.send({
      totalUsuarios:      totalUsuarios   ?? 0,
      totalBeats:         totalBeats      ?? 0,
      beatMasCaro:        beatMasCaro     ?? null,
      ultimoUsuario:      ultimoUsuario   ?? null,
      beatsMasComprados,
      generosMasComprados,
      topClientes,
      beatsRecientes:     beatsRecientes  ?? []
    });
  });
}
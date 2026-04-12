import type { FastifyInstance } from 'fastify';
import { supabase }             from '../../db/supabase';
import { isAdminRole }          from '../../types/index';

export async function usersRoutes(app: FastifyInstance): Promise<void> {

  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', async (request, reply) => {
    if (!isAdminRole(request.user.rol)) {
      return reply.code(403).send({ error: 'Acceso denegado' });
    }
  });


  // ─── GET /api/users ────────────────────────────────────────────────────────
  app.get('/', async (_request, reply) => {
    const { data: users, error } = await supabase
      .from('users')
      .select('id, email, username, nombre, foto_url, activo, fecha_registro')
      .eq('rol', 'CLIENTE')
      .order('fecha_registro', { ascending: false });

    if (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al obtener usuarios' });
    }

    // Obtener todas las órdenes completadas con sus items de una sola query
    const { data: todasOrdenes } = await supabase
      .from('orders')
      .select('user_id, order_items(id)')
      .eq('status', 'COMPLETADO');

    // Construir mapa de user_id → cantidad de beats comprados
    const beatsPorUsuario: Record<string, number> = {};
    for (const orden of todasOrdenes ?? []) {
      const uid   = orden.user_id;
      const items = Array.isArray(orden.order_items) ? orden.order_items.length : 0;
      beatsPorUsuario[uid] = (beatsPorUsuario[uid] ?? 0) + items;
    }

    const usersConBeats = (users ?? []).map(user => ({
      ...user,
      beats_comprados: beatsPorUsuario[user.id] ?? 0
    }));

    return reply.send({ users: usersConBeats });
  });


  // ─── GET /api/users/:id ────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { data, error } = await supabase
      .from('users')
      .select('id, email, username, nombre, foto_url, direccion, telefono, edad, activo, fecha_registro')
      .eq('id', request.params.id)
      .eq('rol', 'CLIENTE')
      .single();

    if (error || !data) {
      return reply.code(404).send({ error: 'Usuario no encontrado' });
    }

    const { data: compras } = await supabase
      .from('orders')
      .select(`
        id, total, created_at,
        order_items (
          beats ( id, nombre, genero, precio, imagen_url )
        )
      `)
      .eq('user_id', request.params.id)
      .eq('status', 'COMPLETADO')
      .order('created_at', { ascending: false });

    return reply.send({ user: data, compras: compras ?? [] });
  });


  // ─── PUT /api/users/:id ────────────────────────────────────────────────────
  app.put<{
    Params: { id: string };
    Body:   { activo: boolean };
  }>('/:id', {
    schema: {
      body: {
        type: 'object',
        required: ['activo'],
        properties: {
          activo: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    const { activo } = request.body;

    const { data, error } = await supabase
      .from('users')
      .update({ activo, updated_at: new Date().toISOString() })
      .eq('id', request.params.id)
      .eq('rol', 'CLIENTE')
      .select('id, email, nombre, activo')
      .single();

    if (error || !data) {
      return reply.code(404).send({ error: 'Usuario no encontrado' });
    }

    return reply.send({ user: data });
  });
}
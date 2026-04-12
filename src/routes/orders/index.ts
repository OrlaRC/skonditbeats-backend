import type { FastifyInstance } from 'fastify';
import { supabase }             from '../../db/supabase';

interface OrderBody {
  beats: string[]; // array de beat IDs
}

export async function ordersRoutes(app: FastifyInstance): Promise<void> {

  // Todas las rutas requieren token
  app.addHook('preHandler', app.authenticate);


  // ─── POST /api/orders ──────────────────────────────────────────────────────
  // Crear una orden (pago simulado)
  app.post<{ Body: OrderBody }>('/', {
    schema: {
      body: {
        type: 'object',
        required: ['beats'],
        properties: {
          beats: { type: 'array', items: { type: 'string' }, minItems: 1 }
        }
      }
    }
  }, async (request, reply) => {
    const { beats: beatIds } = request.body;
    const userId = request.user.sub;

    // Obtener precios reales de la BD
    const { data: beatsData, error: beatsError } = await supabase
      .from('beats')
      .select('id, nombre, precio')
      .in('id', beatIds)
      .eq('activo', true);

    if (beatsError || !beatsData || beatsData.length === 0) {
      return reply.code(400).send({ error: 'Beats no encontrados' });
    }

    // Verificar que no haya comprado ya alguno de estos beats
    const { data: comprasExistentes } = await supabase
      .from('order_items')
      .select('beat_id, orders!inner(user_id, status)')
      .in('beat_id', beatIds)
      .eq('orders.user_id', userId)
      .eq('orders.status', 'COMPLETADO');

    if (comprasExistentes && comprasExistentes.length > 0) {
      return reply.code(409).send({ error: 'Ya tienes uno o más de estos beats' });
    }

    const total = beatsData.reduce((sum, b) => sum + Number(b.precio), 0);

    // Crear la orden
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert({ user_id: userId, total, status: 'COMPLETADO' })
      .select('id')
      .single();

    if (orderError || !order) {
      app.log.error(orderError);
      return reply.code(500).send({ error: 'Error al crear la orden' });
    }

    // Crear los items
    const items = beatsData.map(b => ({
      order_id:        order.id,
      beat_id:         b.id,
      precio_unitario: Number(b.precio)
    }));

    const { error: itemsError } = await supabase
      .from('order_items')
      .insert(items);

    if (itemsError) {
      app.log.error(itemsError);
      return reply.code(500).send({ error: 'Error al guardar los items' });
    }

    return reply.code(201).send({
      order: { id: order.id, total, status: 'COMPLETADO', items: beatsData }
    });
  });


  // ─── GET /api/orders/mis-compras ───────────────────────────────────────────
  app.get('/mis-compras', async (request, reply) => {
    const { data, error } = await supabase
      .from('orders')
      .select(`
        id, total, status, created_at,
        order_items (
          id, precio_unitario,
          beats ( id, nombre, genero, bpm, imagen_url, audio_url )
        )
      `)
      .eq('user_id', request.user.sub)
      .eq('status', 'COMPLETADO')
      .order('created_at', { ascending: false });

    if (error) {
      return reply.code(500).send({ error: 'Error al obtener compras' });
    }

    return reply.send({ orders: data });
  });
}
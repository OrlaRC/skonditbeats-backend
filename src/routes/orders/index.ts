import type { FastifyInstance } from 'fastify';
import { supabase }             from '../../db/supabase';
import { registrarAudit, ipDeRequest } from '../../plugins/audit';

interface OrderBody {
  beats?:  string[]; // array de beat IDs
  packId?: string;   // opcional: compra de un paquete
}

interface ExchangeBody {
  beatOrigen: string;  // beat que estaba en el paquete
  beatNuevo:  string;  // beat por el que se intercambia
}

export async function ordersRoutes(app: FastifyInstance): Promise<void> {

  // Todas las rutas requieren token
  app.addHook('preHandler', app.authenticate);


  // ─── POST /api/orders ──────────────────────────────────────────────────────
  // Crear una orden (pago simulado). Acepta beats sueltos o un paquete (packId).
  app.post<{ Body: OrderBody }>('/', {
    schema: {
      body: {
        type: 'object',
        properties: {
          beats:  { type: 'array', items: { type: 'string' }, minItems: 1 },
          packId: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { beats: beatIds, packId } = request.body;
    const userId = request.user.sub;

    // ── Compra de un PAQUETE ────────────────────────────────────────────────
    if (packId) {
      return comprarPaquete(app, request, reply, packId, userId);
    }

    if (!beatIds || beatIds.length === 0) {
      return reply.code(400).send({ error: 'Se requiere beats o packId' });
    }

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
        id, total, status, created_at, pack_id,
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


  // ─── POST /api/orders/:id/intercambiar ────────────────────────────────────
  // Intercambio 1:1 dentro de un paquete comprado.
  app.post<{ Params: { id: string }; Body: ExchangeBody }>(
    '/:id/intercambiar',
    async (request, reply) => {
      const { id: orderId } = request.params;
      const { beatOrigen, beatNuevo } = request.body;
      const userId = request.user.sub;

      if (!beatOrigen || !beatNuevo) {
        return reply.code(400).send({ error: 'beatOrigen y beatNuevo son obligatorios' });
      }

      // 1) La orden debe existir, estar COMPLETADA, ser del usuario y ser de un paquete
      const { data: order, error: orderError } = await supabase
        .from('orders')
        .select('id, pack_id, user_id, status')
        .eq('id', orderId)
        .eq('user_id', userId)
        .single();

      if (orderError || !order) {
        return reply.code(404).send({ error: 'Orden no encontrada' });
      }

      if (order.status !== 'COMPLETADO' || !order.pack_id) {
        return reply.code(400).send({ error: 'La orden no es un paquete comprado' });
      }

      // 2) El beat de origen debe ser parte del paquete
      const { data: enPaquete } = await supabase
        .from('pack_beats')
        .select('beat_id')
        .eq('pack_id', order.pack_id)
        .eq('beat_id', beatOrigen)
        .single();

      if (!enPaquete) {
        return reply.code(400).send({ error: 'El beat de origen no pertenece al paquete' });
      }

      // 3) El beat nuevo debe existir y estar activo
      const { data: beatNuevoData, error: beatNuevoError } = await supabase
        .from('beats')
        .select('id, nombre, precio')
        .eq('id', beatNuevo)
        .eq('activo', true)
        .single();

      if (beatNuevoError || !beatNuevoData) {
        return reply.code(404).send({ error: 'Beat nuevo no encontrado' });
      }

      // 4) Verificar que no haya intercambiado ya este beat en esta orden
      const { data: yaIntercambiado } = await supabase
        .from('pack_intercambios')
        .select('id')
        .eq('order_id', orderId)
        .eq('beat_origen', beatOrigen)
        .maybeSingle();

      if (yaIntercambiado) {
        return reply.code(409).send({ error: 'Ese beat ya fue intercambiado en esta orden' });
      }

      // 5) Registrar el intercambio
      const { error: exError } = await supabase
        .from('pack_intercambios')
        .insert({
          user_id:     userId,
          order_id:    orderId,
          pack_id:     order.pack_id,
          beat_origen: beatOrigen,
          beat_cambia: beatNuevo
        });

      if (exError) {
        app.log.error(exError);
        return reply.code(500).send({ error: 'Error al registrar el intercambio' });
      }

      await registrarAudit(app, {
        user_id: userId,
        email:   request.user.email,
        accion:  'INTERCAMBIO_BEAT',
        detalle: `Intercambio en paquete (orden ${orderId}): beat ${beatOrigen} → ${beatNuevo}`,
        ip:      ipDeRequest(request)
      });

      return reply.send({ message: 'Intercambio realizado', beat: beatNuevoData });
    }
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Compra de un paquete: crea la orden marcada con pack_id y los items de sus beats
// ──────────────────────────────────────────────────────────────────────────────
async function comprarPaquete(
  app:    FastifyInstance,
  request: any,
  reply:   any,
  packId:  string,
  userId:  string
) {
  // Obtener el paquete con sus beats
  const { data: pack, error: packError } = await supabase
    .from('packs')
    .select(`
      id, nombre, precio, activo,
      pack_beats ( beats ( id, nombre, precio ) )
    `)
    .eq('id', packId)
    .eq('activo', true)
    .single();

  if (packError || !pack) {
    return reply.code(404).send({ error: 'Paquete no encontrado' });
  }

  const beatsDelPack = (pack.pack_beats ?? []).map((pb: any) => pb.beats).filter(Boolean);

  if (beatsDelPack.length === 0) {
    return reply.code(400).send({ error: 'El paquete no tiene beats' });
  }

  // Verificar que el usuario no tenga ya alguno de esos beats
  const { data: comprasExistentes } = await supabase
    .from('order_items')
    .select('beat_id, orders!inner(user_id, status)')
    .in('beat_id', beatsDelPack.map((b: any) => b.id))
    .eq('orders.user_id', userId)
    .eq('orders.status', 'COMPLETADO');

  if (comprasExistentes && comprasExistentes.length > 0) {
    return reply.code(409).send({ error: 'Ya tienes uno o más de los beats de este paquete' });
  }

  const total = Number(pack.precio);

  const { data: order, error: orderError } = await supabase
    .from('orders')
    .insert({ user_id: userId, total, status: 'COMPLETADO', pack_id: pack.id })
    .select('id')
    .single();

  if (orderError || !order) {
    app.log.error(orderError);
    return reply.code(500).send({ error: 'Error al crear la orden' });
  }

  const items = beatsDelPack.map((b: any) => ({
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

  await registrarAudit(app, {
    user_id: userId,
    email:   request.user.email,
    accion:  'COMPRA_PAQUETE',
    detalle: `Compra del paquete "${pack.nombre}" ($${total})`,
    ip:      ipDeRequest(request)
  });

  return reply.code(201).send({
    order: { id: order.id, total, status: 'COMPLETADO', pack_id: pack.id, items: beatsDelPack }
  });
}
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql, filasONada }      from '../../db/sql';
import { registrarAudit, ipDeRequest } from '../../plugins/audit';
import { claveIdempotencia, esDuplicado } from '../../plugins/idempotencia';

interface OrderBody {
  beats?:  string[]; // array de beat IDs
  packId?: string;   // opcional: compra de un paquete
}

interface ExchangeBody {
  beatOrigen: string;  // beat que estaba en el paquete
  beatNuevo:  string;  // beat por el que se intercambia
}

type BeatVenta = { id: string; nombre: string; precio: number };

/** Error que se lanza dentro de la transacción para responder un código concreto. */
class Rechazo extends Error {
  constructor(readonly codigo: number, mensaje: string) { super(mensaje); }
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

    // Reintento de un pago cuya respuesta se perdió: se devuelve la orden que ya
    // existe en lugar de rechazarla con 409 o cobrarla otra vez.
    const clientRef = claveIdempotencia(request);
    if (clientRef) {
      const previa = await ordenPorClave(clientRef, userId);
      if (previa) return reply.code(200).send({ order: previa, repetida: true });
    }

    // ── Compra de un PAQUETE ────────────────────────────────────────────────
    if (packId) {
      return comprarPaquete(app, request, reply, packId, userId, clientRef);
    }

    if (!beatIds || beatIds.length === 0) {
      return reply.code(400).send({ error: 'Se requiere beats o packId' });
    }

    // Obtener precios reales de la BD.
    // 22P02 = algún id no tiene formato de UUID: es un dato inválido, no una falla del servidor.
    let beatsData: BeatVenta[];
    try {
      beatsData = await filasONada(sql<BeatVenta[]>`
        select id, nombre, precio from beats where id in ${sql(beatIds)} and activo`);
    } catch (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al consultar los beats' });
    }

    // La petición está bien formada pero no se puede cumplir: se pidió algún beat que
    // no existe o ya no está a la venta. Antes se cobraban solo los encontrados y los
    // demás se descartaban sin avisar (Práctica 11, hallazgo DEF-03).
    const pedidos = new Set(beatIds);
    if (beatsData.length < pedidos.size) {
      return reply.code(422).send({ error: 'Uno o más beats no existen o ya no están a la venta' });
    }

    const total = beatsData.reduce((sum, b) => sum + Number(b.precio), 0);

    const orderId = await guardarOrden(app, reply, {
      userId, clientRef, total, packId: null, beats: beatsData,
      yaTiene: 'Ya tienes uno o más de estos beats',
    });
    if (!orderId) return reply;

    return reply.code(201).send({
      order: { id: orderId, total, status: 'COMPLETADO', items: beatsData }
    });
  });


  // ─── GET /api/orders/mis-compras ───────────────────────────────────────────
  app.get('/mis-compras', async (request, reply) => {
    try {
      // Misma forma que devolvía PostgREST: order_items: [{ id, precio_unitario, beats: {...} }]
      const orders = await sql`
        select o.id, o.total, o.status, o.created_at, o.pack_id,
               coalesce((
                 select json_agg(json_build_object(
                          'id', oi.id, 'precio_unitario', oi.precio_unitario,
                          'beats', case when b.id is null then null else json_build_object(
                            'id', b.id, 'nombre', b.nombre, 'genero', b.genero, 'bpm', b.bpm,
                            'imagen_url', b.imagen_url, 'audio_url', b.audio_url) end))
                 from order_items oi left join beats b on b.id = oi.beat_id
                 where oi.order_id = o.id
               ), '[]'::json) as order_items
        from orders o
        where o.user_id = ${request.user.sub} and o.status = 'COMPLETADO'
        order by o.created_at desc`;
      return reply.send({ orders });
    } catch (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al obtener compras' });
    }
  });


  // ─── POST /api/orders/:id/intercambiar ────────────────────────────────────
  // Intercambio 1:1 dentro de un paquete comprado.
  app.post<{ Params: { id: string }; Body: ExchangeBody }>(
    '/:id/intercambiar',
    async (request, reply) => {
      const { id: orderId } = request.params;
      const { beatOrigen, beatNuevo } = request.body ?? {};
      const userId = request.user.sub;

      if (!beatOrigen || !beatNuevo) {
        return reply.code(400).send({ error: 'beatOrigen y beatNuevo son obligatorios' });
      }

      // 1) La orden debe existir, estar COMPLETADA, ser del usuario y ser de un paquete
      const [order] = await filasONada(sql<{ id: string; pack_id: string | null; status: string }[]>`
        select id, pack_id, status from orders where id = ${orderId} and user_id = ${userId}`);

      if (!order) {
        return reply.code(404).send({ error: 'Orden no encontrada' });
      }

      if (order.status !== 'COMPLETADO' || !order.pack_id) {
        return reply.code(400).send({ error: 'La orden no es un paquete comprado' });
      }

      // 2) El beat de origen debe ser parte del paquete
      const [enPaquete] = await filasONada(sql`
        select beat_id from pack_beats where pack_id = ${order.pack_id} and beat_id = ${beatOrigen}`);

      if (!enPaquete) {
        return reply.code(400).send({ error: 'El beat de origen no pertenece al paquete' });
      }

      // 3) El beat nuevo debe existir y estar activo
      const [beatNuevoData] = await filasONada(sql<BeatVenta[]>`
        select id, nombre, precio from beats where id = ${beatNuevo} and activo`);

      if (!beatNuevoData) {
        return reply.code(404).send({ error: 'Beat nuevo no encontrado' });
      }

      // 4) Verificar que no haya intercambiado ya este beat en esta orden
      const [yaIntercambiado] = await sql`
        select id from pack_intercambios where order_id = ${orderId} and beat_origen = ${beatOrigen}`;

      if (yaIntercambiado) {
        return reply.code(409).send({ error: 'Ese beat ya fue intercambiado en esta orden' });
      }

      // 5) Registrar el intercambio
      try {
        await sql`
          insert into pack_intercambios (user_id, order_id, pack_id, beat_origen, beat_cambia)
          values (${userId}, ${orderId}, ${order.pack_id}, ${beatOrigen}, ${beatNuevo})`;
      } catch (error) {
        app.log.error(error);
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

async function ordenPorClave(clientRef: string, userId: string) {
  const [orden] = await sql`
    select id, total, status, pack_id from orders
    where client_ref = ${clientRef} and user_id = ${userId}`;
  return orden ?? null;
}

/**
 * Guarda la orden COMPLETADA y sus renglones en UNA transacción. Antes eran dos
 * llamadas a PostgREST y, si fallaban los renglones, se borraba la orden a mano
 * (Práctica 11, hallazgo DEF-04); ahora la base deshace todo sola.
 *
 * Dentro de la misma transacción se revisa que el cliente no tenga ya alguno de los
 * beats; si otra compra simultánea gana la carrera, el trigger trg_compra_unica
 * responde 23505 y también se deshace todo (DEF-08).
 */
async function guardarOrden(
  app: FastifyInstance,
  reply: FastifyReply,
  o: {
    userId: string;
    clientRef: string | null;
    total: number;
    packId: string | null;
    beats: BeatVenta[];
    yaTiene: string;
  },
): Promise<string | null> {
  try {
    const orderId = await sql.begin(async tx => {
      const [compra] = await tx`
        select 1 from order_items oi join orders od on od.id = oi.order_id
        where oi.beat_id in ${tx(o.beats.map(b => b.id))}
          and od.user_id = ${o.userId} and od.status = 'COMPLETADO'
        limit 1`;
      if (compra) throw new Rechazo(409, o.yaTiene);

      const [order] = await tx<{ id: string }[]>`
        insert into orders (user_id, total, status, pack_id, client_ref)
        values (${o.userId}, ${o.total}, 'COMPLETADO', ${o.packId}, ${o.clientRef})
        returning id`;

      await tx`insert into order_items ${tx(o.beats.map(b => ({
        order_id: order.id, beat_id: b.id, precio_unitario: Number(b.precio),
      })))}`;
      return order.id;
    });
    return orderId;
  } catch (error) {
    if (error instanceof Rechazo) {
      reply.code(error.codigo).send({ error: error.message });
      return null;
    }
    if (esDuplicado(error as { code?: string })) {
      const restriccion = (error as { constraint_name?: string }).constraint_name ?? '';
      // Dos envíos simultáneos con la misma clave: solo uno pasa la restricción UNIQUE.
      if (o.clientRef && restriccion.includes('client_ref')) {
        reply.code(200).send({ order: await ordenPorClave(o.clientRef, o.userId), repetida: true });
        return null;
      }
      // trg_compra_unica: otra compra simultánea del mismo beat ganó la carrera (DEF-08).
      reply.code(409).send({ error: o.yaTiene });
      return null;
    }
    app.log.error(error);
    reply.code(500).send({ error: 'Error al crear la orden' });
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Compra de un paquete: crea la orden marcada con pack_id y los items de sus beats
// ──────────────────────────────────────────────────────────────────────────────
async function comprarPaquete(
  app:     FastifyInstance,
  request: FastifyRequest,
  reply:   FastifyReply,
  packId:  string,
  userId:  string,
  clientRef: string | null
) {
  // Obtener el paquete con sus beats
  let pack: { id: string; nombre: string; precio: number } | undefined;
  let beatsDelPack: BeatVenta[] = [];
  try {
    [pack] = await filasONada(sql<{ id: string; nombre: string; precio: number }[]>`
      select id, nombre, precio from packs where id = ${packId} and activo`);
    if (pack) {
      beatsDelPack = await sql<BeatVenta[]>`
        select b.id, b.nombre, b.precio
        from pack_beats pb join beats b on b.id = pb.beat_id
        where pb.pack_id = ${pack.id}`;
    }
  } catch (error) {
    app.log.error(error);
    return reply.code(500).send({ error: 'Error al consultar el paquete' });
  }

  if (!pack) {
    return reply.code(404).send({ error: 'Paquete no encontrado' });
  }

  if (beatsDelPack.length === 0) {
    return reply.code(400).send({ error: 'El paquete no tiene beats' });
  }

  const total = Number(pack.precio);
  const nombre = pack.nombre;
  const idPack = pack.id;

  const orderId = await guardarOrden(app, reply, {
    userId, clientRef, total, packId: idPack, beats: beatsDelPack,
    yaTiene: 'Ya tienes uno o más de los beats de este paquete',
  });
  if (!orderId) return reply;

  await registrarAudit(app, {
    user_id: userId,
    email:   request.user.email,
    accion:  'COMPRA_PAQUETE',
    detalle: `Compra del paquete "${nombre}" ($${total})`,
    ip:      ipDeRequest(request)
  });

  return reply.code(201).send({
    order: { id: orderId, total, status: 'COMPLETADO', pack_id: idPack, items: beatsDelPack }
  });
}

import type { FastifyInstance } from 'fastify';
import { sql, esFormatoInvalido } from '../../db/sql';
import { isAdminRole }          from '../../types/index';
import { registrarAudit, ipDeRequest } from '../../plugins/audit';
import { claveIdempotencia, esDuplicado } from '../../plugins/idempotencia';

/** Cuerpo de alta/edición. Antes un precio negativo o un id de beat mal formado llegaban a la base. */
const ESQUEMA_PACK = {
  body: {
    type: 'object',
    required: ['nombre', 'precio', 'beat_ids'],
    properties: {
      nombre:      { type: 'string', minLength: 2, maxLength: 150 },
      descripcion: { type: ['string', 'null'], maxLength: 1000 },
      imagen_url:  { type: ['string', 'null'] },
      precio:      { type: 'number', minimum: 0, maximum: 1000000 },
      beat_ids:    { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true,
                     items: { type: 'string', format: 'uuid' } }
    }
  }
} as const;

interface PackBody {
  nombre:      string;
  descripcion?: string | null;
  imagen_url?:  string | null;
  precio:      number;
  beat_ids?:    string[];
}

interface Params {
  id: string;
}

/**
 * Paquete con sus beats, con la misma forma que devolvía PostgREST:
 *   { ..., pack_beats: [ { beats: { id, nombre, ... } } ] }
 */
const consultaPacks = (filtro: ReturnType<typeof sql>) => sql`
  select p.id, p.nombre, p.descripcion, p.imagen_url, p.precio, p.activo, p.created_at,
         coalesce((
           select json_agg(json_build_object('beats', json_build_object(
                    'id', b.id, 'nombre', b.nombre, 'genero', b.genero, 'bpm', b.bpm,
                    'precio', b.precio, 'imagen_url', b.imagen_url, 'audio_url', b.audio_url))
                  order by b.nombre)
           from pack_beats pb join beats b on b.id = pb.beat_id
           where pb.pack_id = p.id
         ), '[]'::json) as pack_beats
  from packs p
  ${filtro}`;

export async function packRoutes(app: FastifyInstance): Promise<void> {

  // ─── GET /api/packs ─────────────────────────────────────────────────────────
  // Público: lista los paquetes activos con sus beats
  app.get('/', async (_request, reply) => {
    try {
      const packs = await consultaPacks(sql`where p.activo order by p.created_at desc, p.nombre`);
      return reply.send({ packs });
    } catch (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al obtener los paquetes' });
    }
  });


  // ─── GET /api/packs/:id ────────────────────────────────────────────────────
  app.get<{ Params: Params }>('/:id', async (request, reply) => {
    let pack;
    try {
      [pack] = await consultaPacks(sql`where p.id = ${request.params.id}`);
    } catch (error) {
      if (!esFormatoInvalido(error)) {
        app.log.error(error);
        return reply.code(500).send({ error: 'Error al obtener el paquete' });
      }
    }

    if (!pack) {
      return reply.code(404).send({ error: 'Paquete no encontrado' });
    }

    return reply.send({ pack });
  });


  // ─── POST /api/packs ───────────────────────────────────────────────────────
  app.post<{ Body: PackBody }>('/', {
    preHandler: [app.authenticate],
    schema: ESQUEMA_PACK
  }, async (request, reply) => {
    if (!isAdminRole(request.user.rol)) {
      return reply.code(403).send({ error: 'Acceso denegado' });
    }

    const { nombre, descripcion, imagen_url, precio, beat_ids } = request.body;

    if (!nombre || precio === undefined) {
      return reply.code(400).send({ error: 'nombre y precio son obligatorios' });
    }

    if (!beat_ids || beat_ids.length === 0) {
      return reply.code(400).send({ error: 'El paquete debe incluir al menos un beat' });
    }

    // El paquete y sus beats en una transacción: o se guarda todo o nada
    // (antes, si fallaba el vínculo, se intentaba borrar a mano el paquete a medias).
    const clientRef = claveIdempotencia(request);
    let pack: { id: string };
    try {
      pack = await sql.begin(async tx => {
        const [nuevo] = await tx<{ id: string }[]>`
          insert into packs (nombre, descripcion, imagen_url, precio, client_ref)
          values (${nombre}, ${descripcion ?? null}, ${imagen_url ?? null}, ${Number(precio)}, ${clientRef})
          returning id`;
        await tx`
          insert into pack_beats ${tx(beat_ids.map(beatId => ({ pack_id: nuevo.id, beat_id: beatId })))}`;
        return nuevo;
      });
    } catch (error) {
      // Reintento de un alta que sí llegó: se responde el paquete ya creado.
      if (clientRef && esDuplicado(error as { code?: string })) {
        const [existente] = await sql<{ id: string }[]>`select id from packs where client_ref = ${clientRef}`;
        if (existente) return reply.code(200).send({ pack: existente });
      }
      // Un beat que no existe viola la llave foránea de pack_beats.
      if ((error as { code?: string }).code === '23503') {
        return reply.code(400).send({ error: 'Uno de los beats elegidos ya no existe' });
      }
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al crear el paquete' });
    }

    await registrarAudit(app, {
      user_id: request.user.sub,
      email:   request.user.email,
      accion:  'ALTA_PAQUETE',
      detalle: `Se creó el paquete "${nombre}" con ${beat_ids.length} beat(s)`,
      ip:      ipDeRequest(request)
    });

    return reply.code(201).send({ pack });
  });


  // ─── PUT /api/packs/:id ────────────────────────────────────────────────────
  app.put<{ Params: Params; Body: PackBody }>('/:id', {
    preHandler: [app.authenticate],
    schema: ESQUEMA_PACK
  }, async (request, reply) => {
    if (!isAdminRole(request.user.rol)) {
      return reply.code(403).send({ error: 'Acceso denegado' });
    }

    const { nombre, descripcion, imagen_url, precio, beat_ids } = request.body;

    if (!nombre || precio === undefined) {
      return reply.code(400).send({ error: 'nombre y precio son obligatorios' });
    }

    if (!beat_ids || beat_ids.length === 0) {
      return reply.code(400).send({ error: 'El paquete debe incluir al menos un beat' });
    }

    // Datos y beats del paquete en una transacción.
    let pack: { id: string } | undefined;
    try {
      pack = await sql.begin(async tx => {
        const [editado] = await tx<{ id: string }[]>`
          update packs
          set nombre = ${nombre}, descripcion = ${descripcion ?? null}, imagen_url = ${imagen_url ?? null},
              precio = ${Number(precio)}, updated_at = now()
          where id = ${request.params.id}
          returning id`;
        if (!editado) return undefined;
        await tx`delete from pack_beats where pack_id = ${editado.id}`;
        await tx`
          insert into pack_beats ${tx(beat_ids.map(beatId => ({ pack_id: editado.id, beat_id: beatId })))}`;
        return editado;
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23503') {
        return reply.code(400).send({ error: 'Uno de los beats elegidos ya no existe' });
      }
      if (!esFormatoInvalido(error)) {
        app.log.error(error);
        return reply.code(500).send({ error: 'Error al editar el paquete' });
      }
    }

    if (!pack) {
      return reply.code(404).send({ error: 'Paquete no encontrado' });
    }

    await registrarAudit(app, {
      user_id: request.user.sub,
      email:   request.user.email,
      accion:  'EDICION_PAQUETE',
      detalle: `Se editó el paquete "${nombre}" con ${beat_ids.length} beat(s)`,
      ip:      ipDeRequest(request)
    });

    return reply.send({ pack });
  });


  // ─── PUT /api/packs/:id/imagen ─────────────────────────────────────────────
  // Liga la portada cuando termina su subida, sin tocar los beats del paquete.
  app.put<{ Params: Params; Body: { imagen_url: string } }>('/:id/imagen', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['imagen_url'],
        properties: { imagen_url: { type: 'string', minLength: 8 } }
      }
    }
  }, async (request, reply) => {
    if (!isAdminRole(request.user.rol)) {
      return reply.code(403).send({ error: 'Acceso denegado' });
    }

    let pack;
    try {
      [pack] = await sql`
        update packs set imagen_url = ${request.body.imagen_url}, updated_at = now()
        where id = ${request.params.id}
        returning id`;
    } catch (error) {
      if (!esFormatoInvalido(error)) {
        app.log.error(error);
        return reply.code(500).send({ error: 'Error al guardar la portada' });
      }
    }
    if (!pack) {
      return reply.code(404).send({ error: 'Paquete no encontrado' });
    }

    return reply.send({ pack });
  });


  // ─── DELETE /api/packs/:id ─────────────────────────────────────────────────
  app.delete<{ Params: Params }>('/:id', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    if (!isAdminRole(request.user.rol)) {
      return reply.code(403).send({ error: 'Acceso denegado' });
    }

    let pack: { nombre: string } | undefined;
    try {
      // Baja lógica: el paquete deja de mostrarse pero las compras lo siguen citando.
      [pack] = await sql<{ nombre: string }[]>`
        update packs set activo = false, updated_at = now()
        where id = ${request.params.id}
        returning nombre`;
    } catch (error) {
      if (!esFormatoInvalido(error)) {
        app.log.error(error);
        return reply.code(500).send({ error: 'Error al eliminar el paquete' });
      }
    }

    if (!pack) {
      return reply.code(404).send({ error: 'Paquete no encontrado' });
    }

    await registrarAudit(app, {
      user_id: request.user.sub,
      email:   request.user.email,
      accion:  'ELIMINACION_PAQUETE',
      detalle: `Se eliminó el paquete "${pack.nombre}"`,
      ip:      ipDeRequest(request)
    });

    return reply.code(204).send();
  });
}

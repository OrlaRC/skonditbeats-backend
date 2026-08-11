import type { FastifyInstance } from 'fastify';
import { supabase }             from '../../db/supabase';
import { isAdminRole }          from '../../types/index';
import { registrarAudit, ipDeRequest } from '../../plugins/audit';

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

export async function packRoutes(app: FastifyInstance): Promise<void> {

  // ─── GET /api/packs ─────────────────────────────────────────────────────────
  // Público: lista los paquetes activos con sus beats
  app.get('/', async (_request, reply) => {
    const { data, error } = await supabase
      .from('packs')
      .select(`
        id, nombre, descripcion, imagen_url, precio, activo, created_at,
        pack_beats (
          beats ( id, nombre, genero, bpm, precio, imagen_url, audio_url )
        )
      `)
      .eq('activo', true)
      .order('created_at', { ascending: false });

    if (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al obtener los paquetes' });
    }

    return reply.send({ packs: data });
  });


  // ─── GET /api/packs/:id ────────────────────────────────────────────────────
  app.get<{ Params: Params }>('/:id', async (request, reply) => {
    const { data, error } = await supabase
      .from('packs')
      .select(`
        id, nombre, descripcion, imagen_url, precio, activo, created_at,
        pack_beats (
          beats ( id, nombre, genero, bpm, precio, imagen_url, audio_url )
        )
      `)
      .eq('id', request.params.id)
      .single();

    if (error || !data) {
      return reply.code(404).send({ error: 'Paquete no encontrado' });
    }

    return reply.send({ pack: data });
  });


  // ─── POST /api/packs ───────────────────────────────────────────────────────
  app.post<{ Body: PackBody }>('/', {
    preHandler: [app.authenticate]
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

    // Crear el paquete
    const { data: pack, error: packError } = await supabase
      .from('packs')
      .insert({
        nombre,
        descripcion: descripcion ?? null,
        imagen_url:  imagen_url  ?? null,
        precio:      Number(precio)
      })
      .select('id')
      .single();

    if (packError || !pack) {
      app.log.error(packError);
      return reply.code(500).send({ error: 'Error al crear el paquete' });
    }

    // Vincular los beats
    const vinculos = beat_ids.map(beatId => ({ pack_id: pack.id, beat_id: beatId }));
    const { error: relError } = await supabase.from('pack_beats').insert(vinculos);

    if (relError) {
      app.log.error(relError);
      await supabase.from('packs').delete().eq('id', pack.id);
      return reply.code(500).send({ error: 'Error al vincular los beats del paquete' });
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
    preHandler: [app.authenticate]
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

    const { data: pack, error } = await supabase
      .from('packs')
      .update({
        nombre,
        descripcion: descripcion ?? null,
        imagen_url:  imagen_url  ?? null,
        precio:      Number(precio),
        updated_at:  new Date().toISOString()
      })
      .eq('id', request.params.id)
      .select('id')
      .single();

    if (error || !pack) {
      app.log.error(error);
      return reply.code(404).send({ error: 'Paquete no encontrado' });
    }

    // Reemplazar los beats del paquete
    const { error: delError } = await supabase
      .from('pack_beats')
      .delete()
      .eq('pack_id', pack.id);

    if (!delError) {
      const vinculos = beat_ids.map(beatId => ({ pack_id: pack.id, beat_id: beatId }));
      await supabase.from('pack_beats').insert(vinculos);
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


  // ─── DELETE /api/packs/:id ─────────────────────────────────────────────────
  app.delete<{ Params: Params }>('/:id', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    if (!isAdminRole(request.user.rol)) {
      return reply.code(403).send({ error: 'Acceso denegado' });
    }

    const { data: pack } = await supabase
      .from('packs')
      .select('nombre')
      .eq('id', request.params.id)
      .single();

    const { error } = await supabase
      .from('packs')
      .update({ activo: false, updated_at: new Date().toISOString() })
      .eq('id', request.params.id);

    if (error) {
      return reply.code(404).send({ error: 'Paquete no encontrado' });
    }

    await registrarAudit(app, {
      user_id: request.user.sub,
      email:   request.user.email,
      accion:  'ELIMINACION_PAQUETE',
      detalle: pack ? `Se eliminó el paquete "${pack.nombre}"` : 'Se eliminó un paquete',
      ip:      ipDeRequest(request)
    });

    return reply.code(204).send();
  });
}
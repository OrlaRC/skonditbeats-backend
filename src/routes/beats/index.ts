import type { FastifyInstance, FastifyRequest } from 'fastify';
import { supabase }      from '../../db/supabase';
import { isAdminRole }   from '../../types/index';
import type { MultipartFile } from '@fastify/multipart';

interface BeatsQuery {
  search?:     string;
  genero?:     string;
  bpm_min?:    string;
  bpm_max?:    string;
  precio_min?: string;
  precio_max?: string;
}

interface ParsedBeatUpload {
  fields: Record<string, string>;
  imagen?: { buffer: Buffer; mime: string; name: string };
  audio?:  { buffer: Buffer; mime: string; name: string };
}

async function parseBeatMultipart(request: FastifyRequest): Promise<ParsedBeatUpload> {
  const fields: Record<string, string> = {};
  let imagen: ParsedBeatUpload['imagen'];
  let audio:  ParsedBeatUpload['audio'];

  for await (const part of request.parts()) {
    if (part.type === 'field') {
      fields[part.fieldname] = part.value as string;
    } else {
      const file   = part as MultipartFile;
      const buffer = await file.toBuffer();
      const entry  = { buffer, mime: file.mimetype, name: `${Date.now()}_${file.filename}` };
      if (file.fieldname === 'imagen') imagen = entry;
      if (file.fieldname === 'audio')  audio  = entry;
    }
  }

  return { fields, imagen, audio };
}

async function uploadToStorage(
  bucket: string,
  name:   string,
  buffer: Buffer,
  mime:   string
): Promise<string | null> {
  const { error } = await supabase.storage
    .from(bucket)
    .upload(name, buffer, { contentType: mime, upsert: true });

  if (error) return null;

  const { data } = supabase.storage.from(bucket).getPublicUrl(name);
  return data.publicUrl;
}

export async function beatsRoutes(app: FastifyInstance): Promise<void> {

  // ─── GET /api/beats ────────────────────────────────────────────────────────
  app.get<{ Querystring: BeatsQuery }>('/', async (request, reply) => {
    const { search, genero, bpm_min, bpm_max, precio_min, precio_max } = request.query;

    let query = supabase
      .from('beats')
      .select('id, nombre, genero, bpm, precio, imagen_url, audio_url, descripcion, created_at')
      .eq('activo', true)
      .order('created_at', { ascending: false });

    if (search)     query = query.or(`nombre.ilike.%${search}%,genero.ilike.%${search}%`);
    if (genero)     query = query.eq('genero', genero);
    if (bpm_min)    query = query.gte('bpm', Number(bpm_min));
    if (bpm_max)    query = query.lte('bpm', Number(bpm_max));
    if (precio_min) query = query.gte('precio', Number(precio_min));
    if (precio_max) query = query.lte('precio', Number(precio_max));

    const { data, error } = await query;

    if (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al obtener los beats' });
    }

    return reply.send({ beats: data });
  });


  // ─── GET /api/beats/:id ────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { data, error } = await supabase
      .from('beats')
      .select('*')
      .eq('id', request.params.id)
      .eq('activo', true)
      .single();

    if (error || !data) {
      return reply.code(404).send({ error: 'Beat no encontrado' });
    }

    return reply.send({ beat: data });
  });


  // ─── POST /api/beats ───────────────────────────────────────────────────────
  app.post('/', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    if (!isAdminRole(request.user.rol)) {
      return reply.code(403).send({ error: 'Acceso denegado' });
    }

    const { fields, imagen, audio } = await parseBeatMultipart(request);
    const { nombre, genero, bpm, precio, descripcion } = fields;

    if (!nombre || !genero || !bpm || !precio) {
      return reply.code(400).send({ error: 'nombre, genero, bpm y precio son obligatorios' });
    }

    const imagen_url = imagen
      ? await uploadToStorage('beats-images', `img_${imagen.name}`, imagen.buffer, imagen.mime)
      : null;

    const audio_url = audio
      ? await uploadToStorage('beats-audio', `audio_${audio.name}`, audio.buffer, audio.mime)
      : null;

    if (imagen && !imagen_url) return reply.code(500).send({ error: 'Error al subir la imagen' });
    if (audio  && !audio_url)  return reply.code(500).send({ error: 'Error al subir el audio'  });

    const { data: beat, error } = await supabase
      .from('beats')
      .insert({
        nombre,
        genero,
        bpm:         Number(bpm),
        precio:      Number(precio),
        descripcion: descripcion ?? null,
        imagen_url,
        audio_url
      })
      .select()
      .single();

    if (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al guardar el beat' });
    }

    return reply.code(201).send({ beat });
  });


  // ─── PUT /api/beats/:id ────────────────────────────────────────────────────
  app.put<{ Params: { id: string } }>('/:id', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    if (!isAdminRole(request.user.rol)) {
      return reply.code(403).send({ error: 'Acceso denegado' });
    }

    const { data: beatActual } = await supabase
      .from('beats')
      .select('imagen_url, audio_url')
      .eq('id', request.params.id)
      .single();

    const { fields, imagen, audio } = await parseBeatMultipart(request);
    const { nombre, genero, bpm, precio, descripcion } = fields;

    if (!nombre || !genero || !bpm || !precio) {
      return reply.code(400).send({ error: 'nombre, genero, bpm y precio son obligatorios' });
    }

    let imagen_url = beatActual?.imagen_url ?? null;
    let audio_url  = beatActual?.audio_url  ?? null;

    if (imagen) {
      const url = await uploadToStorage('beats-images', `img_${imagen.name}`, imagen.buffer, imagen.mime);
      if (!url) return reply.code(500).send({ error: 'Error al subir la imagen' });
      imagen_url = url;
    }

    if (audio) {
      const url = await uploadToStorage('beats-audio', `audio_${audio.name}`, audio.buffer, audio.mime);
      if (!url) return reply.code(500).send({ error: 'Error al subir el audio' });
      audio_url = url;
    }

    const { data: beat, error } = await supabase
      .from('beats')
      .update({
        nombre,
        genero,
        bpm:         Number(bpm),
        precio:      Number(precio),
        descripcion: descripcion ?? null,
        imagen_url,
        audio_url,
        updated_at:  new Date().toISOString()
      })
      .eq('id', request.params.id)
      .select()
      .single();

    if (error || !beat) {
      app.log.error(error);
      return reply.code(404).send({ error: 'Beat no encontrado' });
    }

    return reply.send({ beat });
  });


  // ─── DELETE /api/beats/:id ─────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>('/:id', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    if (!isAdminRole(request.user.rol)) {
      return reply.code(403).send({ error: 'Acceso denegado' });
    }

    const { error } = await supabase
      .from('beats')
      .update({ activo: false, updated_at: new Date().toISOString() })
      .eq('id', request.params.id);

    if (error) {
      return reply.code(404).send({ error: 'Beat no encontrado' });
    }

    return reply.code(204).send();
  });
}
import type { FastifyInstance } from 'fastify';
import { supabase }      from '../../db/supabase';
import { isAdminRole }   from '../../types/index';
import { registrarAudit, ipDeRequest } from '../../plugins/audit';
import { claveIdempotencia, esDuplicado } from '../../plugins/idempotencia';

interface BeatsQuery {
  search?:     string;
  genero?:     string;
  bpm_min?:    string;
  bpm_max?:    string;
  precio_min?: string;
  precio_max?: string;
  limit?:      string;
  page?:       string;
}

interface BeatBody {
  nombre:      string;
  genero:      string;
  bpm:         number;
  precio:      number;
  descripcion?: string;
  imagen_url?:  string | null;
  audio_url?:   string | null;
}

interface MediaBody {
  imagen_url?: string;
  audio_url?:  string;
}

const CAMPOS_LISTA = 'id, nombre, genero, bpm, precio, imagen_url, audio_url, descripcion, created_at';
const LIMITE_MAX = 100;

// ── Resumen del catálogo en memoria ───────────────────────────────────────────
// El total y la lista de géneros cambian solo cuando un admin edita el catálogo,
// pero antes se recalculaban con dos consultas extra en CADA petición de la tienda.
// Ahora se guardan 60 s y se invalidan al crear, editar o eliminar un beat.
const TTL_RESUMEN_MS = 60_000;
let resumen: { total: number; generos: string[]; expira: number } | null = null;
let resumenEnCurso: Promise<{ total: number; generos: string[] }> | null = null;

async function resumenCatalogo(): Promise<{ total: number; generos: string[] }> {
  if (resumen && resumen.expira > Date.now()) return resumen;
  // Varias peticiones simultáneas con la caché vencida comparten una sola consulta.
  resumenEnCurso ??= (async () => {
    try {
      const { data } = await supabase.from('beats').select('genero').eq('activo', true);
      const filas = data ?? [];
      const generos = [...new Set(filas.map(b => b.genero as string))].sort();
      resumen = { total: filas.length, generos, expira: Date.now() + TTL_RESUMEN_MS };
      return resumen;
    } finally {
      resumenEnCurso = null;
    }
  })();
  return resumenEnCurso;
}

export function invalidarCatalogo(): void {
  resumen = null;
}

/** Devuelve el mensaje de error, o null si los datos del beat son válidos. */
export function validarBeat(body: Partial<BeatBody> | undefined): string | null {
  const { nombre, genero, bpm, precio } = body ?? {};
  if (!nombre || !genero || bpm === undefined || precio === undefined) {
    return 'nombre, genero, bpm y precio son obligatorios';
  }
  if (String(nombre).trim().length < 2 || String(nombre).length > 150) return 'El nombre debe tener de 2 a 150 caracteres';
  if (String(genero).trim().length < 2 || String(genero).length > 80) return 'El género debe tener de 2 a 80 caracteres';
  const b = Number(bpm);
  if (!Number.isInteger(b) || b < 1 || b > 299) return 'El BPM debe ser un entero entre 1 y 299';
  const p = Number(precio);
  if (!Number.isFinite(p) || p < 0 || p > 99_999_999) return 'El precio no es válido';
  return null;
}

export async function beatsRoutes(app: FastifyInstance): Promise<void> {

  // ─── GET /api/beats ────────────────────────────────────────────────────────
  // Sin `limit` devuelve todo el catálogo (lo que usa la web). Con `limit` y
  // `page` devuelve una página y `total` es el número de resultados del filtro.
  app.get<{ Querystring: BeatsQuery }>('/', async (request, reply) => {
    const { search, genero, bpm_min, bpm_max, precio_min, precio_max } = request.query;

    const paginado = request.query.limit !== undefined;
    const limit    = Math.min(Math.max(Number(request.query.limit) || 20, 1), LIMITE_MAX);
    const page     = Math.max(Number(request.query.page) || 1, 1);

    let query = paginado
      ? supabase.from('beats').select(CAMPOS_LISTA, { count: 'exact' })
      : supabase.from('beats').select(CAMPOS_LISTA);

    query = query.eq('activo', true).order('created_at', { ascending: false });

    if (search) {
      // Se descartan los caracteres con significado en el filtro de PostgREST.
      const texto = search.replace(/[,()%*\\]/g, ' ').trim();
      if (texto) query = query.or(`nombre.ilike.%${texto}%,genero.ilike.%${texto}%`);
    }
    if (genero)     query = query.eq('genero', genero);
    if (bpm_min)    query = query.gte('bpm', Number(bpm_min));
    if (bpm_max)    query = query.lte('bpm', Number(bpm_max));
    if (precio_min) query = query.gte('precio', Number(precio_min));
    if (precio_max) query = query.lte('precio', Number(precio_max));
    if (paginado)   query = query.range((page - 1) * limit, page * limit - 1);

    const [beatsResult, catalogo] = await Promise.all([query, resumenCatalogo()]);

    const { data, error, count } = beatsResult;

    if (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al obtener los beats' });
    }

    return reply.send({
      beats:   data,
      total:   paginado ? (count ?? data.length) : catalogo.total,
      generos: catalogo.generos,
      ...(paginado ? { page, limit } : {})
    });
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
  app.post<{ Body: BeatBody }>('/', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    if (!isAdminRole(request.user.rol)) {
      return reply.code(403).send({ error: 'Acceso denegado' });
    }

    const invalido = validarBeat(request.body);
    if (invalido) {
      return reply.code(400).send({ error: invalido });
    }

    const { nombre, genero, bpm, precio, descripcion, imagen_url, audio_url } = request.body;
    const clientRef = claveIdempotencia(request);

    const { data: beat, error } = await supabase
      .from('beats')
      .insert({
        nombre:      nombre.trim(),
        genero:      genero.trim(),
        bpm:         Number(bpm),
        precio:      Number(precio),
        descripcion: descripcion?.trim() || null,
        imagen_url:  imagen_url  ?? null,
        audio_url:   audio_url   ?? null,
        client_ref:  clientRef
      })
      .select()
      .single();

    // Reintento de la misma alta: se devuelve el beat que ya se había creado.
    if (esDuplicado(error) && clientRef) {
      const { data: existente } = await supabase
        .from('beats')
        .select()
        .eq('client_ref', clientRef)
        .maybeSingle();
      return reply.code(200).send({ beat: existente, repetida: true });
    }

    if (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al guardar el beat' });
    }

    invalidarCatalogo();
    await registrarAudit(app, {
      user_id: request.user.sub,
      email:   request.user.email,
      accion:  'ALTA_BEAT',
      detalle: `Se creó el beat "${beat.nombre}" (${beat.genero}, ${beat.bpm} BPM)`,
      ip:      ipDeRequest(request)
    });

    return reply.code(201).send({ beat });
  });


  // ─── PUT /api/beats/:id/media ──────────────────────────────────────────────
  // Liga la portada o el audio cuando termina su subida, sin tocar lo demás. La
  // app la llama al completar una carga reanudable, quizá horas después del alta.
  app.put<{ Params: { id: string }; Body: MediaBody }>('/:id/media', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          imagen_url: { type: 'string', minLength: 8 },
          audio_url:  { type: 'string', minLength: 8 }
        }
      }
    }
  }, async (request, reply) => {
    if (!isAdminRole(request.user.rol)) {
      return reply.code(403).send({ error: 'Acceso denegado' });
    }

    const { imagen_url, audio_url } = request.body;
    if (!imagen_url && !audio_url) {
      return reply.code(400).send({ error: 'Envía imagen_url o audio_url' });
    }

    const { data: beat, error } = await supabase
      .from('beats')
      .update({
        ...(imagen_url ? { imagen_url } : {}),
        ...(audio_url  ? { audio_url }  : {}),
        updated_at: new Date().toISOString()
      })
      .eq('id', request.params.id)
      .select()
      .maybeSingle();

    if (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al guardar el archivo del beat' });
    }
    if (!beat) {
      return reply.code(404).send({ error: 'Beat no encontrado' });
    }

    invalidarCatalogo();
    return reply.send({ beat });
  });


  // ─── PUT /api/beats/:id ────────────────────────────────────────────────────
  app.put<{ Params: { id: string }; Body: BeatBody }>('/:id', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    if (!isAdminRole(request.user.rol)) {
      return reply.code(403).send({ error: 'Acceso denegado' });
    }

    const invalido = validarBeat(request.body);
    if (invalido) {
      return reply.code(400).send({ error: invalido });
    }

    const { data: beatActual } = await supabase
      .from('beats')
      .select('imagen_url, audio_url')
      .eq('id', request.params.id)
      .single();

    const { nombre, genero, bpm, precio, descripcion, imagen_url, audio_url } = request.body;

    const { data: beat, error } = await supabase
      .from('beats')
      .update({
        nombre:      nombre.trim(),
        genero:      genero.trim(),
        bpm:         Number(bpm),
        precio:      Number(precio),
        descripcion: descripcion?.trim() || null,
        imagen_url:  imagen_url  ?? beatActual?.imagen_url ?? null,
        audio_url:   audio_url   ?? beatActual?.audio_url  ?? null,
        updated_at:  new Date().toISOString()
      })
      .eq('id', request.params.id)
      .select()
      .single();

    if (error || !beat) {
      app.log.error(error);
      return reply.code(404).send({ error: 'Beat no encontrado' });
    }

    invalidarCatalogo();
    await registrarAudit(app, {
      user_id: request.user.sub,
      email:   request.user.email,
      accion:  'EDICION_BEAT',
      detalle: `Se editó el beat "${beat.nombre}"`,
      ip:      ipDeRequest(request)
    });

    return reply.send({ beat });
  });


  // ─── DELETE /api/beats/:id ─────────────────────────────────────────────────
  // Eliminación lógica: el beat deja de venderse pero sigue en las compras hechas.
  app.delete<{ Params: { id: string } }>('/:id', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    if (!isAdminRole(request.user.rol)) {
      return reply.code(403).send({ error: 'Acceso denegado' });
    }

    const { data: beat, error } = await supabase
      .from('beats')
      .update({ activo: false, updated_at: new Date().toISOString() })
      .eq('id', request.params.id)
      .select('nombre')
      .maybeSingle();

    if (error || !beat) {
      return reply.code(404).send({ error: 'Beat no encontrado' });
    }

    invalidarCatalogo();
    await registrarAudit(app, {
      user_id: request.user.sub,
      email:   request.user.email,
      accion:  'ELIMINACION_BEAT',
      detalle: `Se eliminó el beat "${beat.nombre}"`,
      ip:      ipDeRequest(request)
    });

    return reply.code(204).send();
  });
}

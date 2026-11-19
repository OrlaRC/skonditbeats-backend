import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql, filasONada }      from '../../db/sql';

/**
 * Rutas del proyecto Skondit (phone_app y smart_tv_pwa).
 *
 * Antes esas apps leían y escribían directo en el REST de Supabase con la clave
 * `anon`, que daba acceso a cualquier tabla con política pública. Ahora pasan por la
 * API con una clave de dispositivo (cabecera X-Skondit-Key = SKONDIT_DEVICE_KEY) que
 * solo sirve para estas tres operaciones.
 */
export async function skonditRoutes(app: FastifyInstance): Promise<void> {

  app.addHook('preHandler', async (request, reply) => {
    const esperada = process.env['SKONDIT_DEVICE_KEY'];
    if (!esperada) {
      return reply.code(503).send({ error: 'Skondit no está configurado en este servidor' });
    }
    if (!claveValida(request, esperada)) {
      return reply.code(401).send({ error: 'Clave de dispositivo inválida' });
    }
  });

  // ─── GET /api/skondit/biblioteca/:userId ───────────────────────────────────
  // Beats comprados (órdenes COMPLETADAS) del usuario, sin repetir.
  app.get<{ Params: { userId: string } }>('/biblioteca/:userId', async (request, reply) => {
    try {
      const beats = await filasONada(sql`
        select distinct on (b.id) b.id, b.nombre, b.genero, b.bpm, b.precio, b.audio_url, b.imagen_url
        from orders o
        join order_items oi on oi.order_id = o.id
        join beats b on b.id = oi.beat_id
        where o.user_id = ${request.params.userId} and o.status = 'COMPLETADO'
        order by b.id`);
      return reply.send({ beats });
    } catch (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al obtener la biblioteca' });
    }
  });

  // ─── GET /api/skondit/now-playing ──────────────────────────────────────────
  // Lo que suena en el teléfono; la TV lo consulta cada 2 s.
  app.get('/now-playing', async (_request, reply) => {
    try {
      const [fila] = await sql`
        select beat_id, beat_name, genre, bpm, position_sec, duration_sec, playing, target, updated_at
        from now_playing where id = 1`;
      return reply.send({ nowPlaying: fila ?? null });
    } catch (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al consultar lo que suena' });
    }
  });

  // ─── PUT /api/skondit/now-playing ──────────────────────────────────────────
  app.put<{ Body: NowPlayingBody }>('/now-playing', {
    schema: {
      body: {
        type: 'object',
        required: ['position_sec', 'duration_sec', 'playing'],
        additionalProperties: false,
        properties: {
          beat_id:      { type: ['string', 'null'], maxLength: 64 },
          beat_name:    { type: ['string', 'null'], maxLength: 150 },
          genre:        { type: ['string', 'null'], maxLength: 80 },
          bpm:          { type: ['integer', 'null'], minimum: 0, maximum: 400 },
          position_sec: { type: 'integer', minimum: 0, maximum: 86_400 },
          duration_sec: { type: 'integer', minimum: 0, maximum: 86_400 },
          playing:      { type: 'boolean' },
          target:       { type: 'string', enum: ['app', 'tv', 'watch'] },
        },
      },
    },
  }, async (request, reply) => {
    const b = request.body;
    try {
      // Un solo renglón (id = 1): se inserta la primera vez y después se actualiza.
      const [fila] = await sql`
        insert into now_playing (id, beat_id, beat_name, genre, bpm, position_sec, duration_sec, playing, target, updated_at)
        values (1, ${b.beat_id ?? null}, ${b.beat_name ?? null}, ${b.genre ?? null}, ${b.bpm ?? null},
                ${b.position_sec}, ${b.duration_sec}, ${b.playing}, ${b.target ?? 'app'}, now())
        on conflict (id) do update set
          beat_id = excluded.beat_id, beat_name = excluded.beat_name, genre = excluded.genre, bpm = excluded.bpm,
          position_sec = excluded.position_sec, duration_sec = excluded.duration_sec, playing = excluded.playing,
          target = excluded.target, updated_at = excluded.updated_at
        returning beat_id, beat_name, genre, bpm, position_sec, duration_sec, playing, target, updated_at`;
      return reply.send({ nowPlaying: fila });
    } catch (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al publicar lo que suena' });
    }
  });
}

interface NowPlayingBody {
  beat_id?: string | null;
  beat_name?: string | null;
  genre?: string | null;
  bpm?: number | null;
  position_sec: number;
  duration_sec: number;
  playing: boolean;
  target?: 'app' | 'tv' | 'watch';
}

/** Compara la clave en tiempo constante (no revela cuántos caracteres coinciden). */
function claveValida(request: FastifyRequest, esperada: string): boolean {
  const valor = request.headers['x-skondit-key'];
  const recibida = Buffer.from(String(Array.isArray(valor) ? valor[0] : valor ?? ''));
  const correcta = Buffer.from(esperada);
  return recibida.length === correcta.length && timingSafeEqual(recibida, correcta);
}

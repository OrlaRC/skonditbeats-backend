import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql, filasONada } from '../../db/sql';
import { registrarAudit, ipDeRequest } from '../../plugins/audit';
import { esUuid } from '../../plugins/sesiones';

/**
 * Smart TV vinculada a una cuenta (PWA smart_tv_pwa + app móvil).
 *
 * 1. La TV pide un emparejamiento (POST /emparejar): recibe un token secreto, que solo
 *    ella guarda, y un código de 6 dígitos que muestra en pantalla junto con un QR.
 * 2. El usuario, con su sesión abierta en la app móvil, escanea el QR o escribe el
 *    código (POST /vincular). Desde ese momento la TV queda ligada a su cuenta.
 * 3. La TV muestra la biblioteca de esa cuenta y sigue lo que ordena el teléfono
 *    (PUT /reproduccion); a su vez reporta su posición real (POST /reproduccion/reporte).
 *
 * La TV nunca recibe el JWT del usuario: su token solo sirve para leer la biblioteca y
 * la reproducción de la cuenta vinculada, y el usuario puede revocarlo desde la app.
 */

const MINUTOS_CODIGO = 10;
const INTENTOS_FALLIDOS_MAX = 5;          // por usuario, en la ventana del código
const SEGUNDOS_EN_LINEA = 15;             // la TV consulta cada 2 s: 15 s sin noticias = apagada

interface TvAutenticada { id: string; user_id: string | null; nombre: string }

declare module 'fastify' {
  interface FastifyRequest { tv?: TvAutenticada }
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Valida la cabecera X-Tv-Token y deja la TV en request.tv. */
async function autenticarTv(request: FastifyRequest, reply: FastifyReply, exigirVinculo: boolean) {
  const valor = request.headers['x-tv-token'];
  const token = String(Array.isArray(valor) ? valor[0] : valor ?? '');
  if (token.length < 32 || token.length > 128) {
    return reply.code(401).send({ error: 'Token de TV inválido' });
  }
  const [tv] = await sql<TvAutenticada[]>`
    update tv_dispositivos set ultimo_contacto = now()
    where token_hash = ${hashToken(token)} and revocado_at is null
    returning id, user_id, nombre`;
  if (!tv) return reply.code(401).send({ error: 'Token de TV inválido' });
  if (exigirVinculo && !tv.user_id) return reply.code(409).send({ error: 'La TV aún no está vinculada' });
  request.tv = tv;
}

const soloTv = (exigirVinculo: boolean) =>
  (request: FastifyRequest, reply: FastifyReply) => autenticarTv(request, reply, exigirVinculo);

/** Estado de reproducción de una cuenta con los datos del beat que suena. */
async function reproduccionDe(userId: string) {
  const [fila] = await sql`
    select r.beat_id, b.nombre as beat_nombre, b.genero, b.bpm, b.imagen_url, b.audio_url,
           r.position_sec, r.duration_sec, r.playing, r.destino, r.volumen, r.comando,
           r.tv_position_sec, r.tv_playing, r.tv_reportado_at, r.updated_at
    from tv_reproduccion r left join beats b on b.id = r.beat_id
    where r.user_id = ${userId}`;
  return fila ?? null;
}

export async function tvRoutes(app: FastifyInstance): Promise<void> {

  // ─── POST /api/tv/emparejar ────────────────────────────────────────────────
  // Sin sesión: lo pide la TV la primera vez que se abre (o tras ser revocada).
  app.post<{ Body: { nombre?: string } | undefined }>('/emparejar', {
    schema: {
      body: {
        type: ['object', 'null'],
        additionalProperties: false,
        properties: { nombre: { type: 'string', minLength: 1, maxLength: 60 } },
      },
    },
  }, async (request, reply) => {
    const nombre = request.body?.nombre?.trim() || 'Smart TV';
    const token = randomBytes(32).toString('base64url');

    // Los códigos vencidos que nadie usó se liberan para no agotar el espacio.
    await sql`
      delete from tv_dispositivos
      where user_id is null and codigo_expira_at < now() - interval '1 day'`;

    // Si el código ya está pendiente en otra TV (índice único), se prueba otro.
    for (let intento = 0; intento < 5; intento++) {
      const codigo = String(randomInt(0, 1_000_000)).padStart(6, '0');
      try {
        const [tv] = await sql`
          insert into tv_dispositivos (token_hash, nombre, codigo, codigo_expira_at)
          values (${hashToken(token)}, ${nombre}, ${codigo}, now() + make_interval(mins => ${MINUTOS_CODIGO}))
          returning id, codigo, codigo_expira_at`;
        return reply.code(201).send({ id: tv.id, token, codigo: tv.codigo, codigo_expira_at: tv.codigo_expira_at });
      } catch (error: any) {
        if (error?.code !== '23505') throw error;
      }
    }
    return reply.code(503).send({ error: 'No se pudo generar un código, intenta de nuevo' });
  });

  // ─── POST /api/tv/codigo ───────────────────────────────────────────────────
  // La TV sin vincular renueva su código cuando vence (mismo token).
  app.post('/codigo', { preHandler: soloTv(false) }, async (request, reply) => {
    const tv = request.tv!;
    if (tv.user_id) return reply.code(409).send({ error: 'La TV ya está vinculada' });
    for (let intento = 0; intento < 5; intento++) {
      const codigo = String(randomInt(0, 1_000_000)).padStart(6, '0');
      try {
        const [fila] = await sql`
          update tv_dispositivos
          set codigo = ${codigo}, codigo_expira_at = now() + make_interval(mins => ${MINUTOS_CODIGO})
          where id = ${tv.id}
          returning codigo, codigo_expira_at`;
        return reply.send(fila);
      } catch (error: any) {
        if (error?.code !== '23505') throw error;
      }
    }
    return reply.code(503).send({ error: 'No se pudo generar un código, intenta de nuevo' });
  });

  // ─── GET /api/tv/estado ────────────────────────────────────────────────────
  // La TV pregunta si ya la vincularon y a quién.
  app.get('/estado', { preHandler: soloTv(false) }, async (request, reply) => {
    const [fila] = await sql`
      select t.nombre, t.codigo, t.codigo_expira_at, t.vinculado_at, u.nombre as usuario
      from tv_dispositivos t left join users u on u.id = t.user_id
      where t.id = ${request.tv!.id}`;
    return reply.send({
      vinculado: !!request.tv!.user_id,
      nombre: fila.nombre,
      usuario: fila.usuario ?? null,
      codigo: request.tv!.user_id ? null : fila.codigo,
      codigo_expira_at: request.tv!.user_id ? null : fila.codigo_expira_at,
      vinculado_at: fila.vinculado_at,
    });
  });

  // ─── GET /api/tv/biblioteca ────────────────────────────────────────────────
  // Beats comprados (órdenes COMPLETADAS) de la cuenta vinculada, sin repetir.
  app.get('/biblioteca', { preHandler: soloTv(true) }, async (request, reply) => {
    const beats = await filasONada(sql`
      select distinct on (b.id) b.id, b.nombre, b.genero, b.bpm, b.precio, b.audio_url, b.imagen_url
      from orders o
      join order_items oi on oi.order_id = o.id
      join beats b on b.id = oi.beat_id
      where o.user_id = ${request.tv!.user_id} and o.status = 'COMPLETADO'
      order by b.id`);
    return reply.send({ beats });
  });

  // ─── GET /api/tv/reproduccion (TV) ─────────────────────────────────────────
  app.get('/reproduccion', { preHandler: soloTv(true) }, async (request, reply) => {
    return reply.send({ reproduccion: await reproduccionDe(request.tv!.user_id!) });
  });

  // ─── POST /api/tv/reproduccion/reporte (TV) ────────────────────────────────
  // Posición real de la TV mientras el audio suena en ella. No cambia las órdenes.
  app.post<{ Body: { position_sec: number; playing: boolean } }>('/reproduccion/reporte', {
    preHandler: soloTv(true),
    schema: {
      body: {
        type: 'object',
        required: ['position_sec', 'playing'],
        additionalProperties: false,
        properties: {
          position_sec: { type: 'integer', minimum: 0, maximum: 86_400 },
          playing:      { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const [fila] = await sql`
      update tv_reproduccion
      set tv_position_sec = ${request.body.position_sec}, tv_playing = ${request.body.playing}, tv_reportado_at = now()
      where user_id = ${request.tv!.user_id}
      returning user_id`;
    return fila ? reply.code(204).send() : reply.code(404).send({ error: 'No hay reproducción activa' });
  });

  // ─── DELETE /api/tv/yo (TV) ────────────────────────────────────────────────
  // "Desvincular esta TV" desde la propia pantalla: su token deja de servir.
  app.delete('/yo', { preHandler: soloTv(false) }, async (request, reply) => {
    const tv = request.tv!;
    await sql`update tv_dispositivos set revocado_at = now() where id = ${tv.id}`;
    if (tv.user_id) {
      await registrarAudit(app, { user_id: tv.user_id, email: null, accion: 'TV_DESVINCULADA',
        detalle: `La TV "${tv.nombre}" se desvinculó desde la pantalla`, ip: ipDeRequest(request) });
    }
    return reply.code(204).send();
  });

  // ════════════════════════ Rutas del usuario (JWT) ═══════════════════════════
  await app.register(async (usuario) => {
    usuario.addHook('preHandler', usuario.authenticate);

    // ─── POST /api/tv/vincular ───────────────────────────────────────────────
    usuario.post<{ Body: { codigo: string } }>('/vincular', {
      schema: {
        body: {
          type: 'object',
          required: ['codigo'],
          additionalProperties: false,
          properties: { codigo: { type: 'string', pattern: '^[0-9]{6}$' } },
        },
      },
    }, async (request, reply) => {
      const yo = request.user;
      const ip = ipDeRequest(request);

      // Freno a la fuerza bruta: 5 códigos incorrectos en 10 minutos → 429.
      const [{ fallidos }] = await sql<{ fallidos: number }[]>`
        select count(*)::int as fallidos from bitacora
        where user_id = ${yo.sub} and accion = 'TV_CODIGO_INVALIDO'
          and created_at > now() - make_interval(mins => ${MINUTOS_CODIGO})`;
      if (fallidos >= INTENTOS_FALLIDOS_MAX) {
        return reply.code(429).send({ error: 'Demasiados intentos. Espera unos minutos.' });
      }

      const [tv] = await sql`
        update tv_dispositivos
        set user_id = ${yo.sub}, vinculado_at = now(), codigo = null, codigo_expira_at = null
        where codigo = ${request.body.codigo} and user_id is null and revocado_at is null
          and codigo_expira_at > now()
        returning id, nombre, vinculado_at`;
      if (!tv) {
        await registrarAudit(app, { user_id: yo.sub, email: yo.email, accion: 'TV_CODIGO_INVALIDO',
          detalle: 'Código de TV incorrecto o vencido', ip });
        return reply.code(404).send({ error: 'El código no es válido o ya venció' });
      }

      await sql`
        insert into tv_reproduccion (user_id) values (${yo.sub})
        on conflict (user_id) do nothing`;
      await registrarAudit(app, { user_id: yo.sub, email: yo.email, accion: 'TV_VINCULADA',
        detalle: `Vinculó la TV "${tv.nombre}"`, ip });
      return reply.send({ tv });
    });

    // ─── GET /api/tv/mias ────────────────────────────────────────────────────
    usuario.get('/mias', async (request, reply) => {
      const tvs = await sql`
        select id, nombre, vinculado_at, ultimo_contacto,
               coalesce(ultimo_contacto > now() - make_interval(secs => ${SEGUNDOS_EN_LINEA}), false) as en_linea
        from tv_dispositivos
        where user_id = ${request.user.sub} and revocado_at is null
        order by vinculado_at desc`;
      return reply.send({ tvs });
    });

    // ─── DELETE /api/tv/:id ──────────────────────────────────────────────────
    // Desvincula una TV: su token deja de servir al instante.
    usuario.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
      const { id } = request.params;
      if (!esUuid(id)) return reply.code(404).send({ error: 'TV no encontrada' });
      const [tv] = await sql`
        update tv_dispositivos set revocado_at = now()
        where id = ${id} and user_id = ${request.user.sub} and revocado_at is null
        returning nombre`;
      if (!tv) return reply.code(404).send({ error: 'TV no encontrada' });
      await registrarAudit(app, { user_id: request.user.sub, email: request.user.email, accion: 'TV_DESVINCULADA',
        detalle: `Desvinculó la TV "${tv.nombre}"`, ip: ipDeRequest(request) });
      return reply.code(204).send();
    });

    // ─── GET /api/tv/control ─────────────────────────────────────────────────
    // El teléfono lee el estado (incluida la posición que reporta la TV).
    usuario.get('/control', async (request, reply) => {
      return reply.send({ reproduccion: await reproduccionDe(request.user.sub) });
    });

    // ─── PUT /api/tv/control ─────────────────────────────────────────────────
    // El teléfono ordena: qué beat, dónde suena (app o tv), play/pausa, posición y volumen.
    usuario.put<{ Body: ControlBody }>('/control', {
      schema: {
        body: {
          type: 'object',
          required: ['position_sec', 'duration_sec', 'playing', 'destino'],
          additionalProperties: false,
          properties: {
            beat_id:      { type: ['string', 'null'], format: 'uuid' },
            position_sec: { type: 'integer', minimum: 0, maximum: 86_400 },
            duration_sec: { type: 'integer', minimum: 0, maximum: 86_400 },
            playing:      { type: 'boolean' },
            destino:      { type: 'string', enum: ['app', 'tv'] },
            volumen:      { type: 'integer', minimum: 0, maximum: 100 },
          },
        },
      },
    }, async (request, reply) => {
      const b = request.body;
      if (b.beat_id) {
        const [existe] = await sql`select 1 from beats where id = ${b.beat_id}`;
        if (!existe) return reply.code(404).send({ error: 'Beat no encontrado' });
      }
      await sql`
        insert into tv_reproduccion (user_id, beat_id, position_sec, duration_sec, playing, destino, volumen, comando, updated_at)
        values (${request.user.sub}, ${b.beat_id ?? null}, ${b.position_sec}, ${b.duration_sec}, ${b.playing},
                ${b.destino}, ${b.volumen ?? 100}, 1, now())
        on conflict (user_id) do update set
          beat_id = excluded.beat_id, position_sec = excluded.position_sec, duration_sec = excluded.duration_sec,
          playing = excluded.playing, destino = excluded.destino,
          volumen = coalesce(${b.volumen ?? null}::smallint, tv_reproduccion.volumen),
          comando = tv_reproduccion.comando + 1, updated_at = now()`;
      return reply.send({ reproduccion: await reproduccionDe(request.user.sub) });
    });
  });
}

interface ControlBody {
  beat_id?: string | null;
  position_sec: number;
  duration_sec: number;
  playing: boolean;
  destino: 'app' | 'tv';
  volumen?: number;
}

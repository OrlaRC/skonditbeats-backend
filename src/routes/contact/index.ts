import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql, filasONada }      from '../../db/sql';
import { isAdminRole }          from '../../types/index';
import type { JwtPayload }      from '../../types/index';
import { registrarAudit, ipDeRequest } from '../../plugins/audit';
import { sendContactReplyEmail } from '../../plugins/email';
import { claveIdempotencia, esDuplicado } from '../../plugins/idempotencia';
import { EMAIL }                from '../../schemas/comunes';

interface ContactBody {
  nombre:  string;
  email:   string;
  mensaje: string;
  tipo?:   'MENSAJE' | 'ERROR';
  asunto?: string;
}

interface ListaQuery {
  limit?:    string;
  page?:     string;
  estado?:   string;
  tipo?:     string;
  asignado?: string;
  q?:        string;
  no_leidos?: string;
}

export const ESTADOS_TICKET = ['ABIERTO', 'EN_PROCESO', 'RESPONDIDO', 'DEVUELTO', 'RESUELTO', 'CERRADO'] as const;
export const PRIORIDADES_TICKET = ['BAJA', 'MEDIA', 'ALTA'] as const;
type EstadoTicket = (typeof ESTADOS_TICKET)[number];

// Estados que cada quien puede fijar a mano; RESPONDIDO y DEVUELTO los pone el flujo de respuestas.
const ESTADOS_ADMIN: EstadoTicket[]   = ['ABIERTO', 'EN_PROCESO', 'RESUELTO', 'CERRADO'];
const ESTADOS_CLIENTE: EstadoTicket[] = ['ABIERTO', 'CERRADO'];

// Columnas del ticket con la misma forma JSON que devolvía PostgREST:
//   asignado: { nombre } | null
const BASE = () => sql`
  m.id, m.folio, m.asunto, m.nombre, m.email, m.mensaje, m.tipo, m.estado, m.prioridad, m.user_id, m.asignado_a,
  m.created_at, m.updated_at, m.cerrado_at, m.no_leido_cliente, m.no_leido_admin,
  (select json_build_object('nombre', a.nombre) from users a where a.id = m.asignado_a) as asignado`;

// Detalle: el ticket con toda su conversación (contact_replies: [{ id, autor_nombre, ... }]).
const CAMPOS = () => sql`${BASE()},
  coalesce((
    select json_agg(json_build_object('id', r.id, 'autor_nombre', r.autor_nombre, 'es_admin', r.es_admin,
                                      'texto', r.texto, 'created_at', r.created_at) order by r.created_at)
    from contact_replies r where r.message_id = m.id
  ), '[]'::json) as contact_replies`;

// Bandeja paginada: solo cuántas respuestas hay, no su texto (contact_replies: [{ count }]).
const CAMPOS_LISTA = () => sql`${BASE()},
  json_build_array(json_build_object('count', (select count(*) from contact_replies r where r.message_id = m.id)))
    as contact_replies`;

const LIMITE_MAX = 100;

const TEXTO_SCHEMA = { type: 'string', minLength: 2, maxLength: 2000 };

export async function contactRoutes(app: FastifyInstance): Promise<void> {

  const soloAdmin = async (request: FastifyRequest, reply: any) => {
    if (!isAdminRole(request.user.rol)) {
      return reply.code(403).send({ error: 'Acceso denegado' });
    }
  };

  // ─── POST /api/contact ─────────────────────────────────────────────────────
  // Abre un ticket. Público (la web lo usa sin sesión); si llega un token válido,
  // se liga a la cuenta.
  app.post<{ Body: ContactBody }>('/', {
    schema: {
      body: {
        type: 'object',
        required: ['nombre', 'email', 'mensaje'],
        properties: {
          nombre:  { type: 'string', minLength: 2 },
          email:   EMAIL,
          mensaje: { type: 'string', minLength: 10 },
          tipo:    { type: 'string', enum: ['MENSAJE', 'ERROR'] },
          asunto:  { type: 'string', maxLength: 120 }
        }
      }
    }
  }, async (request, reply) => {
    const { nombre, email, mensaje, tipo, asunto } = request.body;
    const clientRef = claveIdempotencia(request);

    let userId: string | null = null;
    try {
      userId = (await request.jwtVerify<JwtPayload>()).sub;
    } catch {
      // Sin sesión: mensaje anónimo.
    }

    let ticket;
    try {
      [ticket] = await sql`
        insert into contact_messages ${sql({
          nombre,
          email,
          mensaje,
          tipo:       tipo ?? 'MENSAJE',
          asunto:     asunto?.trim() || null,
          prioridad:  tipo === 'ERROR' ? 'ALTA' : 'MEDIA',
          user_id:    userId,
          client_ref: clientRef
        })}
        returning id, folio, estado`;
    } catch (error) {
      // Reintento de la misma operación: se devuelve el ticket que ya se había creado.
      if (esDuplicado(error as { code?: string }) && clientRef) {
        const [existente] = await sql`select id, folio, estado from contact_messages where client_ref = ${clientRef}`;
        return reply.code(200).send({ message: 'Mensaje recibido correctamente', ticket: existente ?? null, repetida: true });
      }
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al enviar el mensaje' });
    }

    return reply.code(201).send({ message: 'Mensaje recibido correctamente', ticket });
  });


  // Bandeja de tickets. Sin `limit` responde como antes (todo, con respuestas), que
  // es lo que usa la web; con `limit` pagina, filtra en la base y solo cuenta respuestas.
  async function listar(query: ListaQuery, userId: string | null) {
    const paginado = query.limit !== undefined;
    const limit    = Math.min(Math.max(Number(query.limit) || 20, 1), LIMITE_MAX);
    const page     = Math.max(Number(query.page) || 1, 1);

    // Filtros como fragmentos parametrizados (el texto del usuario nunca forma parte del SQL).
    const filtros = [sql`true`];
    if (userId) filtros.push(sql`m.user_id = ${userId}`);
    if (query.estado && (ESTADOS_TICKET as readonly string[]).includes(query.estado)) {
      filtros.push(sql`m.estado = ${query.estado}`);
    }
    if (query.tipo === 'ERROR' || query.tipo === 'MENSAJE') filtros.push(sql`m.tipo = ${query.tipo}`);
    if (query.asignado) filtros.push(sql`m.asignado_a::text = ${query.asignado}`);
    // Solo con novedades: para el admin, las de los clientes; para el cliente, las del admin.
    if (query.no_leidos === '1') filtros.push(userId ? sql`m.no_leido_cliente` : sql`m.no_leido_admin`);
    if (query.q) {
      const folio = Number(query.q.replace(/^#/, ''));
      if (Number.isInteger(folio) && folio > 0) {
        filtros.push(sql`m.folio = ${folio}`);
      } else {
        const texto = query.q.trim();
        if (texto) {
          const patron = `%${texto.replace(/[\\%_]/g, '\\$&')}%`;
          filtros.push(sql`(m.nombre ilike ${patron} or m.email ilike ${patron} or m.asunto ilike ${patron})`);
        }
      }
    }
    const donde = filtros.reduce((a, f) => sql`${a} and ${f}`);

    try {
      const [filas, conteo] = await Promise.all([
        sql`
          select ${paginado ? CAMPOS_LISTA() : CAMPOS()}
          from contact_messages m
          where ${donde}
          order by m.created_at desc
          ${paginado ? sql`limit ${limit} offset ${(page - 1) * limit}` : sql``}`,
        paginado
          ? sql<{ n: number }[]>`select count(*) as n from contact_messages m where ${donde}`
          : Promise.resolve(null),
      ]);
      return {
        error: null,
        cuerpo: {
          messages: filas,
          total:    conteo ? conteo[0].n : filas.length,
          ...(paginado ? { page, limit } : {})
        }
      };
    } catch (error) {
      return { error, cuerpo: null };
    }
  }


  // ─── GET /api/contact ──────────────────────────────────────────────────────
  // Solo admin puede ver todos los tickets
  app.get<{ Querystring: ListaQuery }>('/', {
    preHandler: [app.authenticate, soloAdmin]
  }, async (request, reply) => {
    const { error, cuerpo } = await listar(request.query, null);

    if (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al obtener mensajes' });
    }

    return reply.send(cuerpo);
  });


  // ─── GET /api/contact/mios ─────────────────────────────────────────────────
  // Tickets del usuario autenticado
  app.get<{ Querystring: ListaQuery }>('/mios', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    const { asignado: _ignorado, ...query } = request.query;
    const { error, cuerpo } = await listar(query, request.user.sub);

    if (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al obtener tus mensajes' });
    }

    return reply.send(cuerpo);
  });


  // ─── GET /api/contact/no-leidos ────────────────────────────────────────────
  // Tickets con novedades para quien pregunta: al cliente, respuestas o cambios
  // de estado del admin; al admin, tickets nuevos o respuestas de clientes.
  // La app lo consulta cada cierto tiempo para mostrar el aviso y la insignia.
  app.get('/no-leidos', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    const esAdmin = isAdminRole(request.user.rol);

    const donde = esAdmin
      ? sql`no_leido_admin`
      : sql`user_id = ${request.user.sub} and no_leido_cliente`;

    try {
      const [tickets, [{ n }]] = await Promise.all([
        sql`
          select id, folio, asunto, nombre, tipo, estado, updated_at
          from contact_messages where ${donde}
          order by updated_at desc limit 20`,
        sql<{ n: number }[]>`select count(*) as n from contact_messages where ${donde}`,
      ]);
      return reply.send({ total: n, tickets });
    } catch (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al consultar los avisos' });
    }
  });


  // ─── PUT /api/contact/:id/visto ────────────────────────────────────────────
  // Marca el ticket como leído por su dueño o por los administradores.
  app.put<{ Params: { id: string } }>('/:id/visto', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    const esAdmin = isAdminRole(request.user.rol);

    let data;
    try {
      [data] = await filasONada(esAdmin
        ? sql`update contact_messages set no_leido_admin = false where id = ${request.params.id} returning id`
        : sql`update contact_messages set no_leido_cliente = false
              where id = ${request.params.id} and user_id = ${request.user.sub} returning id`);
    } catch (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al marcar el ticket' });
    }
    if (!data) {
      return reply.code(404).send({ error: 'Mensaje no encontrado' });
    }

    return reply.code(204).send();
  });


  // ─── GET /api/contact/:id ──────────────────────────────────────────────────
  // Un ticket con su conversación: lo ve su dueño o un administrador
  app.get<{ Params: { id: string } }>('/:id', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    let ticket: { user_id?: string | null } | undefined;
    try {
      [ticket] = await filasONada(sql<{ user_id: string | null }[]>`
        select ${CAMPOS()} from contact_messages m where m.id = ${request.params.id}`);
    } catch (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al obtener el mensaje' });
    }

    // Un ticket ajeno se responde igual que uno inexistente, para no revelar que existe.
    if (!ticket || (!isAdminRole(request.user.rol) && ticket.user_id !== request.user.sub)) {
      return reply.code(404).send({ error: 'Mensaje no encontrado' });
    }

    return reply.send({ message: ticket });
  });


  // Guarda la respuesta y actualiza el estado. Avisa por correo si responde un admin.
  async function responder(
    request: FastifyRequest,
    reply: any,
    id: string,
    texto: string,
    estadoAdmin: 'RESPONDIDO' | 'DEVUELTO'
  ) {
    const esAdmin = isAdminRole(request.user.rol);

    const [mensaje] = await filasONada(sql<{ id: string; folio: number; nombre: string; email: string; user_id: string | null; estado: string }[]>`
      select id, folio, nombre, email, user_id, estado from contact_messages where id = ${id}`);

    // Un mensaje ajeno se responde igual que uno inexistente, para no revelar que existe.
    if (!mensaje || (!esAdmin && mensaje.user_id !== request.user.sub)) {
      return reply.code(404).send({ error: 'Mensaje no encontrado' });
    }

    if (estadoAdmin === 'DEVUELTO' && !mensaje.user_id) {
      return reply.code(400).send({ error: 'Este mensaje no tiene cuenta: respóndelo para contestarle por correo' });
    }

    if (mensaje.estado === 'CERRADO') {
      return reply.code(409).send({ error: 'El ticket está cerrado. Reábrelo para seguir la conversación.' });
    }

    const [autor] = await sql<{ nombre: string }[]>`select nombre from users where id = ${request.user.sub}`;

    const clientRef = claveIdempotencia(request);

    // La respuesta y el cambio de estado del ticket en una transacción: antes eran dos
    // llamadas y un fallo en la segunda dejaba la respuesta guardada con el estado viejo.
    try {
      await sql.begin(async tx => {
        await tx`
          insert into contact_replies ${tx({
            message_id:   id,
            autor_id:     request.user.sub,
            autor_nombre: autor?.nombre ?? request.user.email,
            es_admin:     esAdmin,
            texto,
            client_ref:   clientRef
          })}`;
        // Si responde el cliente, el ticket vuelve a la bandeja de pendientes.
        // Se marca como no leído para el otro lado: así le llega el aviso.
        await tx`
          update contact_messages set ${tx({
            estado:     esAdmin ? estadoAdmin : 'ABIERTO',
            cerrado_at: null,
            updated_at: new Date(),
            ...(esAdmin ? { no_leido_cliente: true } : { no_leido_admin: true })
          })}
          where id = ${id}`;
      });
    } catch (error) {
      // Reintento: la respuesta ya se guardó (y el correo ya salió) la primera vez.
      if (esDuplicado(error as { code?: string }) && clientRef) {
        return reply.code(200).send({ message: 'Respuesta enviada', correoEnviado: false, repetida: true });
      }
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al guardar la respuesta' });
    }

    let correoEnviado = false;
    if (esAdmin) {
      await registrarAudit(app, {
        user_id: request.user.sub,
        email:   request.user.email,
        accion:  estadoAdmin === 'DEVUELTO' ? 'DEVOLUCION_CONTACTO' : 'RESPUESTA_CONTACTO',
        detalle: `${estadoAdmin === 'DEVUELTO' ? 'Devolvió' : 'Respondió'} el mensaje de ${mensaje.nombre} (${mensaje.email})`,
        ip:      ipDeRequest(request)
      });

      try {
        await sendContactReplyEmail(mensaje.email, mensaje.nombre, texto, estadoAdmin === 'DEVUELTO');
        correoEnviado = true;
      } catch (e) {
        // La respuesta ya quedó guardada: un fallo de correo no debe perderla.
        app.log.error(e);
      }
    }

    return reply.code(201).send({ message: 'Respuesta enviada', correoEnviado });
  }


  // ─── POST /api/contact/:id/respuestas ──────────────────────────────────────
  // Responde el admin o el dueño del mensaje
  app.post<{ Params: { id: string }; Body: { texto: string } }>('/:id/respuestas', {
    preHandler: [app.authenticate],
    schema: {
      body: { type: 'object', required: ['texto'], properties: { texto: TEXTO_SCHEMA } }
    }
  }, (request, reply) => responder(request, reply, request.params.id, request.body.texto.trim(), 'RESPONDIDO'));


  // ─── PUT /api/contact/:id/devolver ─────────────────────────────────────────
  // Regresa el caso al cliente para pedirle más información
  app.put<{ Params: { id: string }; Body: { motivo: string } }>('/:id/devolver', {
    preHandler: [app.authenticate, soloAdmin],
    schema: {
      body: { type: 'object', required: ['motivo'], properties: { motivo: TEXTO_SCHEMA } }
    }
  }, (request, reply) => responder(request, reply, request.params.id, request.body.motivo.trim(), 'DEVUELTO'));


  // ─── PUT /api/contact/:id/asignar ──────────────────────────────────────────
  // Pasa el caso a otro administrador
  app.put<{ Params: { id: string }; Body: { adminId: string } }>('/:id/asignar', {
    preHandler: [app.authenticate, soloAdmin],
    schema: {
      body: { type: 'object', required: ['adminId'], properties: { adminId: { type: 'string' } } }
    }
  }, async (request, reply) => {
    const { adminId } = request.body;

    const [destino] = await filasONada(sql<{ rol: string; activo: boolean; nombre: string | null; email: string }[]>`
      select rol, activo, nombre, email from users where id = ${adminId}`);

    if (!destino || !isAdminRole(destino.rol) || destino.activo === false) {
      return reply.code(400).send({ error: 'El destinatario debe ser un administrador activo' });
    }

    let mensaje: { id: string; nombre: string; email: string } | undefined;
    try {
      [mensaje] = await filasONada(sql<{ id: string; nombre: string; email: string }[]>`
        update contact_messages set asignado_a = ${adminId}, updated_at = now()
        where id = ${request.params.id}
        returning id, nombre, email`);
    } catch (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al asignar el mensaje' });
    }
    if (!mensaje) {
      return reply.code(404).send({ error: 'Mensaje no encontrado' });
    }

    await registrarAudit(app, {
      user_id: request.user.sub,
      email:   request.user.email,
      accion:  'ASIGNACION_CONTACTO',
      detalle: `Pasó el mensaje de ${mensaje.nombre} (${mensaje.email}) a ${destino.nombre ?? destino.email}`,
      ip:      ipDeRequest(request)
    });

    return reply.send({ message: 'Mensaje asignado' });
  });


  // ─── PUT /api/contact/:id/estado ───────────────────────────────────────────
  // El admin mueve el ticket (en proceso, resuelto, cerrado); su dueño solo puede
  // cerrarlo o reabrirlo. `esperado` es el estado que veía quien hace el cambio:
  // si alguien más lo movió antes, se responde 409 en lugar de pisar ese cambio.
  app.put<{ Params: { id: string }; Body: { estado: EstadoTicket; esperado?: string } }>('/:id/estado', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['estado'],
        properties: {
          estado:   { type: 'string', enum: [...ESTADOS_TICKET] },
          esperado: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { estado, esperado } = request.body;
    const esAdmin = isAdminRole(request.user.rol);

    const [ticket] = await filasONada(sql<{ id: string; folio: number | null; nombre: string; email: string; user_id: string | null; estado: string }[]>`
      select id, folio, nombre, email, user_id, estado from contact_messages where id = ${request.params.id}`);

    if (!ticket || (!esAdmin && ticket.user_id !== request.user.sub)) {
      return reply.code(404).send({ error: 'Mensaje no encontrado' });
    }

    if (!(esAdmin ? ESTADOS_ADMIN : ESTADOS_CLIENTE).includes(estado)) {
      return reply.code(esAdmin ? 400 : 403).send({ error: 'No puedes poner el ticket en ese estado' });
    }

    const terminado = estado === 'CERRADO' || estado === 'RESUELTO';
    const ahora = new Date();

    // UPDATE condicionado al estado que veía quien hace el cambio (concurrencia optimista).
    let actualizado;
    try {
      [actualizado] = await sql`
        update contact_messages set ${sql({
          estado,
          cerrado_at: terminado ? ahora : null,
          updated_at: ahora,
          ...(esAdmin ? { no_leido_cliente: ticket.user_id !== null } : { no_leido_admin: true })
        })}
        where id = ${request.params.id}
          ${esperado ? sql`and estado = ${esperado}` : sql``}
        returning id, folio, estado`;
    } catch (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al actualizar el ticket' });
    }
    if (!actualizado) {
      return reply.code(409).send({ error: 'El ticket cambió mientras lo veías. Actualiza e intenta de nuevo.' });
    }

    if (esAdmin) {
      await registrarAudit(app, {
        user_id: request.user.sub,
        email:   request.user.email,
        accion:  'ESTADO_TICKET',
        detalle: `Ticket #${ticket.folio ?? ''} de ${ticket.nombre} (${ticket.email}): ${ticket.estado} → ${estado}`,
        ip:      ipDeRequest(request)
      });
    }

    return reply.send({ message: 'Ticket actualizado', ticket: actualizado });
  });


  // ─── PUT /api/contact/:id/prioridad ────────────────────────────────────────
  app.put<{ Params: { id: string }; Body: { prioridad: string } }>('/:id/prioridad', {
    preHandler: [app.authenticate, soloAdmin],
    schema: {
      body: {
        type: 'object',
        required: ['prioridad'],
        properties: { prioridad: { type: 'string', enum: [...PRIORIDADES_TICKET] } }
      }
    }
  }, async (request, reply) => {
    let ticket;
    try {
      [ticket] = await filasONada(sql`
        update contact_messages set prioridad = ${request.body.prioridad}, updated_at = now()
        where id = ${request.params.id}
        returning id, folio, prioridad`);
    } catch (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al actualizar el ticket' });
    }
    if (!ticket) {
      return reply.code(404).send({ error: 'Mensaje no encontrado' });
    }

    return reply.send({ message: 'Prioridad actualizada', ticket });
  });


  // ─── DELETE /api/contact/:id ───────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>('/:id', {
    preHandler: [app.authenticate, soloAdmin]
  }, async (request, reply) => {
    let borrado;
    try {
      // Las respuestas se borran con el ticket (on delete cascade).
      [borrado] = await filasONada(sql`delete from contact_messages where id = ${request.params.id} returning id`);
    } catch (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al eliminar el mensaje' });
    }

    if (!borrado) {
      return reply.code(404).send({ error: 'Mensaje no encontrado' });
    }

    return reply.code(204).send();
  });
}

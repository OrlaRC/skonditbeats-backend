import type { FastifyInstance, FastifyRequest } from 'fastify';
import { supabase }             from '../../db/supabase';
import { isAdminRole }          from '../../types/index';
import type { JwtPayload }      from '../../types/index';
import { registrarAudit, ipDeRequest } from '../../plugins/audit';
import { sendContactReplyEmail } from '../../plugins/email';
import { claveIdempotencia, esDuplicado } from '../../plugins/idempotencia';

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
}

export const ESTADOS_TICKET = ['ABIERTO', 'EN_PROCESO', 'RESPONDIDO', 'DEVUELTO', 'RESUELTO', 'CERRADO'] as const;
export const PRIORIDADES_TICKET = ['BAJA', 'MEDIA', 'ALTA'] as const;
type EstadoTicket = (typeof ESTADOS_TICKET)[number];

// Estados que cada quien puede fijar a mano; RESPONDIDO y DEVUELTO los pone el flujo de respuestas.
const ESTADOS_ADMIN: EstadoTicket[]   = ['ABIERTO', 'EN_PROCESO', 'RESUELTO', 'CERRADO'];
const ESTADOS_CLIENTE: EstadoTicket[] = ['ABIERTO', 'CERRADO'];

const BASE = `id, folio, asunto, nombre, email, mensaje, tipo, estado, prioridad, user_id, asignado_a,
  created_at, updated_at, cerrado_at,
  asignado:users!contact_messages_asignado_a_fkey ( nombre )`;

// Detalle: el ticket con toda su conversación.
const CAMPOS = `${BASE},
  contact_replies ( id, autor_nombre, es_admin, texto, created_at )`;

// Bandeja paginada: solo cuántas respuestas hay, no su texto.
const CAMPOS_LISTA = `${BASE}, contact_replies ( count )`;

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
          email:   { type: 'string' },
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

    const { data: ticket, error } = await supabase
      .from('contact_messages')
      .insert({
        nombre,
        email,
        mensaje,
        tipo:       tipo ?? 'MENSAJE',
        asunto:     asunto?.trim() || null,
        prioridad:  tipo === 'ERROR' ? 'ALTA' : 'MEDIA',
        user_id:    userId,
        client_ref: clientRef
      })
      .select('id, folio, estado')
      .single();

    // Reintento de la misma operación: se devuelve el ticket que ya se había creado.
    if (esDuplicado(error) && clientRef) {
      const { data: existente } = await supabase
        .from('contact_messages')
        .select('id, folio, estado')
        .eq('client_ref', clientRef)
        .maybeSingle();
      return reply.code(200).send({ message: 'Mensaje recibido correctamente', ticket: existente, repetida: true });
    }

    if (error) {
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

    let consulta = paginado
      ? supabase.from('contact_messages').select(CAMPOS_LISTA, { count: 'exact' })
      : supabase.from('contact_messages').select(CAMPOS);

    consulta = consulta.order('created_at', { ascending: false });

    if (userId) consulta = consulta.eq('user_id', userId);
    if (query.estado && (ESTADOS_TICKET as readonly string[]).includes(query.estado)) {
      consulta = consulta.eq('estado', query.estado);
    }
    if (query.tipo === 'ERROR' || query.tipo === 'MENSAJE') consulta = consulta.eq('tipo', query.tipo);
    if (query.asignado) consulta = consulta.eq('asignado_a', query.asignado);
    if (query.q) {
      const folio = Number(query.q.replace(/^#/, ''));
      if (Number.isInteger(folio) && folio > 0) {
        consulta = consulta.eq('folio', folio);
      } else {
        // Los caracteres con significado en el filtro de PostgREST se descartan.
        const texto = query.q.replace(/[,()%*\\]/g, ' ').trim();
        if (texto) consulta = consulta.or(`nombre.ilike.%${texto}%,email.ilike.%${texto}%,asunto.ilike.%${texto}%`);
      }
    }
    if (paginado) consulta = consulta.range((page - 1) * limit, page * limit - 1);

    const { data, error, count } = await consulta;
    const filas = (data ?? []) as unknown[];
    return {
      error,
      cuerpo: {
        messages: filas,
        total:    count ?? filas.length,
        ...(paginado ? { page, limit } : {})
      }
    };
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


  // ─── GET /api/contact/:id ──────────────────────────────────────────────────
  // Un ticket con su conversación: lo ve su dueño o un administrador
  app.get<{ Params: { id: string } }>('/:id', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    const { data, error } = await supabase
      .from('contact_messages')
      .select(CAMPOS)
      .eq('id', request.params.id)
      .maybeSingle();

    const ticket = data as { user_id?: string | null } | null;

    // Un ticket ajeno se responde igual que uno inexistente, para no revelar que existe.
    if (error || !ticket || (!isAdminRole(request.user.rol) && ticket.user_id !== request.user.sub)) {
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

    const { data: mensaje } = await supabase
      .from('contact_messages')
      .select('id, folio, nombre, email, user_id, estado')
      .eq('id', id)
      .maybeSingle();

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

    const { data: autor } = await supabase
      .from('users')
      .select('nombre')
      .eq('id', request.user.sub)
      .maybeSingle();

    const clientRef = claveIdempotencia(request);

    const { error } = await supabase
      .from('contact_replies')
      .insert({
        message_id:   id,
        autor_id:     request.user.sub,
        autor_nombre: autor?.nombre ?? request.user.email,
        es_admin:     esAdmin,
        texto,
        client_ref:   clientRef
      });

    // Reintento: la respuesta ya se guardó (y el correo ya salió) la primera vez.
    if (esDuplicado(error) && clientRef) {
      return reply.code(200).send({ message: 'Respuesta enviada', correoEnviado: false, repetida: true });
    }

    if (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al guardar la respuesta' });
    }

    // Si responde el cliente, el ticket vuelve a la bandeja de pendientes.
    const { error: estadoError } = await supabase
      .from('contact_messages')
      .update({ estado: esAdmin ? estadoAdmin : 'ABIERTO', cerrado_at: null, updated_at: new Date().toISOString() })
      .eq('id', id);

    if (estadoError) {
      app.log.error(estadoError);
      return reply.code(500).send({ error: 'Error al actualizar el mensaje' });
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

    const { data: destino } = await supabase
      .from('users')
      .select('rol, activo, nombre, email')
      .eq('id', adminId)
      .maybeSingle();

    if (!destino || !isAdminRole(destino.rol) || destino.activo === false) {
      return reply.code(400).send({ error: 'El destinatario debe ser un administrador activo' });
    }

    const { data: mensaje, error } = await supabase
      .from('contact_messages')
      .update({ asignado_a: adminId, updated_at: new Date().toISOString() })
      .eq('id', request.params.id)
      .select('id, nombre, email')
      .maybeSingle();

    if (error) {
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

    const { data: ticket } = await supabase
      .from('contact_messages')
      .select('id, folio, nombre, email, user_id, estado')
      .eq('id', request.params.id)
      .maybeSingle();

    if (!ticket || (!esAdmin && ticket.user_id !== request.user.sub)) {
      return reply.code(404).send({ error: 'Mensaje no encontrado' });
    }

    if (!(esAdmin ? ESTADOS_ADMIN : ESTADOS_CLIENTE).includes(estado)) {
      return reply.code(esAdmin ? 400 : 403).send({ error: 'No puedes poner el ticket en ese estado' });
    }

    const terminado = estado === 'CERRADO' || estado === 'RESUELTO';
    const ahora = new Date().toISOString();

    let cambio = supabase
      .from('contact_messages')
      .update({ estado, cerrado_at: terminado ? ahora : null, updated_at: ahora })
      .eq('id', request.params.id);
    if (esperado) cambio = cambio.eq('estado', esperado);

    const { data: actualizado, error } = await cambio.select('id, folio, estado').maybeSingle();

    if (error) {
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
    const { data: ticket, error } = await supabase
      .from('contact_messages')
      .update({ prioridad: request.body.prioridad, updated_at: new Date().toISOString() })
      .eq('id', request.params.id)
      .select('id, folio, prioridad')
      .maybeSingle();

    if (error) {
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
    const { error } = await supabase
      .from('contact_messages')
      .delete()
      .eq('id', request.params.id);

    if (error) {
      return reply.code(404).send({ error: 'Mensaje no encontrado' });
    }

    return reply.code(204).send();
  });
}

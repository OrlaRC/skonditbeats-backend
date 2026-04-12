import type { FastifyInstance } from 'fastify';
import { supabase }             from '../../db/supabase';
import { isAdminRole }          from '../../types/index';

interface ContactBody {
  nombre:  string;
  email:   string;
  mensaje: string;
}

export async function contactRoutes(app: FastifyInstance): Promise<void> {

  // ─── POST /api/contact ─────────────────────────────────────────────────────
  app.post<{ Body: ContactBody }>('/', {
    schema: {
      body: {
        type: 'object',
        required: ['nombre', 'email', 'mensaje'],
        properties: {
          nombre:  { type: 'string', minLength: 2 },
          email:   { type: 'string' },
          mensaje: { type: 'string', minLength: 10 }
        }
      }
    }
  }, async (request, reply) => {
    const { nombre, email, mensaje } = request.body;

    const { error } = await supabase
      .from('contact_messages')
      .insert({ nombre, email, mensaje });

    if (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al enviar el mensaje' });
    }

    return reply.code(201).send({ message: 'Mensaje recibido correctamente' });
  });


  // ─── GET /api/contact ──────────────────────────────────────────────────────
  // Solo admin puede ver los mensajes
  app.get('/', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    if (!isAdminRole(request.user.rol)) {
      return reply.code(403).send({ error: 'Acceso denegado' });
    }

    const { data, error } = await supabase
      .from('contact_messages')
      .select('id, nombre, email, mensaje, created_at')
      .order('created_at', { ascending: false });

    if (error) {
      return reply.code(500).send({ error: 'Error al obtener mensajes' });
    }

    return reply.send({ messages: data, total: data?.length ?? 0 });
  });


  // ─── DELETE /api/contact/:id ───────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>('/:id', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    if (!isAdminRole(request.user.rol)) {
      return reply.code(403).send({ error: 'Acceso denegado' });
    }

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
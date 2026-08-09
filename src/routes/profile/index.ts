import type { FastifyInstance } from 'fastify';
import bcrypt                   from 'bcryptjs';
import { supabase }             from '../../db/supabase';
import { registrarAudit, ipDeRequest } from '../../plugins/audit';
import { validarPoliticaPassword, DESCRIPCION_POLITICA } from '../../plugins/password';

interface ProfileBody {
  nombre?:    string;
  username?:  string;
  direccion?: string;
  telefono?:  string;
  edad?:      number;
}

interface ChangePasswordBody {
  password_actual: string;
  password_nueva:  string;
}

export async function profileRoutes(app: FastifyInstance): Promise<void> {

  app.addHook('preHandler', app.authenticate);

  // ─── GET /api/profile ──────────────────────────────────────────────────────
  app.get('/', async (request, reply) => {
    const { data, error } = await supabase
      .from('users')
      .select('id, email, nombre, username, rol, foto_url, direccion, telefono, edad, fecha_registro')
      .eq('id', request.user.sub)
      .single();

    if (error || !data) {
      return reply.code(404).send({ error: 'Perfil no encontrado' });
    }

    return reply.send({ user: data });
  });


  // ─── PUT /api/profile ──────────────────────────────────────────────────────
  app.put<{ Body: ProfileBody }>('/', {
    schema: {
      body: {
        type: 'object',
        properties: {
          nombre:    { type: 'string' },
          username:  { type: 'string' },
          direccion: { type: 'string' },
          telefono:  { type: 'string' },
          edad:      { type: 'number' }
        }
      }
    }
  }, async (request, reply) => {
    const { data, error } = await supabase
      .from('users')
      .update({ ...request.body, updated_at: new Date().toISOString() })
      .eq('id', request.user.sub)
      .select('id, email, nombre, username, rol, foto_url, direccion, telefono, edad, fecha_registro')
      .single();

    if (error || !data) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al actualizar el perfil' });
    }

    return reply.send({ user: data });
  });


  // ─── PUT /api/profile/password ─────────────────────────────────────────────
  app.put<{ Body: ChangePasswordBody }>('/password', {
    schema: {
      body: {
        type: 'object',
        required: ['password_actual', 'password_nueva'],
        properties: {
          password_actual: { type: 'string' },
          password_nueva:  { type: 'string', minLength: 10 }
        }
      }
    }
  }, async (request, reply) => {
    const { password_actual, password_nueva } = request.body;

    const errorPolitica = validarPoliticaPassword(password_nueva);
    if (errorPolitica) {
      return reply.code(400).send({ error: errorPolitica, politica: DESCRIPCION_POLITICA });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('password')
      .eq('id', request.user.sub)
      .single();

    if (error || !user) {
      return reply.code(404).send({ error: 'Usuario no encontrado' });
    }

    const valid = await bcrypt.compare(password_actual, user.password);

    if (!valid) {
      return reply.code(401).send({ error: 'La contraseña actual es incorrecta' });
    }

    const newHash = await bcrypt.hash(password_nueva, 12);

    await supabase
      .from('users')
      .update({ password: newHash, updated_at: new Date().toISOString() })
      .eq('id', request.user.sub);

    await registrarAudit(app, {
      user_id: request.user.sub,
      email:   request.user.email,
      accion:  'CAMBIO_CONTRASENA',
      detalle: 'El usuario cambió su propia contraseña',
      ip:      ipDeRequest(request)
    });

    return reply.send({ message: 'Contraseña actualizada correctamente' });
  });


  // ─── PUT /api/profile/foto ─────────────────────────────────────────────────
  // Recibe la foto_url ya subida por el frontend a Supabase Storage
  app.put<{ Body: { foto_url?: string } }>('/foto', async (request, reply) => {
    const { foto_url } = request.body;

    if (!foto_url) {
      return reply.code(400).send({ error: 'foto_url es obligatoria' });
    }

    const { error: updateError } = await supabase
      .from('users')
      .update({ foto_url, updated_at: new Date().toISOString() })
      .eq('id', request.user.sub);

    if (updateError) {
      app.log.error(updateError);
      return reply.code(500).send({ error: 'Error al guardar la foto' });
    }

    return reply.send({ foto_url });
  });
}
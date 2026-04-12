import type { FastifyInstance } from 'fastify';
import type { MultipartFile }   from '@fastify/multipart';
import bcrypt                   from 'bcryptjs';
import { supabase }             from '../../db/supabase';

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

    return reply.send({ message: 'Contraseña actualizada correctamente' });
  });


  // ─── PUT /api/profile/foto ─────────────────────────────────────────────────
  app.put('/foto', async (request, reply) => {
    let fotoBuffer: Buffer | null = null;
    let fotoMime  = '';
    let fotoName  = '';

    for await (const part of request.parts()) {
      if (part.type !== 'field') {
        const file = part as MultipartFile;
        fotoBuffer = await file.toBuffer();
        fotoMime   = file.mimetype;
        fotoName   = `${request.user.sub}_${Date.now()}_${file.filename}`;
      }
    }

    if (!fotoBuffer) {
      return reply.code(400).send({ error: 'No se recibió ningún archivo' });
    }

    const { error: uploadError } = await supabase.storage
      .from('avatars')
      .upload(fotoName, fotoBuffer, { contentType: fotoMime, upsert: true });

    if (uploadError) {
      app.log.error(uploadError);
      return reply.code(500).send({ error: 'Error al subir la foto' });
    }

    const { data: urlData } = supabase.storage.from('avatars').getPublicUrl(fotoName);

    await supabase
      .from('users')
      .update({ foto_url: urlData.publicUrl, updated_at: new Date().toISOString() })
      .eq('id', request.user.sub);

    return reply.send({ foto_url: urlData.publicUrl });
  });
}
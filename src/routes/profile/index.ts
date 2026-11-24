import type { FastifyInstance } from 'fastify';
import bcrypt                   from 'bcryptjs';
import { sql, definidos }       from '../../db/sql';
import { registrarAudit, ipDeRequest } from '../../plugins/audit';
import { validarPoliticaPassword, DESCRIPCION_POLITICA } from '../../plugins/password';
import { revocarSesiones } from '../../plugins/sesiones';

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

const CAMPOS_PERFIL = ['id', 'email', 'nombre', 'username', 'rol', 'foto_url', 'direccion', 'telefono', 'edad', 'fecha_registro'];

export async function profileRoutes(app: FastifyInstance): Promise<void> {

  app.addHook('preHandler', app.authenticate);

  // ─── GET /api/profile ──────────────────────────────────────────────────────
  app.get('/', async (request, reply) => {
    const [data] = await sql`
      select ${sql(CAMPOS_PERFIL)} from users where id = ${request.user.sub}`;

    if (!data) {
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
    // Solo estos campos: el cuerpo nunca debe poder cambiar rol, activo o password.
    const { nombre, username, direccion, telefono, edad } = request.body;

    try {
      const cambios = definidos({ nombre, username, direccion, telefono, edad, updated_at: new Date() });
      const [data] = await sql`
        update users set ${sql(cambios)} where id = ${request.user.sub}
        returning ${sql(CAMPOS_PERFIL)}`;
      if (!data) throw new Error('perfil inexistente');
      return reply.send({ user: data });
    } catch (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al actualizar el perfil' });
    }
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

    const [user] = await sql<{ password: string }[]>`
      select password from users where id = ${request.user.sub}`;

    if (!user) {
      return reply.code(404).send({ error: 'Usuario no encontrado' });
    }

    const valid = await bcrypt.compare(password_actual, user.password);

    if (!valid) {
      return reply.code(401).send({ error: 'La contraseña actual es incorrecta' });
    }

    const newHash = await bcrypt.hash(password_nueva, 12);

    await sql`update users set password = ${newHash}, updated_at = now() where id = ${request.user.sub}`;
    // Quien tuviera la contraseña anterior pierde las sesiones que haya abierto con ella.
    const cerradas = await revocarSesiones(request.user.sub, request.user.jti ?? null);

    await registrarAudit(app, {
      user_id: request.user.sub,
      email:   request.user.email,
      accion:  'CAMBIO_CONTRASENA',
      detalle: 'El usuario cambió su propia contraseña',
      ip:      ipDeRequest(request)
    });

    return reply.send({ message: 'Contraseña actualizada correctamente', sesiones_cerradas: cerradas });
  });


  // ─── PUT /api/profile/foto ─────────────────────────────────────────────────
  // Recibe la foto_url ya subida por el frontend a Supabase Storage
  app.put<{ Body: { foto_url?: string } }>('/foto', async (request, reply) => {
    const { foto_url } = request.body;

    if (!foto_url) {
      return reply.code(400).send({ error: 'foto_url es obligatoria' });
    }

    try {
      await sql`update users set foto_url = ${foto_url}, updated_at = now() where id = ${request.user.sub}`;
    } catch (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al guardar la foto' });
    }

    return reply.send({ foto_url });
  });
}
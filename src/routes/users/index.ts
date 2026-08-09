import type { FastifyInstance } from 'fastify';
import bcrypt                   from 'bcryptjs';
import { supabase }             from '../../db/supabase';
import { isAdminRole, UserRole, ROLES_VALIDOS, PERMISOS_DISPONIBLES } from '../../types/index';
import { registrarAudit, ipDeRequest } from '../../plugins/audit';
import { validarPoliticaPassword, DESCRIPCION_POLITICA } from '../../plugins/password';

interface CreateUserBody {
  email:       string;
  password:    string;
  nombre:      string;
  username?:   string;
  direccion?:  string;
  telefono?:   string;
  edad?:       number;
  rol?:        UserRole;
  permissions?: string[];
}

interface UpdateUserBody {
  nombre?:    string;
  username?:  string;
  email?:     string;
  direccion?: string;
  telefono?:  string;
  edad?:      number;
  activo?:    boolean;
  rol?:       UserRole;
}

interface ChangePasswordBody {
  password: string;
}

interface RolBody {
  rol: UserRole;
}

interface PermisosBody {
  permissions: string[];
}

export async function usersRoutes(app: FastifyInstance): Promise<void> {

  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', async (request, reply) => {
    if (!isAdminRole(request.user.rol)) {
      return reply.code(403).send({ error: 'Acceso denegado' });
    }
  });

  // ─── GET /api/users ────────────────────────────────────────────────────────
  app.get('/', async (_request, reply) => {
    const { data: users, error } = await supabase
      .from('users')
      .select('id, email, username, nombre, rol, permissions, foto_url, activo, fecha_registro')
      .order('fecha_registro', { ascending: false });

    if (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al obtener usuarios' });
    }

    const { data: todasOrdenes } = await supabase
      .from('orders')
      .select('user_id, order_items(id)')
      .eq('status', 'COMPLETADO');

    const beatsPorUsuario: Record<string, number> = {};
    for (const orden of todasOrdenes ?? []) {
      const uid   = orden.user_id;
      const items = Array.isArray(orden.order_items) ? orden.order_items.length : 0;
      beatsPorUsuario[uid] = (beatsPorUsuario[uid] ?? 0) + items;
    }

    const usersConBeats = (users ?? []).map(user => ({
      ...user,
      beats_comprados: beatsPorUsuario[user.id] ?? 0
    }));

    return reply.send({ users: usersConBeats });
  });


  // ─── POST /api/users ───────────────────────────────────────────────────────
  // Alta de usuarios por el administrador
  app.post<{ Body: CreateUserBody }>('/', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password', 'nombre'],
        properties: {
          email:    { type: 'string' },
          password: { type: 'string' },
          nombre:   { type: 'string' },
          username: { type: 'string' },
          direccion:{ type: 'string' },
          telefono: { type: 'string' },
          edad:     { type: 'number' },
          rol:      { type: 'string' },
          permissions: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  }, async (request, reply) => {
    const { email, password, nombre, username, direccion, telefono, edad, rol, permissions } = request.body;

    if (!email || !email.includes('@')) {
      return reply.code(400).send({ error: 'Email inválido' });
    }

    const errorPolitica = validarPoliticaPassword(password);
    if (errorPolitica) {
      return reply.code(400).send({ error: errorPolitica, politica: DESCRIPCION_POLITICA });
    }

    const rolFinal = rol && ROLES_VALIDOS.includes(rol) ? rol : 'CLIENTE';

    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase().trim())
      .maybeSingle();

    if (existing) {
      return reply.code(409).send({ error: 'El email ya está registrado' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const { data: user, error } = await supabase
      .from('users')
      .insert({
        email:       email.toLowerCase().trim(),
        password:    passwordHash,
        nombre,
        username:    username?.trim()  || null,
        direccion:   direccion?.trim() || null,
        telefono:    telefono?.trim()  || null,
        edad:        edad ?? null,
        rol:         rolFinal,
        permissions: permissions ?? []
      })
      .select('id, email, nombre, username, rol, permissions, activo, fecha_registro')
      .single();

    if (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al crear el usuario' });
    }

    await registrarAudit(app, {
      user_id: request.user.sub,
      email:   request.user.email,
      accion:  'ALTA_USUARIO',
      detalle: `Admin creó a ${user.nombre} (${user.email}) con rol ${user.rol}`,
      ip:      ipDeRequest(request)
    });

    return reply.code(201).send({ user });
  });


  // ─── GET /api/users/:id ────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { data, error } = await supabase
      .from('users')
      .select('id, email, username, nombre, rol, permissions, foto_url, direccion, telefono, edad, activo, fecha_registro')
      .eq('id', request.params.id)
      .single();

    if (error || !data) {
      return reply.code(404).send({ error: 'Usuario no encontrado' });
    }

    const { data: compras } = await supabase
      .from('orders')
      .select(`
        id, total, created_at,
        order_items (
          beats ( id, nombre, genero, precio, imagen_url )
        )
      `)
      .eq('user_id', request.params.id)
      .eq('status', 'COMPLETADO')
      .order('created_at', { ascending: false });

    return reply.send({ user: data, compras: compras ?? [] });
  });


  // ─── PUT /api/users/:id ────────────────────────────────────────────────────
  // Edición de usuarios (datos + activación/desactivación)
  app.put<{ Params: { id: string }; Body: UpdateUserBody }>('/:id', async (request, reply) => {
const { id } = request.params;
    const { nombre, username, email, direccion, telefono, edad, activo, rol } = request.body;

    if (id === request.user.sub) {
      return reply.code(400).send({ error: 'No puedes editar tu propia cuenta desde este módulo' });
    }

    const { data: actual } = await supabase
      .from('users')
      .select('nombre, email, rol, activo')
      .eq('id', id)
      .single();

    if (!actual) {
      return reply.code(404).send({ error: 'Usuario no encontrado' });
    }

    if (rol !== undefined) {
      if (!ROLES_VALIDOS.includes(rol)) {
        return reply.code(400).send({ error: 'Rol inválido' });
      }
    }

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (nombre)    patch.nombre    = nombre;
    if (username !== undefined) patch.username = username || null;
    if (direccion !== undefined) patch.direccion = direccion || null;
    if (telefono  !== undefined) patch.telefono  = telefono  || null;
    if (edad      !== undefined) patch.edad      = edad;
    if (email)    patch.email     = email.toLowerCase().trim();
    if (rol      !== undefined)  patch.rol       = rol;

    if (activo !== undefined) {
      patch.activo = activo;
      if (!activo) {
        await registrarAudit(app, {
          user_id: request.user.sub,
          email:   request.user.email,
          accion:  'ELIMINACION_USUARIO',
          detalle: `Desactivó (eliminación lógica) a ${actual.nombre} (${actual.email})`,
          ip:      ipDeRequest(request)
        });
      } else {
        await registrarAudit(app, {
          user_id: request.user.sub,
          email:   request.user.email,
          accion:  'ACTIVACION_USUARIO',
          detalle: `Reactivó a ${actual.nombre} (${actual.email})`,
          ip:      ipDeRequest(request)
        });
      }
    }

    const { data: user, error } = await supabase
      .from('users')
      .update(patch)
      .eq('id', id)
      .select('id, email, username, nombre, rol, permissions, foto_url, activo, fecha_registro')
      .single();

    if (error || !user) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al actualizar el usuario' });
    }

    if (rol !== undefined && rol !== actual.rol) {
      await registrarAudit(app, {
        user_id: request.user.sub,
        email:   request.user.email,
        accion:  'CAMBIO_ROL',
        detalle: `Cambió el rol de ${actual.nombre} (${actual.email}) de ${actual.rol} a ${rol}`,
        ip:      ipDeRequest(request)
      });
    }

    return reply.send({ user });
  });


  // ─── PUT /api/users/:id/password ───────────────────────────────────────────
  // Cambio de contraseña de un usuario por el administrador
  app.put<{ Params: { id: string }; Body: ChangePasswordBody }>('/:id/password', {
    schema: {
      body: {
        type: 'object',
        required: ['password'],
        properties: { password: { type: 'string' } }
      }
    }
  }, async (request, reply) => {
    const { password } = request.body;

    const errorPolitica = validarPoliticaPassword(password);
    if (errorPolitica) {
      return reply.code(400).send({ error: errorPolitica, politica: DESCRIPCION_POLITICA });
    }

    const { data: target } = await supabase
      .from('users')
      .select('nombre, email')
      .eq('id', request.params.id)
      .single();

    if (!target) {
      return reply.code(404).send({ error: 'Usuario no encontrado' });
    }

    const newHash = await bcrypt.hash(password, 12);

    const { error } = await supabase
      .from('users')
      .update({ password: newHash, updated_at: new Date().toISOString() })
      .eq('id', request.params.id);

    if (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al cambiar la contraseña' });
    }

    await registrarAudit(app, {
      user_id: request.user.sub,
      email:   request.user.email,
      accion:  'CAMBIO_CONTRASENA',
      detalle: `Admin cambió la contraseña de ${target.nombre} (${target.email})`,
      ip:      ipDeRequest(request)
    });

    return reply.send({ message: 'Contraseña actualizada correctamente' });
  });


  // ─── PUT /api/users/:id/rol ────────────────────────────────────────────────
  // Asignación de roles
  app.put<{ Params: { id: string }; Body: RolBody }>('/:id/rol', {
    schema: {
      body: {
        type: 'object',
        required: ['rol'],
        properties: { rol: { type: 'string' } }
      }
    }
  }, async (request, reply) => {
    const { rol } = request.body;

    if (!ROLES_VALIDOS.includes(rol)) {
      return reply.code(400).send({ error: 'Rol inválido' });
    }

    const { data: target } = await supabase
      .from('users')
      .select('nombre, email, rol')
      .eq('id', request.params.id)
      .single();

    if (!target) {
      return reply.code(404).send({ error: 'Usuario no encontrado' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .update({ rol, updated_at: new Date().toISOString() })
      .eq('id', request.params.id)
      .select('id, email, username, nombre, rol, permissions, activo, fecha_registro')
      .single();

    if (error || !user) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al asignar el rol' });
    }

    await registrarAudit(app, {
      user_id: request.user.sub,
      email:   request.user.email,
      accion:  'CAMBIO_ROL',
      detalle: `Cambió el rol de ${target.nombre} (${target.email}) de ${target.rol} a ${rol}`,
      ip:      ipDeRequest(request)
    });

    return reply.send({ user });
  });


  // ─── PUT /api/users/:id/permisos ───────────────────────────────────────────
  // Modificación de permisos
  app.put<{ Params: { id: string }; Body: PermisosBody }>('/:id/permisos', {
    schema: {
      body: {
        type: 'object',
        required: ['permissions'],
        properties: {
          permissions: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  }, async (request, reply) => {
    const { permissions } = request.body;

    const invalidos = permissions.filter(p => !PERMISOS_DISPONIBLES.includes(p));
    if (invalidos.length > 0) {
      return reply.code(400).send({ error: `Permisos inválidos: ${invalidos.join(', ')}` });
    }

    const { data: target } = await supabase
      .from('users')
      .select('nombre, email')
      .eq('id', request.params.id)
      .single();

    if (!target) {
      return reply.code(404).send({ error: 'Usuario no encontrado' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .update({ permissions, updated_at: new Date().toISOString() })
      .eq('id', request.params.id)
      .select('id, email, username, nombre, rol, permissions, activo, fecha_registro')
      .single();

    if (error || !user) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al actualizar permisos' });
    }

    await registrarAudit(app, {
      user_id: request.user.sub,
      email:   request.user.email,
      accion:  'CAMBIO_PERMISOS',
      detalle: `Modificó los permisos de ${target.nombre} (${target.email}): ${permissions.join(', ') || 'ninguno'}`,
      ip:      ipDeRequest(request)
    });

    return reply.send({ user });
  });
}

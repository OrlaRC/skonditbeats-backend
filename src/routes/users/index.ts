import type { FastifyInstance } from 'fastify';
import bcrypt                   from 'bcryptjs';
import { sql, filasONada }      from '../../db/sql';
import { isAdminRole, isSuperAdmin, puedeGestionar, UserRole, ROLES_VALIDOS, PERMISOS_DISPONIBLES } from '../../types/index';
import { registrarAudit, ipDeRequest } from '../../plugins/audit';
import { validarPoliticaPassword, DESCRIPCION_POLITICA } from '../../plugins/password';
import { EMAIL }                from '../../schemas/comunes';

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

const SOLO_SUPER = 'Solo el super administrador puede gestionar administradores';

export async function usersRoutes(app: FastifyInstance): Promise<void> {

  /** Rol actual de una cuenta, o null si no existe. */
  async function rolDe(id: string): Promise<string | null> {
    const [fila] = await filasONada(sql<{ rol: string }[]>`select rol from users where id = ${id}`);
    return fila?.rol ?? null;
  }

  /** Cuántos super administradores activos hay (nunca debe quedar ninguno). */
  async function superAdminsActivos(): Promise<number> {
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*) as n from users where rol = 'SUPER_ADMIN' and activo`;
    return n;
  }

  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', async (request, reply) => {
    if (!isAdminRole(request.user.rol)) {
      return reply.code(403).send({ error: 'Acceso denegado' });
    }
  });

  // ─── GET /api/users ────────────────────────────────────────────────────────
  app.get('/', async (_request, reply) => {
    try {
      // Beats comprados por cliente (renglones de órdenes completadas) en la misma consulta.
      const users = await sql`
        select u.id, u.email, u.username, u.nombre, u.rol, u.permissions, u.foto_url, u.activo, u.fecha_registro,
               (select count(*) from order_items oi join orders o on o.id = oi.order_id
                where o.user_id = u.id and o.status = 'COMPLETADO') as beats_comprados
        from users u
        order by u.fecha_registro desc`;
      return reply.send({ users });
    } catch (error) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al obtener usuarios' });
    }
  });


  // ─── POST /api/users ───────────────────────────────────────────────────────
  // Alta de usuarios por el administrador
  app.post<{ Body: CreateUserBody }>('/', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password', 'nombre'],
        properties: {
          email:    EMAIL,
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

    if (!puedeGestionar(request.user.rol, null, rolFinal)) {
      return reply.code(403).send({ error: SOLO_SUPER });
    }

    const [existing] = await sql`select id from users where email = ${email.toLowerCase().trim()}`;

    if (existing) {
      return reply.code(409).send({ error: 'El email ya está registrado' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    let user;
    try {
      [user] = await sql`
        insert into users ${sql({
          email:       email.toLowerCase().trim(),
          password:    passwordHash,
          nombre,
          username:    username?.trim()  || null,
          direccion:   direccion?.trim() || null,
          telefono:    telefono?.trim()  || null,
          edad:        edad ?? null,
          rol:         rolFinal,
          permissions: sql.array(permissions ?? [])
        })}
        returning id, email, nombre, username, rol, permissions, activo, fecha_registro`;
    } catch (error) {
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
    const [data] = await filasONada(sql`
      select id, email, username, nombre, rol, permissions, foto_url, direccion, telefono, edad, activo, fecha_registro
      from users where id = ${request.params.id}`);

    if (!data) {
      return reply.code(404).send({ error: 'Usuario no encontrado' });
    }

    // Misma forma que PostgREST: order_items: [{ beats: {...} }]
    const compras = await sql`
      select o.id, o.total, o.created_at,
             coalesce((
               select json_agg(json_build_object('beats', case when b.id is null then null else json_build_object(
                        'id', b.id, 'nombre', b.nombre, 'genero', b.genero, 'precio', b.precio,
                        'imagen_url', b.imagen_url) end))
               from order_items oi left join beats b on b.id = oi.beat_id
               where oi.order_id = o.id
             ), '[]'::json) as order_items
      from orders o
      where o.user_id = ${request.params.id} and o.status = 'COMPLETADO'
      order by o.created_at desc`;

    return reply.send({ user: data, compras });
  });


  // ─── PUT /api/users/:id ────────────────────────────────────────────────────
  // Edición de usuarios (datos + activación/desactivación)
  app.put<{ Params: { id: string }; Body: UpdateUserBody }>('/:id', async (request, reply) => {
const { id } = request.params;
    const { nombre, username, email, direccion, telefono, edad, activo, rol } = request.body;

    if (id === request.user.sub) {
      return reply.code(400).send({ error: 'No puedes editar tu propia cuenta desde este módulo' });
    }

    const [actual] = await filasONada(sql<{ nombre: string; email: string; rol: UserRole; activo: boolean }[]>`
      select nombre, email, rol, activo from users where id = ${id}`);

    if (!actual) {
      return reply.code(404).send({ error: 'Usuario no encontrado' });
    }

    if (rol !== undefined) {
      if (!ROLES_VALIDOS.includes(rol)) {
        return reply.code(400).send({ error: 'Rol inválido' });
      }
    }

    if (!puedeGestionar(request.user.rol, actual.rol, rol)) {
      return reply.code(403).send({ error: SOLO_SUPER });
    }

    // Nunca dejar el sistema sin un super administrador activo.
    const pierdeSuper = isSuperAdmin(actual.rol) && actual.activo !== false &&
      ((rol !== undefined && rol !== 'SUPER_ADMIN') || activo === false);
    if (pierdeSuper && (await superAdminsActivos()) <= 1) {
      return reply.code(400).send({ error: 'Debe quedar al menos un super administrador activo' });
    }

    const patch: Record<string, unknown> = { updated_at: new Date() };
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

    let user;
    try {
      [user] = await sql`
        update users set ${sql(patch)} where id = ${id}
        returning id, email, username, nombre, rol, permissions, foto_url, activo, fecha_registro`;
      if (!user) throw new Error('usuario inexistente');
    } catch (error) {
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

    if (!puedeGestionar(request.user.rol, await rolDe(request.params.id))) {
      return reply.code(403).send({ error: SOLO_SUPER });
    }

    const errorPolitica = validarPoliticaPassword(password);
    if (errorPolitica) {
      return reply.code(400).send({ error: errorPolitica, politica: DESCRIPCION_POLITICA });
    }

    const [target] = await filasONada(sql<{ nombre: string; email: string }[]>`
      select nombre, email from users where id = ${request.params.id}`);

    if (!target) {
      return reply.code(404).send({ error: 'Usuario no encontrado' });
    }

    const newHash = await bcrypt.hash(password, 12);

    try {
      await sql`update users set password = ${newHash}, updated_at = now() where id = ${request.params.id}`;
    } catch (error) {
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

    const [target] = await filasONada(sql<{ nombre: string; email: string; rol: UserRole }[]>`
      select nombre, email, rol from users where id = ${request.params.id}`);

    if (!target) {
      return reply.code(404).send({ error: 'Usuario no encontrado' });
    }

    if (request.params.id === request.user.sub) {
      return reply.code(400).send({ error: 'No puedes cambiar tu propio rol' });
    }

    if (!puedeGestionar(request.user.rol, target.rol, rol)) {
      return reply.code(403).send({ error: SOLO_SUPER });
    }

    if (target.rol === 'SUPER_ADMIN' && rol !== 'SUPER_ADMIN' && (await superAdminsActivos()) <= 1) {
      return reply.code(400).send({ error: 'Debe quedar al menos un super administrador activo' });
    }

    let user;
    try {
      [user] = await sql`
        update users set rol = ${rol}, updated_at = now() where id = ${request.params.id}
        returning id, email, username, nombre, rol, permissions, activo, fecha_registro`;
      if (!user) throw new Error('usuario inexistente');
    } catch (error) {
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

    if (!puedeGestionar(request.user.rol, await rolDe(request.params.id))) {
      return reply.code(403).send({ error: SOLO_SUPER });
    }

    const invalidos = permissions.filter(p => !PERMISOS_DISPONIBLES.includes(p));
    if (invalidos.length > 0) {
      return reply.code(400).send({ error: `Permisos inválidos: ${invalidos.join(', ')}` });
    }

    const [target] = await filasONada(sql<{ nombre: string; email: string }[]>`
      select nombre, email from users where id = ${request.params.id}`);

    if (!target) {
      return reply.code(404).send({ error: 'Usuario no encontrado' });
    }

    let user;
    try {
      [user] = await sql`
        update users set permissions = ${sql.array(permissions)}, updated_at = now() where id = ${request.params.id}
        returning id, email, username, nombre, rol, permissions, activo, fecha_registro`;
      if (!user) throw new Error('usuario inexistente');
    } catch (error) {
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

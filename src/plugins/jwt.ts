import jwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from '../db/sql';
import type { JwtPayload } from '../types/index';
import { esUuid } from './sesiones';

export async function registerJwt(app: FastifyInstance): Promise<void> {
  const secret = process.env['JWT_SECRET'];

  if (!secret) {
    throw new Error('Falta variable de entorno: JWT_SECRET es obligatoria');
  }

  await app.register(jwt, {
    secret,
    sign: { expiresIn: '7d' }
  });

  app.decorate(
    'authenticate',
    async (request: FastifyRequest, reply: FastifyReply) => {
      let payload: JwtPayload;
      try {
        payload = await request.jwtVerify<JwtPayload>();
      } catch {
        return reply.code(401).send({ error: 'Token inválido o expirado' });
      }

      // El token dura 7 días: el rol y el estado vigentes se leen de la base,
      // para que un cambio de rol o una desactivación apliquen de inmediato.
      // Si el token trae jti (id de su sesión), la sesión debe seguir abierta: cerrar
      // sesión en un dispositivo o "cerrar las demás" invalida ese token al instante.
      // En la misma consulta se anota el último uso (como mucho una vez cada 5 min).
      const jti = esUuid(payload.jti) ? payload.jti : null;
      let cuenta: { rol: string; activo: boolean; sesion_ok: boolean | null } | undefined;
      try {
        [cuenta] = await sql<{ rol: string; activo: boolean; sesion_ok: boolean | null }[]>`
          with toque as (
            update sesiones set ultimo_uso = now()
            where id = ${jti}::uuid and user_id = ${payload.sub} and revocada_at is null
              and ultimo_uso < now() - interval '5 minutes'
            returning id
          )
          select u.rol, u.activo,
                 (select s.revocada_at is null and s.expira_at > now()
                    from sesiones s where s.id = ${jti}::uuid and s.user_id = u.id) as sesion_ok
          from users u where u.id = ${payload.sub}`;
      } catch (error) {
        app.log.error(error);
        return reply.code(503).send({ error: 'Servicio no disponible' });
      }
      if (!cuenta || cuenta.activo === false) {
        return reply.code(401).send({ error: 'Token inválido o expirado' });
      }
      // Tokens emitidos antes de las sesiones (sin jti) valen hasta que caducan.
      if (jti && cuenta.sesion_ok !== true) {
        return reply.code(401).send({ error: 'La sesión se cerró. Inicia sesión de nuevo.' });
      }

      request.user = { ...payload, rol: cuenta.rol as JwtPayload['rol'] };
    }
  );
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

import jwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { supabase } from '../db/supabase';
import type { JwtPayload } from '../types/index';

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
      const { data: cuenta, error } = await supabase
        .from('users')
        .select('rol, activo')
        .eq('id', payload.sub)
        .maybeSingle();

      if (error) {
        app.log.error(error);
        return reply.code(503).send({ error: 'Servicio no disponible' });
      }
      if (!cuenta || cuenta.activo === false) {
        return reply.code(401).send({ error: 'Token inválido o expirado' });
      }

      request.user = { ...payload, rol: cuenta.rol };
    }
  );
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

import jwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
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
      try {
        const payload = await request.jwtVerify<JwtPayload>();
        request.user = payload;
      } catch {
        reply.code(401).send({ error: 'Token inválido o expirado' });
      }
    }
  );
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

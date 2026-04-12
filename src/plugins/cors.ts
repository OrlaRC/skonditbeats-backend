import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';

export async function registerCors(app: FastifyInstance): Promise<void> {
  const rawOrigins = process.env['ALLOWED_ORIGINS'] ?? 'http://localhost:4200';
  const origins = new Set(rawOrigins.split(',').map((o) => o.trim()));

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (origins.has(origin)) return cb(null, true);
      cb(new Error(`Origin no permitido: ${origin}`), false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
  });
}

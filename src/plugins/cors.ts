import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';

const METODOS = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'];
const CABECERAS = ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Skondit-Key', 'X-Tv-Token'];

export async function registerCors(app: FastifyInstance): Promise<void> {
  const rawOrigins = process.env['ALLOWED_ORIGINS'] ?? 'http://localhost:4200';
  const origins = new Set(rawOrigins.split(',').map((o) => o.trim()));

  await app.register(cors, {
    delegator: (request, cb) => {
      // /api/skondit no usa cookies ni la sesión del navegador: se autoriza con la
      // clave de dispositivo (X-Skondit-Key). La PWA de la TV puede servirse desde
      // cualquier origen (p. ej. http://localhost:8080), así que ahí se acepta
      // cualquiera, sin credenciales.
      if ((request.url ?? '').startsWith('/api/skondit/')) {
        return cb(null, { origin: true, credentials: false, methods: ['GET', 'PUT', 'OPTIONS'], allowedHeaders: CABECERAS });
      }
      // /api/tv: la PWA de la TV se autoriza con su propio token (X-Tv-Token) y el
      // teléfono con su JWT en Authorization; ninguno usa cookies, así que tampoco hace
      // falta limitar el origen (sin credenciales, otro sitio no puede usar la sesión).
      if ((request.url ?? '').startsWith('/api/tv/')) {
        return cb(null, { origin: true, credentials: false, methods: METODOS, allowedHeaders: CABECERAS });
      }
      const origin = request.headers.origin;
      if (!origin || origins.has(origin)) {
        return cb(null, { origin: true, credentials: true, methods: METODOS, allowedHeaders: CABECERAS });
      }
      cb(new Error(`Origin no permitido: ${origin}`), { origin: false });
    },
  });
}

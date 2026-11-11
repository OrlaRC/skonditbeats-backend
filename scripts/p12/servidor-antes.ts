// Levanta la ruta ORIGINAL de beats (scripts/p12/original/beats.antes.ts) en el
// puerto 3001, contra la misma base, para medir el "antes" en las mismas condiciones:
//   node --env-file=local/local.env node_modules/tsx/dist/cli.cjs scripts/p12/servidor-antes.ts
//   node scripts/p12/carga.mjs --etiqueta antes --base http://127.0.0.1:3001 --lectura /api/beats --escritura no
import Fastify from 'fastify';
import { registerJwt } from '../../src/plugins/jwt';
import { beatsRoutes } from './original/beats.antes';

async function main(): Promise<void> {
  const app = Fastify();
  await registerJwt(app);
  app.get('/health', async () => ({ status: 'ok' }));
  await app.register(beatsRoutes, { prefix: '/api/beats' });
  await app.listen({ port: 3001, host: '127.0.0.1' });
  console.log('API original (antes) en http://127.0.0.1:3001');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

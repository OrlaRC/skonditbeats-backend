import Fastify        from 'fastify';
import multipart      from '@fastify/multipart';

import { registerCors }   from './plugins/cors';
import { registerJwt }    from './plugins/jwt';

import { authRoutes }     from './routes/auth/index';
import { beatsRoutes }    from './routes/beats/index';
import { usersRoutes }    from './routes/users/index';
import { profileRoutes }  from './routes/profile/index';
import { contactRoutes }  from './routes/contact/index';
import { ordersRoutes }   from './routes/orders/index';
import { statsRoutes }    from './routes/stats/index';

async function start(): Promise<void> {
  const app = Fastify({
    logger: {
      level: process.env['NODE_ENV'] === 'production' ? 'warn' : 'info',
      transport:
        process.env['NODE_ENV'] === 'production'
          ? undefined
          : { target: 'pino-pretty', options: { colorize: true } }
    }
  });

  await registerCors(app);
  await registerJwt(app);

  // ── Multipart global — disponible para beats y profile/foto ───────────────
  await app.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024, files: 2 }
  });

  app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

  await app.register(authRoutes,    { prefix: '/api/auth'    });
  await app.register(beatsRoutes,   { prefix: '/api/beats'   });
  await app.register(usersRoutes,   { prefix: '/api/users'   });
  await app.register(profileRoutes, { prefix: '/api/profile' });
  await app.register(contactRoutes, { prefix: '/api/contact' });
  await app.register(ordersRoutes,  { prefix: '/api/orders'  });
  await app.register(statsRoutes,   { prefix: '/api/stats'   });

  const port = Number(process.env['PORT'] ?? 3000);
  const host = process.env['HOST'] ?? '::';

  await app.listen({ port, host });
  app.log.info(`SkonditBeats API corriendo en http://${host}:${port}`);
}

start().catch(err => {
  console.error(err);
  process.exit(1);
});
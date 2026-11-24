import Fastify        from 'fastify';

import { registerCors }   from './plugins/cors';
import { registerJwt }    from './plugins/jwt';

import { authRoutes }     from './routes/auth/index';
import { beatsRoutes }    from './routes/beats/index';
import { packRoutes }     from './routes/packs/index';
import { usersRoutes }    from './routes/users/index';
import { profileRoutes }  from './routes/profile/index';
import { contactRoutes }  from './routes/contact/index';
import { ordersRoutes }   from './routes/orders/index';
import { statsRoutes }    from './routes/stats/index';
import { auditRoutes }    from './routes/audit/index';
import { uploadRoutes }   from './routes/uploads/index';
import { skonditRoutes }  from './routes/skondit/index';
import { sesionesRoutes } from './routes/sesiones/index';

export async function buildApp() {
  const prod = process.env['NODE_ENV'] === 'production';

  const app = Fastify({
    logger: prod
      ? { level: 'warn' }
      : undefined
  });

  // Un DELETE (o POST sin datos) con Content-Type: application/json y cuerpo vacío se
  // trata como "sin cuerpo" en lugar de responder 400 FST_ERR_CTP_EMPTY_JSON_BODY. La app
  // móvil (Dio) mandaba esa cabecera en todos los DELETE y ninguna baja funcionaba.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, cuerpo, listo) => {
    const texto = String(cuerpo);
    if (texto.trim() === '') return listo(null, undefined);
    try {
      listo(null, JSON.parse(texto));
    } catch {
      const error = new Error('El cuerpo no es JSON válido') as Error & { statusCode: number };
      error.statusCode = 400;
      listo(error, undefined);
    }
  });

  await registerCors(app);
  await registerJwt(app);

  app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

  await app.register(authRoutes,    { prefix: '/api/auth'    });
  await app.register(beatsRoutes,   { prefix: '/api/beats'   });
  await app.register(packRoutes,    { prefix: '/api/packs'   });
  await app.register(usersRoutes,   { prefix: '/api/users'   });
  await app.register(profileRoutes, { prefix: '/api/profile' });
  await app.register(contactRoutes, { prefix: '/api/contact' });
  await app.register(ordersRoutes,  { prefix: '/api/orders'  });
  await app.register(statsRoutes,   { prefix: '/api/stats'   });
  await app.register(auditRoutes,   { prefix: '/api/audit'   });
  await app.register(uploadRoutes,  { prefix: '/api/uploads' });
  await app.register(skonditRoutes, { prefix: '/api/skondit' });
  await app.register(sesionesRoutes, { prefix: '/api/sesiones' });

  return app;
}

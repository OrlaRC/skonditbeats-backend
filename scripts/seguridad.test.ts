// Pruebas de control de acceso (Práctica 10). No tocan la base real: todas las
// llamadas a Supabase se interceptan y se responden aquí.
//   node node_modules/tsx/dist/cli.cjs --test scripts/seguridad.test.ts
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createSigner } from 'fast-jwt';

const SECRETO = 'secreto-solo-para-pruebas';
process.env['JWT_SECRET'] = SECRETO;
process.env['SUPABASE_URL'] = 'http://supabase.invalid';
process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'llave-falsa';

const CLIENTE = '11111111-1111-1111-1111-111111111111';
const ADMIN = '22222222-2222-2222-2222-222222222222';
const DEGRADADO = '33333333-3333-3333-3333-333333333333';
const INACTIVO = '44444444-4444-4444-4444-444444444444';
const MENSAJE = '66666666-6666-6666-6666-666666666666';

const cuentas: Record<string, { rol: string; activo: boolean }> = {
  [CLIENTE]: { rol: 'CLIENTE', activo: true },
  [ADMIN]: { rol: 'ADMIN', activo: true },
  [DEGRADADO]: { rol: 'CLIENTE', activo: true },
  [INACTIVO]: { rol: 'CLIENTE', activo: false },
};

const peticiones: { url: string; method: string; body: string }[] = [];

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = decodeURIComponent(String(input));
  peticiones.push({ url, method: init?.method ?? 'GET', body: String(init?.body ?? '') });
  const id = /id=eq\.([0-9a-f-]{36})/.exec(url)?.[1] ?? '';
  const data = url.includes('select=rol')
    ? (cuentas[id] ?? null)
    : url.includes('/storage/')
      ? { url: '/x?token=t' }
      : url.includes('contact_messages') && id === MENSAJE
        ? { id, nombre: 'Ana', email: 'ana@b.c', user_id: CLIENTE }
        : { id };
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

const token = (sub: string, rol: string, secreto = SECRETO) =>
  createSigner({ key: secreto })({ sub, email: 'a@b.c', rol });

let app: Awaited<ReturnType<typeof import('../src/app').buildApp>>;

before(async () => {
  const { buildApp } = await import('../src/app');
  app = await buildApp();
  await app.ready();
});
after(() => app.close());

const pedir = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, tk?: string, payload?: object) =>
  app.inject({
    method,
    url,
    ...(tk ? { headers: { authorization: `Bearer ${tk}` } } : {}),
    ...(payload ? { payload } : {}),
  });

const RUTAS_ADMIN: ['GET' | 'POST' | 'PUT' | 'DELETE', string, object?][] = [
  ['GET', '/api/users'],
  ['GET', `/api/users/${ADMIN}`],
  ['PUT', `/api/users/${CLIENTE}/rol`, { rol: 'ADMIN' }],
  ['PUT', `/api/users/${ADMIN}/password`, { password: 'Otra-Clave-123!' }],
  ['GET', '/api/stats'],
  ['GET', '/api/audit'],
  ['GET', '/api/contact'],
  ['DELETE', '/api/contact/1'],
  ['PUT', `/api/contact/${MENSAJE}/asignar`, { adminId: ADMIN }],
  ['PUT', `/api/contact/${MENSAJE}/devolver`, { motivo: 'Faltan datos' }],
  ['POST', '/api/beats', { nombre: 'x' }],
  ['DELETE', '/api/beats/1'],
  ['DELETE', '/api/packs/1'],
];

test('sin token se responde 401', async () => {
  for (const [m, u, b] of [...RUTAS_ADMIN, ['GET', '/api/profile'], ['GET', '/api/orders/mis-compras']] as typeof RUTAS_ADMIN) {
    assert.equal((await pedir(m, u, undefined, b)).statusCode, 401, `${m} ${u}`);
  }
});

test('un token firmado con otro secreto se rechaza aunque diga ADMIN', async () => {
  const falso = token(ADMIN, 'ADMIN', 'secreto-del-atacante');
  assert.equal((await pedir('GET', '/api/users', falso)).statusCode, 401);
});

test('un cliente recibe 403 en las rutas de administrador', async () => {
  const tk = token(CLIENTE, 'CLIENTE');
  for (const [m, u, b] of RUTAS_ADMIN) {
    assert.equal((await pedir(m, u, tk, b)).statusCode, 403, `${m} ${u}`);
  }
});

test('un admin degradado pierde el acceso aunque su token diga ADMIN', async () => {
  assert.equal((await pedir('GET', '/api/users', token(DEGRADADO, 'ADMIN'))).statusCode, 403);
});

test('una cuenta desactivada o inexistente ya no entra con su token', async () => {
  assert.equal((await pedir('GET', '/api/profile', token(INACTIVO, 'CLIENTE'))).statusCode, 401);
  const inexistente = '55555555-5555-5555-5555-555555555555';
  assert.equal((await pedir('GET', '/api/profile', token(inexistente, 'CLIENTE'))).statusCode, 401);
});

test('un cliente no puede hacerse ADMIN editando su perfil', async () => {
  peticiones.length = 0;
  await pedir('PUT', '/api/profile', token(CLIENTE, 'CLIENTE'), {
    nombre: 'Nuevo',
    rol: 'ADMIN',
    activo: true,
    password: 'x',
    permissions: ['user:delete'],
  });
  const update = peticiones.find((p) => p.method === 'PATCH');
  assert.ok(update, 'debe intentar la actualización');
  const body = JSON.parse(update.body) as Record<string, unknown>;
  assert.equal(body['nombre'], 'Nuevo');
  for (const campo of ['rol', 'activo', 'password', 'permissions']) {
    assert.ok(!(campo in body), `no debe enviar ${campo}`);
  }
  assert.match(update.url, new RegExp(`id=eq\\.${CLIENTE}`));
});

test('las compras se consultan solo del dueño del token', async () => {
  peticiones.length = 0;
  await pedir('GET', '/api/orders/mis-compras?user_id=' + ADMIN, token(CLIENTE, 'CLIENTE'));
  const consulta = peticiones.find((p) => p.url.includes('/orders'));
  assert.ok(consulta);
  assert.match(consulta.url, new RegExp(`user_id=eq\\.${CLIENTE}`));
  assert.ok(!consulta.url.includes(ADMIN));
});

test('solo el dueño o un admin responden un mensaje', async () => {
  const url = `/api/contact/${MENSAJE}/respuestas`;
  const payload = { texto: 'Hola' };
  assert.equal((await pedir('POST', url, undefined, payload)).statusCode, 401);
  assert.equal((await pedir('POST', url, token(DEGRADADO, 'CLIENTE'), payload)).statusCode, 404);
  assert.equal((await pedir('POST', url, token(CLIENTE, 'CLIENTE'), payload)).statusCode, 201);
  assert.equal((await pedir('POST', url, token(ADMIN, 'ADMIN'), payload)).statusCode, 201);
});

test('un caso solo se pasa a un administrador activo', async () => {
  const url = `/api/contact/${MENSAJE}/asignar`;
  const admin = token(ADMIN, 'ADMIN');
  assert.equal((await pedir('PUT', url, admin, { adminId: CLIENTE })).statusCode, 400);
  assert.equal((await pedir('PUT', url, admin, { adminId: ADMIN })).statusCode, 200);
});

test('el mensaje se liga a la cuenta del token, no a lo que mande el cuerpo', async () => {
  const cuerpo = { nombre: 'Ana', email: 'a@b.c', mensaje: 'Mensaje de prueba', user_id: ADMIN, estado: 'RESPONDIDO' };
  peticiones.length = 0;
  await pedir('POST', '/api/contact', token(CLIENTE, 'CLIENTE'), cuerpo);
  const conSesion = JSON.parse(peticiones.find((p) => p.method === 'POST')!.body);
  assert.equal(conSesion.user_id, CLIENTE);
  assert.ok(!('estado' in conSesion));

  peticiones.length = 0;
  await pedir('POST', '/api/contact', undefined, cuerpo);
  assert.equal(JSON.parse(peticiones.find((p) => p.method === 'POST')!.body).user_id, null);
});

test('un cliente solo pide URLs de subida para su foto', async () => {
  const tk = token(CLIENTE, 'CLIENTE');
  const audio = await pedir('POST', '/api/uploads/presign', tk, { bucket: 'beats-audio', contentType: 'audio/mpeg' });
  assert.equal(audio.statusCode, 403);
  const html = await pedir('POST', '/api/uploads/presign', tk, { bucket: 'avatars', contentType: 'text/html' });
  assert.equal(html.statusCode, 400);
  const foto = await pedir('POST', '/api/uploads/presign', tk, { bucket: 'avatars', contentType: 'image/jpeg' });
  assert.notEqual(foto.statusCode, 403);
  assert.notEqual(foto.statusCode, 400);
});

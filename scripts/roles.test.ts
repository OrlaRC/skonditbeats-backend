// Roles (CLIENTE, ADMIN, SUPER_ADMIN) y avisos de tickets no leídos.
// Sin red ni Supabase: las llamadas a la base se interceptan aquí.
//   node node_modules/tsx/dist/cli.cjs --test scripts/roles.test.ts
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createSigner } from 'fast-jwt';

const SECRETO = 'secreto-solo-para-pruebas';
process.env['JWT_SECRET'] = SECRETO;
process.env['SUPABASE_URL'] = 'http://supabase.invalid';
process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'llave-falsa';

const CLIENTE = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const SUPER = '33333333-3333-4333-8333-333333333333';
const ADMIN2 = '44444444-4444-4444-8444-444444444444';
const TICKET = '66666666-6666-4666-8666-666666666666';

const roles: Record<string, string> = { [CLIENTE]: 'CLIENTE', [ADMIN]: 'ADMIN', [SUPER]: 'SUPER_ADMIN', [ADMIN2]: 'ADMIN' };
let superActivos = 1;

type Peticion = { url: string; method: string; body: any };
const peticiones: Peticion[] = [];

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const p: Peticion = {
    url: decodeURIComponent(String(input)),
    method: init?.method ?? 'GET',
    body: init?.body ? JSON.parse(String(init.body)) : null,
  };
  peticiones.push(p);
  const id = /id=eq\.([0-9a-f-]{36})/.exec(p.url)?.[1] ?? '';
  let data: unknown = { id: 'x' };
  let rango = '0-0/1';
  if (p.url.includes('/users') && p.url.includes('rol=eq.SUPER_ADMIN')) rango = `*/${superActivos}`;
  else if (p.url.includes('/users') && p.method === 'GET') {
    data = roles[id] ? { id, rol: roles[id], activo: true, nombre: 'N', email: 'n@b.c' } : null;
  } else if (p.url.includes('contact_messages') && p.method === 'GET' && p.url.includes('no_leido')) {
    data = [{ id: TICKET, folio: 7 }];
    rango = '0-0/3';
  } else if (p.url.includes('contact_messages')) {
    data = { id: TICKET, folio: 7, nombre: 'Ana', email: 'a@b.c', user_id: CLIENTE, estado: 'ABIERTO' };
  }
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-range': rango },
  });
}) as typeof fetch;

const token = (sub: string) => createSigner({ key: SECRETO })({ sub, email: 'a@b.c', rol: roles[sub] });

let app: Awaited<ReturnType<typeof import('../src/app').buildApp>>;
before(async () => {
  const { buildApp } = await import('../src/app');
  app = await buildApp();
  await app.ready();
});
after(() => app.close());
beforeEach(() => {
  peticiones.length = 0;
  superActivos = 1;
});

const pedir = (method: 'GET' | 'POST' | 'PUT', url: string, quien: string, payload?: object) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token(quien)}` }, ...(payload ? { payload } : {}) });

const parches = (tabla: string) => peticiones.filter((p) => p.method === 'PATCH' && p.url.includes(`/${tabla}`));

test('un SUPER_ADMIN entra al panel igual que un ADMIN', async () => {
  // Lo que importa es que pase la autorización (el simulador no arma las estadísticas completas).
  for (const ruta of ['/api/stats', '/api/users', '/api/audit', '/api/contact']) {
    assert.notEqual((await pedir('GET', ruta, SUPER)).statusCode, 403, ruta);
  }
  assert.equal((await pedir('GET', '/api/users', CLIENTE)).statusCode, 403);
});

test('un ADMIN gestiona clientes pero no administradores', async () => {
  assert.equal((await pedir('PUT', `/api/users/${CLIENTE}/rol`, ADMIN, { rol: 'ADMIN' })).statusCode, 403, 'no puede ascender a admin');
  assert.equal((await pedir('PUT', `/api/users/${ADMIN2}/rol`, ADMIN, { rol: 'CLIENTE' })).statusCode, 403, 'no puede degradar a otro admin');
  assert.equal((await pedir('PUT', `/api/users/${ADMIN2}`, ADMIN, { activo: false })).statusCode, 403, 'no puede desactivar a otro admin');
  assert.equal((await pedir('PUT', `/api/users/${ADMIN2}/password`, ADMIN, { password: 'Otra-Clave-123!' })).statusCode, 403);
  assert.equal(
    (await pedir('POST', '/api/users', ADMIN, { email: 'n@b.c', password: 'Otra-Clave-123!', nombre: 'N', rol: 'ADMIN' })).statusCode,
    403,
    'no puede crear admins',
  );
  assert.equal(parches('users').length, 0, 'ningún cambio llegó a la base');
  assert.equal((await pedir('PUT', `/api/users/${CLIENTE}`, ADMIN, { activo: false })).statusCode, 200, 'sí desactiva clientes');
});

test('el SUPER_ADMIN asigna y quita roles de administrador', async () => {
  assert.equal((await pedir('PUT', `/api/users/${CLIENTE}/rol`, SUPER, { rol: 'ADMIN' })).statusCode, 200);
  assert.equal((await pedir('PUT', `/api/users/${ADMIN2}/rol`, SUPER, { rol: 'SUPER_ADMIN' })).statusCode, 200);
  assert.equal((await pedir('PUT', `/api/users/${ADMIN2}/rol`, SUPER, { rol: 'MODERADOR' })).statusCode, 400, 'rol fuera de los tres');
});

test('nadie cambia su propio rol y no puede quedar cero super administradores', async () => {
  assert.equal((await pedir('PUT', `/api/users/${SUPER}/rol`, SUPER, { rol: 'CLIENTE' })).statusCode, 400);
  roles['55555555-5555-4555-8555-555555555555'] = 'SUPER_ADMIN';
  const otroSuper = '55555555-5555-4555-8555-555555555555';
  superActivos = 1;
  assert.equal((await pedir('PUT', `/api/users/${otroSuper}/rol`, SUPER, { rol: 'ADMIN' })).statusCode, 400, 'es el único activo');
  superActivos = 2;
  assert.equal((await pedir('PUT', `/api/users/${otroSuper}/rol`, SUPER, { rol: 'ADMIN' })).statusCode, 200);
});

test('responder un ticket marca la novedad para el otro lado', async () => {
  await pedir('POST', `/api/contact/${TICKET}/respuestas`, ADMIN, { texto: 'Listo' });
  assert.equal(parches('contact_messages').at(-1)!.body.no_leido_cliente, true);
  peticiones.length = 0;
  await pedir('POST', `/api/contact/${TICKET}/respuestas`, CLIENTE, { texto: 'Gracias' });
  const b = parches('contact_messages').at(-1)!.body;
  assert.equal(b.no_leido_admin, true);
  assert.ok(!('no_leido_cliente' in b));
});

test('los avisos no leídos se filtran por quien pregunta', async () => {
  const c = await pedir('GET', '/api/contact/no-leidos', CLIENTE);
  assert.equal(c.json().total, 3);
  const qc = peticiones.find((p) => p.url.includes('contact_messages'))!.url;
  assert.match(qc, new RegExp(`user_id=eq\\.${CLIENTE}`));
  assert.match(qc, /no_leido_cliente=eq\.true/);

  peticiones.length = 0;
  await pedir('GET', '/api/contact/no-leidos', ADMIN);
  const qa = peticiones.find((p) => p.url.includes('contact_messages'))!.url;
  assert.match(qa, /no_leido_admin=eq\.true/);
  assert.ok(!qa.includes('user_id=eq'));
});

test('marcar visto solo apaga el aviso de quien lo ve, y un cliente solo el suyo', async () => {
  assert.equal((await pedir('PUT', `/api/contact/${TICKET}/visto`, CLIENTE)).statusCode, 204);
  const p = parches('contact_messages').at(-1)!;
  assert.deepEqual(p.body, { no_leido_cliente: false });
  assert.match(p.url, new RegExp(`user_id=eq\\.${CLIENTE}`));
  peticiones.length = 0;
  await pedir('PUT', `/api/contact/${TICKET}/visto`, ADMIN);
  assert.deepEqual(parches('contact_messages').at(-1)!.body, { no_leido_admin: false });
});

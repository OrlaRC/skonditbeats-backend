// Práctica 11 · Pruebas de caja blanca de la API.
// Cada prueba recorre un camino del grafo de flujo del controlador (ver
// docs/practica11 en la app). No hay red ni base real: las llamadas a Supabase se
// interceptan con un fetch falso, igual que en scripts/tickets.test.ts.
//   node --experimental-test-coverage node_modules/tsx/dist/cli.cjs --test scripts/p11/whitebox.test.ts
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createSigner } from 'fast-jwt';
import bcrypt from 'bcryptjs';

const SECRETO = 'secreto-solo-para-pruebas';
process.env['JWT_SECRET'] = SECRETO;
process.env['SUPABASE_URL'] = 'http://supabase.invalid';
process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'llave-falsa';

const CLIENTE = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const B1 = 'b1b1b1b1-0000-4000-8000-000000000001';
const B2 = 'b2b2b2b2-0000-4000-8000-000000000002';
const NO_EXISTE = 'deaddead-0000-4000-8000-000000000000';
const ORDEN = '0000aaaa-0000-4000-8000-00000000000a';
const CLAVE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const HASH = bcrypt.hashSync('Prueba-12345!', 4);

type Peticion = { url: string; method: string; body: any };
type Respuesta = { status?: number; data: unknown } | undefined;

const peticiones: Peticion[] = [];
let reglas: ((p: Peticion) => Respuesta)[] = [];

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const p: Peticion = {
    url: decodeURIComponent(String(input)),
    method: init?.method ?? 'GET',
    body: init?.body ? JSON.parse(String(init.body)) : null,
  };
  peticiones.push(p);
  let r: Respuesta;
  for (const regla of reglas) if ((r = regla(p))) break;
  r ??= p.url.includes('select=rol')
    ? { data: { rol: p.url.includes(ADMIN) ? 'ADMIN' : 'CLIENTE', activo: true } }
    : { data: [] };
  return new Response(r.data === undefined ? '' : JSON.stringify(r.data), {
    status: r.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

const ERROR_UUID = { status: 400, data: { code: '22P02', message: 'invalid input syntax for type uuid' } };
const ERROR_BD = { status: 503, data: { code: 'PGRST000', message: 'Could not connect to the database' } };
const BEATS = [
  { id: B1, nombre: 'Noche', precio: 299 },
  { id: B2, nombre: 'Lluvia', precio: 150 },
];

const token = (sub: string, rol: string) => createSigner({ key: SECRETO })({ sub, email: 'a@b.c', rol });

let app: Awaited<ReturnType<typeof import('../../src/app').buildApp>>;
before(async () => {
  const { buildApp } = await import('../../src/app');
  app = await buildApp();
  await app.ready();
});
after(() => app.close());
beforeEach(() => {
  peticiones.length = 0;
  reglas = [];
});

const pedir = (method: 'GET' | 'POST', url: string, tk?: string, payload?: object, clave?: string) =>
  app.inject({
    method,
    url,
    headers: {
      ...(tk ? { authorization: `Bearer ${tk}` } : {}),
      ...(clave ? { 'idempotency-key': clave } : {}),
    },
    ...(payload ? { payload } : {}),
  });

const escrituras = (tabla: string, metodo = 'POST') =>
  peticiones.filter((p) => p.method === metodo && p.url.includes(`/rest/v1/${tabla}`));

/** Regla: responde `data` a las lecturas (GET) de la tabla indicada. */
const lee = (tabla: string, data: unknown, status = 200) => (p: Peticion): Respuesta =>
  p.method === 'GET' && p.url.includes(`/rest/v1/${tabla}?`) ? { status, data } : undefined;
const escribe = (tabla: string, data: unknown, status = 201, metodo = 'POST') => (p: Peticion): Respuesta =>
  p.method === metodo && p.url.includes(`/rest/v1/${tabla}`) ? { status, data } : undefined;

/** Verifica que el JSON no exponga datos sensibles en ningún nivel. */
function sinDatosSensibles(json: unknown) {
  const texto = JSON.stringify(json);
  for (const campo of ['"password"', 'intentos_fallidos', 'bloqueado_hasta', '$2a$', '$2b$', 'service_role']) {
    assert.ok(!texto.includes(campo), `la respuesta expone ${campo}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// E1 · POST /api/orders (comunicación con la base de datos + cálculo del total)
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/orders · caminos del grafo', () => {
  test('C1 sin token → 401 (no autenticado)', async () => {
    const r = await pedir('POST', '/api/orders', undefined, { beats: [B1] });
    assert.equal(r.statusCode, 401);
    assert.equal(escrituras('orders').length, 0);
  });

  test('C2 lista vacía (minItems = 1, valor límite 0) → 400 por esquema', async () => {
    const r = await pedir('POST', '/api/orders', token(CLIENTE, 'CLIENTE'), { beats: [] });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().code, 'FST_ERR_VALIDATION');
  });

  test('C3 cuerpo sin beats ni packId → 400', async () => {
    const r = await pedir('POST', '/api/orders', token(CLIENTE, 'CLIENTE'), {});
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, 'Se requiere beats o packId');
  });

  test('C4 tipo incorrecto: un número en lugar de arreglo → 400', async () => {
    const r = await pedir('POST', '/api/orders', token(CLIENTE, 'CLIENTE'), { beats: { a: 1 } });
    assert.equal(r.statusCode, 400);
  });

  test('C4b un texto suelto se convierte en arreglo (coerceTypes de Fastify) y aun así se rechaza', async () => {
    // Hallazgo OBS-01: Ajv en Fastify usa coerceTypes:'array', así que "b1" llega como ["b1"].
    reglas = [lee('beats', ERROR_UUID.data, ERROR_UUID.status)];
    const r = await pedir('POST', '/api/orders', token(CLIENTE, 'CLIENTE'), { beats: 'b1' });
    assert.equal(r.statusCode, 422);
    assert.equal(escrituras('orders').length, 0);
  });

  test('C5 beat inexistente → 422 y no se escribe nada', async () => {
    reglas = [lee('beats', [])];
    const r = await pedir('POST', '/api/orders', token(CLIENTE, 'CLIENTE'), { beats: [NO_EXISTE] });
    assert.equal(r.statusCode, 422);
    assert.equal(escrituras('orders').length, 0);
  });

  test('C6 uno existe y otro no → 422 (antes cobraba solo el que existía)', async () => {
    reglas = [lee('beats', [BEATS[0]])];
    const r = await pedir('POST', '/api/orders', token(CLIENTE, 'CLIENTE'), { beats: [B1, NO_EXISTE] });
    assert.equal(r.statusCode, 422);
    assert.equal(escrituras('orders').length, 0);
  });

  test('C7 id con formato inválido (PostgreSQL 22P02) → 422, no 500', async () => {
    reglas = [lee('beats', ERROR_UUID.data, ERROR_UUID.status)];
    const r = await pedir('POST', '/api/orders', token(CLIENTE, 'CLIENTE'), { beats: ['no-es-uuid'] });
    assert.equal(r.statusCode, 422);
  });

  test('C8 la base no responde → 500 con mensaje genérico', async () => {
    reglas = [lee('beats', ERROR_BD.data, ERROR_BD.status)];
    const r = await pedir('POST', '/api/orders', token(CLIENTE, 'CLIENTE'), { beats: [B1] });
    assert.equal(r.statusCode, 500);
    assert.ok(!JSON.stringify(r.json()).includes('PGRST'), 'no debe filtrar detalles internos');
  });

  test('C9 ya compró uno de los beats → 409 (conflicto)', async () => {
    reglas = [lee('beats', BEATS), lee('order_items', [{ beat_id: B1 }])];
    const r = await pedir('POST', '/api/orders', token(CLIENTE, 'CLIENTE'), { beats: [B1, B2] });
    assert.equal(r.statusCode, 409);
    assert.equal(escrituras('orders').length, 0);
  });

  test('C10 compra válida → 201, total = suma de precios de la BD y JSON consistente', async () => {
    reglas = [lee('beats', BEATS), lee('order_items', []), escribe('orders', { id: ORDEN }), escribe('order_items', null)];
    // El cliente no manda precios: el total se calcula con los de la base.
    const r = await pedir('POST', '/api/orders', token(CLIENTE, 'CLIENTE'), { beats: [B1, B2, B1] });
    assert.equal(r.statusCode, 201);
    const { order } = r.json();
    assert.deepEqual(Object.keys(order).sort(), ['id', 'items', 'status', 'total']);
    assert.equal(order.total, 449);
    assert.equal(order.status, 'COMPLETADO');
    assert.equal(escrituras('orders')[0].body.total, 449);
    assert.equal(escrituras('orders')[0].body.user_id, CLIENTE, 'el dueño sale del token, no del cuerpo');
    assert.equal(escrituras('order_items')[0].body.length, 2, 'un beat repetido no se cobra dos veces');
  });

  test('C11 fallan los renglones → 500 y la orden se deshace (sin compras a medias)', async () => {
    reglas = [
      lee('beats', BEATS),
      lee('order_items', []),
      escribe('orders', { id: ORDEN }),
      escribe('order_items', { code: '23503', message: 'fk' }, 409),
      escribe('orders', null, 204, 'DELETE'),
    ];
    const r = await pedir('POST', '/api/orders', token(CLIENTE, 'CLIENTE'), { beats: [B1] });
    assert.equal(r.statusCode, 500);
    const borrado = escrituras('orders', 'DELETE');
    assert.equal(borrado.length, 1, 'se debe borrar la orden incompleta');
    assert.ok(borrado[0].url.includes(`id=eq.${ORDEN}`));
  });

  test('C11b otra compra simultánea ganó la carrera (trg_compra_unica, 23505) → 409 y se deshace', async () => {
    reglas = [
      lee('beats', BEATS),
      lee('order_items', []),
      escribe('orders', { id: ORDEN }),
      escribe('order_items', { code: '23505', message: 'El usuario ya compró el beat' }, 409),
      escribe('orders', null, 204, 'DELETE'),
    ];
    const r = await pedir('POST', '/api/orders', token(CLIENTE, 'CLIENTE'), { beats: [B1] });
    assert.equal(r.statusCode, 409);
    assert.equal(escrituras('orders', 'DELETE').length, 1);
  });

  test('C12 reintento con la misma Idempotency-Key → 200 con la orden original', async () => {
    reglas = [(p) => (p.url.includes('client_ref=eq') ? { data: { id: ORDEN, total: 299, status: 'COMPLETADO' } } : undefined)];
    const r = await pedir('POST', '/api/orders', token(CLIENTE, 'CLIENTE'), { beats: [B1] }, CLAVE);
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().repetida, true);
    assert.equal(escrituras('orders').length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2 · GET /api/beats/:id y GET /api/beats (consulta)
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/beats · caminos del grafo', () => {
  test('C1 beat existente → 200 con { beat }', async () => {
    reglas = [lee('beats', { id: B1, nombre: 'Noche', precio: 299, activo: true })];
    const r = await pedir('GET', `/api/beats/${B1}`);
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().beat.id, B1);
    const consulta = peticiones.find((p) => p.url.includes('/rest/v1/beats?'))!;
    assert.ok(!consulta.url.includes('select=*'), 'solo se piden las columnas que usa la app');
  });

  test('C2 id con formato válido pero inexistente → 404', async () => {
    reglas = [lee('beats', null)];
    const r = await pedir('GET', `/api/beats/${NO_EXISTE}`);
    assert.equal(r.statusCode, 404);
    assert.deepEqual(r.json(), { error: 'Beat no encontrado' });
  });

  test('C3 id que no es UUID → 404 (no puede existir)', async () => {
    reglas = [lee('beats', ERROR_UUID.data, ERROR_UUID.status)];
    const r = await pedir('GET', '/api/beats/123');
    assert.equal(r.statusCode, 404);
  });

  test('C4 la base falla → 500 (antes respondía 404 y ocultaba la caída)', async () => {
    reglas = [lee('beats', ERROR_BD.data, ERROR_BD.status)];
    const r = await pedir('GET', `/api/beats/${B1}`);
    assert.equal(r.statusCode, 500);
  });

  test('C5 lista paginada: límites de limit (0 → 20, 1000 → 100) y estructura estable', async () => {
    reglas = [lee('beats', [])];
    for (const [pedido, esperado] of [['0', 20], ['1', 1], ['100', 100], ['1000', 100], ['-5', 1]] as const) {
      const r = await pedir('GET', `/api/beats?limit=${pedido}&page=1`);
      assert.equal(r.statusCode, 200);
      const j = r.json();
      assert.deepEqual(Object.keys(j).sort(), ['beats', 'generos', 'limit', 'page', 'total']);
      assert.equal(j.limit, esperado, `limit=${pedido}`);
    }
  });

  test('C6 búsqueda con caracteres especiales no inyecta filtros en PostgREST', async () => {
    reglas = [lee('beats', [])];
    await pedir('GET', '/api/beats?limit=20&search=' + encodeURIComponent("x),precio.lt.1,(nombre.ilike.*"));
    const consulta = peticiones.find((p) => p.url.includes('or=('))!;
    assert.ok(!consulta.url.includes('precio.lt.1,'), consulta.url);
    assert.ok(!consulta.url.includes('*'), consulta.url);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E3 · POST /api/auth/login y control de acceso (401 ≠ 403)
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/auth/login y autorización', () => {
  const usuario = (extra: object = {}) => ({
    id: ADMIN, email: 'admin@local.test', nombre: 'Admin', username: 'admin', rol: 'ADMIN',
    password: HASH, foto_url: null, activo: true, intentos_fallidos: 0, bloqueado_hasta: null, ...extra,
  });

  test('C1 faltan campos → 400', async () => {
    const r = await pedir('POST', '/api/auth/login', undefined, { email: 'a@b.c' });
    assert.equal(r.statusCode, 400);
  });

  test('C2 correo no registrado → 401 genérico (no revela si existe)', async () => {
    reglas = [lee('users', null)];
    const r = await pedir('POST', '/api/auth/login', undefined, { email: 'nadie@x.com', password: 'x' });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().error, 'Credenciales inválidas');
  });

  test('C3 contraseña incorrecta → 401 con el MISMO mensaje que C2 y suma un intento', async () => {
    reglas = [lee('users', usuario())];
    const r = await pedir('POST', '/api/auth/login', undefined, { email: 'admin@local.test', password: 'mala' });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().error, 'Credenciales inválidas');
    assert.equal(escrituras('users', 'PATCH')[0].body.intentos_fallidos, 1);
  });

  test('C4 quinto intento fallido (valor límite) → 423 y bloqueo', async () => {
    reglas = [lee('users', usuario({ intentos_fallidos: 4 }))];
    const r = await pedir('POST', '/api/auth/login', undefined, { email: 'admin@local.test', password: 'mala' });
    assert.equal(r.statusCode, 423);
    assert.ok(escrituras('users', 'PATCH')[0].body.bloqueado_hasta);
  });

  test('C5 cuenta bloqueada todavía vigente → 423 sin comparar la contraseña', async () => {
    const hasta = new Date(Date.now() + 5 * 60_000).toISOString();
    reglas = [lee('users', usuario({ bloqueado_hasta: hasta }))];
    const r = await pedir('POST', '/api/auth/login', undefined, { email: 'admin@local.test', password: 'Prueba-12345!' });
    assert.equal(r.statusCode, 423);
  });

  test('C6 cuenta desactivada → 401', async () => {
    reglas = [lee('users', usuario({ activo: false }))];
    const r = await pedir('POST', '/api/auth/login', undefined, { email: 'admin@local.test', password: 'Prueba-12345!' });
    assert.equal(r.statusCode, 401);
  });

  test('C7 credenciales correctas (admin) → 200 con token y SIN el hash de la contraseña', async () => {
    reglas = [lee('users', usuario())];
    const r = await pedir('POST', '/api/auth/login', undefined, { email: ' ADMIN@local.test ', password: 'Prueba-12345!' });
    assert.equal(r.statusCode, 200);
    const j = r.json();
    assert.ok(j.token);
    assert.deepEqual(Object.keys(j.user).sort(), ['email', 'foto_url', 'id', 'nombre', 'rol', 'username']);
    sinDatosSensibles(j.user);
    // El correo se normaliza antes de consultar.
    assert.ok(peticiones[0].url.includes('email=eq.admin@local.test'));
  });

  test('401 sin token vs 403 con token sin permiso (no se confunden)', async () => {
    const sin = await pedir('GET', '/api/users');
    const falso = await pedir('GET', '/api/users', 'token.falso.x');
    const cliente = await pedir('GET', '/api/users', token(CLIENTE, 'CLIENTE'));
    assert.equal(sin.statusCode, 401);
    assert.equal(falso.statusCode, 401);
    assert.equal(cliente.statusCode, 403);
  });

  test('la lista de usuarios (admin) no expone contraseñas', async () => {
    const lista = lee('users', [{ id: CLIENTE, email: 'c@x.com', nombre: 'C', rol: 'CLIENTE', activo: true }]);
    // La consulta de rol del middleware se deja a la regla por defecto.
    reglas = [(p) => (p.url.includes('select=rol') ? undefined : lista(p))];
    const r = await pedir('GET', '/api/users', token(ADMIN, 'ADMIN'));
    assert.equal(r.statusCode, 200);
    sinDatosSensibles(r.json());
    const consulta = peticiones.find((p) => p.url.includes('/rest/v1/users?select=id'))!;
    assert.ok(!consulta.url.includes('password'), 'la consulta no debe pedir la columna password');
  });

  test('correo con formato inválido → 400 en registro y contacto (antes se aceptaba)', async () => {
    for (const email of ['nope', 'a@b', 'a b@c.com', '']) {
      const reg = await pedir('POST', '/api/auth/register', undefined, { email, password: 'Prueba-12345!', nombre: 'Ana', edad: 20 });
      const con = await pedir('POST', '/api/contact', undefined, { nombre: 'Ana', email, mensaje: 'Hola, tengo una duda' });
      assert.equal(reg.statusCode, 400, `registro con "${email}"`);
      assert.equal(con.statusCode, 400, `contacto con "${email}"`);
    }
    assert.equal(escrituras('users').length + escrituras('contact_messages').length, 0);
  });

  test('Google desde la app: ?app=movil viaja en state y el regreso va a skonditbeats://login', async () => {
    const web = await pedir('GET', '/api/auth/google');
    const movil = await pedir('GET', '/api/auth/google?app=movil');
    assert.equal(movil.statusCode, 302);
    assert.ok(String(movil.headers.location).includes('state=movil'));
    assert.ok(!String(web.headers.location).includes('state='), 'la web no cambia');

    const cancelMovil = await pedir('GET', '/api/auth/google/callback?error=access_denied&state=movil');
    const cancelWeb = await pedir('GET', '/api/auth/google/callback?error=access_denied');
    assert.equal(cancelMovil.headers.location, 'skonditbeats://login?error=google_cancelled');
    assert.ok(String(cancelWeb.headers.location).endsWith('/login?error=google_cancelled'));
    assert.ok(!String(cancelWeb.headers.location).startsWith('skonditbeats'));
  });

  test('ruta inexistente → 404', async () => {
    const r = await pedir('GET', '/api/no-existe');
    assert.equal(r.statusCode, 404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Funciones puras: validarBeat (validación) y claveIdempotencia
// ─────────────────────────────────────────────────────────────────────────────
describe('validarBeat · valores límite', async () => {
  const { validarBeat } = await import('../../src/routes/beats/index');
  const ok = { nombre: 'Noche', genero: 'Trap', bpm: 140, precio: 299 };
  const casos: [string, object, boolean][] = [
    ['válido', ok, true],
    ['sin cuerpo', undefined as never, false],
    ['falta precio', { ...ok, precio: undefined }, false],
    ['nombre 1 carácter (límite -1)', { ...ok, nombre: 'A' }, false],
    ['nombre 2 caracteres (límite)', { ...ok, nombre: 'AB' }, true],
    ['nombre 150 (límite)', { ...ok, nombre: 'x'.repeat(150) }, true],
    ['nombre 151 (límite +1)', { ...ok, nombre: 'x'.repeat(151) }, false],
    ['nombre solo espacios', { ...ok, nombre: '   ' }, false],
    ['bpm 0', { ...ok, bpm: 0 }, false],
    ['bpm 1', { ...ok, bpm: 1 }, true],
    ['bpm 299', { ...ok, bpm: 299 }, true],
    ['bpm 300', { ...ok, bpm: 300 }, false],
    ['bpm decimal', { ...ok, bpm: 120.5 }, false],
    ['precio 0 (gratis)', { ...ok, precio: 0 }, true],
    ['precio negativo', { ...ok, precio: -0.01 }, false],
    ['precio máximo', { ...ok, precio: 99_999_999 }, true],
    ['precio máximo +1', { ...ok, precio: 100_000_000 }, false],
    ['precio texto', { ...ok, precio: 'abc' }, false],
    ['género 1 carácter', { ...ok, genero: 'R' }, false],
    ['género 81 caracteres', { ...ok, genero: 'g'.repeat(81) }, false],
  ];
  for (const [nombre, cuerpo, valido] of casos) {
    test(nombre, () => assert.equal(validarBeat(cuerpo) === null, valido, String(validarBeat(cuerpo))));
  }
});

describe('claveIdempotencia', async () => {
  const { claveIdempotencia, esDuplicado } = await import('../../src/plugins/idempotencia');
  const req = (v: unknown) => ({ headers: { 'idempotency-key': v } }) as never;
  test('UUID v4 válido en mayúsculas → se normaliza', () =>
    assert.equal(claveIdempotencia(req(CLAVE.toUpperCase())), CLAVE));
  test('arreglo de cabeceras → toma la primera', () => assert.equal(claveIdempotencia(req([CLAVE, 'x'])), CLAVE));
  test('texto que no es UUID → null (no se usa como clave)', () => assert.equal(claveIdempotencia(req("1' or '1'='1")), null));
  test('sin cabecera → null', () => assert.equal(claveIdempotencia(req(undefined)), null));
  test('esDuplicado solo con 23505', () => {
    assert.equal(esDuplicado({ code: '23505' }), true);
    assert.equal(esDuplicado({ code: '23503' }), false);
    assert.equal(esDuplicado(null), false);
  });
});

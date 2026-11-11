// Pruebas de caja blanca de tickets, idempotencia y catálogo (Práctica 12).
// No usan Supabase ni red: cada llamada a la base se intercepta y se responde aquí,
// así corren en milisegundos y dan lo mismo en cualquier Wi-Fi (o sin él).
//   node node_modules/tsx/dist/cli.cjs --test scripts/tickets.test.ts
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createSigner } from 'fast-jwt';

const SECRETO = 'secreto-solo-para-pruebas';
process.env['JWT_SECRET'] = SECRETO;
process.env['SUPABASE_URL'] = 'http://supabase.invalid';
process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'llave-falsa';

const CLIENTE = '11111111-1111-4111-8111-111111111111';
const OTRO = '33333333-3333-4333-8333-333333333333';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const TICKET = '66666666-6666-4666-8666-666666666666';
const CLAVE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

type Peticion = { url: string; method: string; body: any; headers: Record<string, string> };
type Respuesta = { status?: number; data: unknown } | undefined;

const peticiones: Peticion[] = [];
/** Reglas de la prueba en curso; la primera que responde gana. */
let reglas: ((p: Peticion) => Respuesta)[] = [];
let ticket: Record<string, unknown>;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const p: Peticion = {
    url: decodeURIComponent(String(input)),
    method: init?.method ?? 'GET',
    body: init?.body ? JSON.parse(String(init.body)) : null,
    headers: Object.fromEntries(new Headers(init?.headers).entries()),
  };
  peticiones.push(p);

  let r: Respuesta;
  for (const regla of reglas) if ((r = regla(p))) break;
  r ??= p.url.includes('select=rol')
    ? { data: { rol: p.url.includes(ADMIN) ? 'ADMIN' : 'CLIENTE', activo: true } }
    : p.url.includes('/storage/')
      ? { data: { url: '/object/upload/sign/beats-audio/x.mp3?token=tok' } }
      : p.url.includes('contact_messages')
        ? { data: ticket }
        : { data: { id: 'x' } };

  return new Response(JSON.stringify(r.data), {
    status: r.status ?? 200,
    headers: { 'content-type': 'application/json', 'content-range': '0-19/137' },
  });
}) as typeof fetch;

const DUPLICADO = { status: 409, data: { code: '23505', message: 'duplicate key value violates unique constraint' } };

const token = (sub: string, rol: string) => createSigner({ key: SECRETO })({ sub, email: 'a@b.c', rol });

let app: Awaited<ReturnType<typeof import('../src/app').buildApp>>;

before(async () => {
  const { buildApp } = await import('../src/app');
  app = await buildApp();
  await app.ready();
});
after(() => app.close());

beforeEach(() => {
  peticiones.length = 0;
  reglas = [];
  ticket = { id: TICKET, folio: 41, nombre: 'Ana', email: 'ana@b.c', user_id: CLIENTE, estado: 'ABIERTO' };
});

const pedir = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  tk?: string,
  payload?: object,
  clave?: string,
) =>
  app.inject({
    method,
    url,
    headers: { ...(tk ? { authorization: `Bearer ${tk}` } : {}), ...(clave ? { 'idempotency-key': clave } : {}) },
    ...(payload ? { payload } : {}),
  });

const escrituras = (tabla: string, method = 'POST') =>
  peticiones.filter((p) => p.method === method && p.url.includes(`/${tabla}`));

// ── Tickets ──────────────────────────────────────────────────────────────────

test('un reporte de error abre un ticket de prioridad alta y devuelve su folio', async () => {
  const res = await pedir('POST', '/api/contact', token(CLIENTE, 'CLIENTE'), {
    nombre: 'Ana', email: 'ana@b.c', mensaje: 'El beat no suena al comprarlo', tipo: 'ERROR', asunto: '  No suena  ',
  }, CLAVE);
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().ticket.folio, 41);
  const [alta] = escrituras('contact_messages');
  assert.equal(alta.body.prioridad, 'ALTA');
  assert.equal(alta.body.asunto, 'No suena');
  assert.equal(alta.body.client_ref, CLAVE);
  assert.equal(alta.body.user_id, CLIENTE);
});

test('reintentar el mismo ticket no lo duplica: responde el original', async () => {
  reglas = [(p) => (p.method === 'POST' && p.url.includes('contact_messages') ? DUPLICADO : undefined)];
  const res = await pedir('POST', '/api/contact', undefined, {
    nombre: 'Ana', email: 'ana@b.c', mensaje: 'Mensaje que se reintenta',
  }, CLAVE);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().repetida, true);
  assert.equal(res.json().ticket.folio, 41);
  assert.match(peticiones.at(-1)!.url, new RegExp(`client_ref=eq\\.${CLAVE}`));
});

test('una clave de idempotencia mal formada se ignora en vez de guardarse', async () => {
  await pedir('POST', '/api/contact', undefined, { nombre: 'Ana', email: 'ana@b.c', mensaje: 'Mensaje de prueba' }, 'x; drop table');
  assert.equal(escrituras('contact_messages')[0].body.client_ref, null);
});

test('la bandeja paginada pide solo una página y el conteo de respuestas', async () => {
  reglas = [(p) => (p.method === 'GET' && p.url.includes('contact_messages') ? { data: [ticket] } : undefined)];
  const res = await pedir('GET', '/api/contact?limit=20&page=3&estado=ABIERTO&tipo=ERROR', token(ADMIN, 'ADMIN'));
  assert.equal(res.statusCode, 200);
  assert.deepEqual([res.json().total, res.json().page, res.json().limit], [137, 3, 20]);
  const consulta = peticiones.find((p) => p.url.includes('contact_messages'))!;
  assert.match(consulta.url, /offset=40/);
  assert.match(consulta.url, /limit=20/);
  assert.match(consulta.url, /estado=eq\.ABIERTO/);
  assert.match(consulta.url, /tipo=eq\.ERROR/);
  assert.match(consulta.url, /contact_replies\(count\)/);
  assert.ok(!consulta.url.includes('texto'), 'la lista no debe traer el texto de las respuestas');
});

test('sin limit la bandeja responde como antes, para la web', async () => {
  reglas = [(p) => (p.method === 'GET' && p.url.includes('contact_messages') ? { data: [ticket] } : undefined)];
  const res = await pedir('GET', '/api/contact', token(ADMIN, 'ADMIN'));
  assert.equal(res.json().page, undefined);
  assert.match(peticiones.find((p) => p.url.includes('contact_messages'))!.url, /contact_replies\(id,autor_nombre/);
});

test('el cliente solo ve sus tickets y no puede filtrar por admin asignado', async () => {
  reglas = [(p) => (p.method === 'GET' && p.url.includes('contact_messages') ? { data: [] } : undefined)];
  await pedir('GET', `/api/contact/mios?limit=10&asignado=${ADMIN}`, token(CLIENTE, 'CLIENTE'));
  const consulta = peticiones.find((p) => p.url.includes('contact_messages'))!;
  assert.match(consulta.url, new RegExp(`user_id=eq\\.${CLIENTE}`));
  assert.ok(!consulta.url.includes('asignado_a=eq'));
});

test('el detalle de un ticket ajeno se responde como inexistente', async () => {
  const url = `/api/contact/${TICKET}`;
  assert.equal((await pedir('GET', url, token(OTRO, 'CLIENTE'))).statusCode, 404);
  assert.equal((await pedir('GET', url, token(CLIENTE, 'CLIENTE'))).statusCode, 200);
  assert.equal((await pedir('GET', url, token(ADMIN, 'ADMIN'))).statusCode, 200);
  assert.equal((await pedir('GET', url)).statusCode, 401);
});

test('el cliente puede cerrar su ticket pero no ponerlo en proceso', async () => {
  const url = `/api/contact/${TICKET}/estado`;
  const tk = token(CLIENTE, 'CLIENTE');
  assert.equal((await pedir('PUT', url, tk, { estado: 'EN_PROCESO' })).statusCode, 403);
  assert.equal(escrituras('contact_messages', 'PATCH').length, 0);
  assert.equal((await pedir('PUT', url, tk, { estado: 'CERRADO' })).statusCode, 200);
  assert.equal(escrituras('contact_messages', 'PATCH')[0].body.estado, 'CERRADO');
  assert.ok(escrituras('contact_messages', 'PATCH')[0].body.cerrado_at);
  assert.equal((await pedir('PUT', url, token(OTRO, 'CLIENTE'), { estado: 'CERRADO' })).statusCode, 404);
  assert.equal((await pedir('PUT', url, tk, { estado: 'INVENTADO' })).statusCode, 400);
});

test('dos admins mueven el mismo ticket: el segundo recibe 409 y no pisa el cambio', async () => {
  // El UPDATE va condicionado al estado esperado; si no coincide, no regresa fila.
  reglas = [(p) => (p.method === 'PATCH' && p.url.includes('contact_messages') ? { data: null } : undefined)];
  const res = await pedir('PUT', `/api/contact/${TICKET}/estado`, token(ADMIN, 'ADMIN'), { estado: 'EN_PROCESO', esperado: 'ABIERTO' });
  assert.equal(res.statusCode, 409);
  assert.match(escrituras('contact_messages', 'PATCH')[0].url, /estado=eq\.ABIERTO/);
  assert.ok(!peticiones.some((p) => p.url.includes('bitacora')), 'un cambio que no se aplicó no va a la bitácora');
});

test('no se puede responder un ticket cerrado', async () => {
  ticket['estado'] = 'CERRADO';
  const res = await pedir('POST', `/api/contact/${TICKET}/respuestas`, token(CLIENTE, 'CLIENTE'), { texto: 'Sigue fallando' });
  assert.equal(res.statusCode, 409);
  assert.equal(escrituras('contact_replies').length, 0);
});

test('reintentar una respuesta no la duplica ni reenvía el correo', async () => {
  reglas = [(p) => (p.method === 'POST' && p.url.includes('contact_replies') ? DUPLICADO : undefined)];
  const res = await pedir('POST', `/api/contact/${TICKET}/respuestas`, token(ADMIN, 'ADMIN'), { texto: 'Ya quedó' }, CLAVE);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().repetida, true);
  assert.equal(escrituras('contact_messages', 'PATCH').length, 0);
});

test('solo un admin cambia la prioridad', async () => {
  const url = `/api/contact/${TICKET}/prioridad`;
  assert.equal((await pedir('PUT', url, token(CLIENTE, 'CLIENTE'), { prioridad: 'ALTA' })).statusCode, 403);
  assert.equal((await pedir('PUT', url, token(ADMIN, 'ADMIN'), { prioridad: 'URGENTE' })).statusCode, 400);
  assert.equal((await pedir('PUT', url, token(ADMIN, 'ADMIN'), { prioridad: 'BAJA' })).statusCode, 200);
});

// ── Catálogo ─────────────────────────────────────────────────────────────────

test('la tienda paginada hace una sola consulta extra y la reutiliza (caché)', async () => {
  const { invalidarCatalogo } = await import('../src/routes/beats/index');
  invalidarCatalogo();
  reglas = [
    (p) => (p.url.includes('select=genero') ? { data: [{ genero: 'Trap' }, { genero: 'Rap' }, { genero: 'Trap' }] } : undefined),
    (p) => (p.url.includes('/beats') ? { data: [{ id: 'b1' }] } : undefined),
  ];
  const r1 = await pedir('GET', '/api/beats?limit=20&page=2&search=dark,(x)');
  assert.deepEqual(r1.json().generos, ['Rap', 'Trap']);
  assert.equal(r1.json().total, 137);
  assert.equal(peticiones.length, 2);
  const lista = peticiones.find((p) => !p.url.includes('select=genero'))!;
  assert.match(lista.url, /offset=20/);
  assert.ok(!/ilike\.%dark,\(/.test(lista.url), 'la búsqueda no debe poder alterar el filtro');

  peticiones.length = 0;
  await pedir('GET', '/api/beats?limit=20&page=1');
  await pedir('GET', '/api/beats?limit=20&page=1');
  assert.equal(peticiones.length, 2, 'con la caché vigente: una consulta por petición, no tres');
});

test('validación de un beat antes de tocar la base', async () => {
  const { validarBeat } = await import('../src/routes/beats/index');
  const ok = { nombre: 'Dark Trap', genero: 'Trap', bpm: 140, precio: 299 };
  assert.equal(validarBeat(ok), null);
  assert.ok(validarBeat({ ...ok, bpm: 300 }));
  assert.ok(validarBeat({ ...ok, bpm: 120.5 }));
  assert.ok(validarBeat({ ...ok, precio: -1 }));
  assert.ok(validarBeat({ ...ok, nombre: 'x' }));
  assert.ok(validarBeat({ nombre: 'Dark Trap' }));

  const res = await pedir('POST', '/api/beats', token(ADMIN, 'ADMIN'), { ...ok, bpm: 999 });
  assert.equal(res.statusCode, 400);
  assert.equal(escrituras('beats').length, 0);
});

test('ligar el audio de un beat no toca sus demás datos', async () => {
  const url = '/api/beats/b1/media';
  assert.equal((await pedir('PUT', url, token(CLIENTE, 'CLIENTE'), { audio_url: 'https://x/y.mp3' })).statusCode, 403);
  assert.equal((await pedir('PUT', url, token(ADMIN, 'ADMIN'), {})).statusCode, 400);
  assert.equal((await pedir('PUT', url, token(ADMIN, 'ADMIN'), { audio_url: 'https://x/y.mp3' })).statusCode, 200);
  const cambio = escrituras('beats', 'PATCH')[0].body;
  assert.deepEqual(Object.keys(cambio).sort(), ['audio_url', 'updated_at']);
});

test('la URL firmada incluye los datos para la subida reanudable', async () => {
  const res = await pedir('POST', '/api/uploads/presign', token(ADMIN, 'ADMIN'), {
    bucket: 'beats-audio', contentType: 'audio/mpeg', fileName: 'mi beat.mp3',
  });
  assert.equal(res.statusCode, 200);
  const { resumable } = res.json();
  assert.equal(resumable.endpoint, 'http://supabase.invalid/storage/v1/upload/resumable');
  assert.equal(resumable.bucket, 'beats-audio');
  assert.equal(resumable.token, 'tok');
});

// ── Pagos ────────────────────────────────────────────────────────────────────

test('reintentar un pago con la misma clave devuelve la orden original sin cobrar otra vez', async () => {
  reglas = [(p) => (p.url.includes('/orders') && p.url.includes('client_ref=eq') ? { data: { id: 'o1', total: 299, status: 'COMPLETADO' } } : undefined)];
  const res = await pedir('POST', '/api/orders', token(CLIENTE, 'CLIENTE'), { beats: ['b1'] }, CLAVE);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().repetida, true);
  assert.equal(res.json().order.id, 'o1');
  assert.equal(escrituras('orders').length, 0);
  assert.equal(escrituras('order_items').length, 0);
});

test('dos pagos simultáneos con la misma clave: el que pierde la carrera recibe la misma orden', async () => {
  let consultas = 0;
  reglas = [
    (p) => (p.method === 'POST' && p.url.includes('/orders') ? DUPLICADO : undefined),
    // La primera búsqueda por clave aún no ve la orden; la segunda sí.
    (p) => (p.url.includes('client_ref=eq') ? { data: consultas++ === 0 ? null : { id: 'o1', total: 299 } } : undefined),
    (p) => (p.url.includes('order_items') ? { data: [] } : undefined),
    (p) => (p.url.includes('/beats') ? { data: [{ id: 'b1', nombre: 'Beat', precio: 299 }] } : undefined),
  ];
  const res = await pedir('POST', '/api/orders', token(CLIENTE, 'CLIENTE'), { beats: ['b1'] }, CLAVE);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().order.id, 'o1');
  assert.equal(escrituras('order_items').length, 0);
});

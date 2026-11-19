// Práctica 11 · Pruebas de caja blanca de la API.
// Cada prueba recorre un camino del grafo de flujo del controlador (ver
// docs/practica11 en la app). Desde la migración a Neon corren contra una base
// PostgreSQL real (skondit_test, ver scripts/pruebas/entorno.ts): las fallas de la base
// se provocan de verdad (tabla caída, trigger que falla, compras simultáneas).
//   npm test
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bd, iniciar, terminar, vaciar, usuario, beat, compra, token, pedir, conTablaCaida, CONTRASENA,
} from '../pruebas/entorno';

const NO_EXISTE = 'deaddead-0000-4000-8000-000000000000';
const CLAVE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

type U = Awaited<ReturnType<typeof usuario>>;
type B = Awaited<ReturnType<typeof beat>>;
let CLIENTE: U, ADMIN: U;
let B1: B, B2: B;

before(iniciar);
after(terminar);
beforeEach(async () => {
  await vaciar();
  CLIENTE = await usuario({ rol: 'CLIENTE', email: 'cliente@local.test' });
  ADMIN = await usuario({ rol: 'ADMIN', email: 'admin@local.test', nombre: 'Admin' });
  B1 = await beat({ nombre: 'Noche', precio: 299 });
  B2 = await beat({ nombre: 'Lluvia', precio: 150 });
});

const contar = async (tabla: string) => (await bd.unsafe(`select count(*)::int as n from ${tabla}`))[0].n as number;

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
    const r = await pedir('POST', '/api/orders', undefined, { beats: [B1.id] });
    assert.equal(r.statusCode, 401);
    assert.equal(await contar('orders'), 0);
  });

  test('C2 lista vacía (minItems = 1, valor límite 0) → 400 por esquema', async () => {
    const r = await pedir('POST', '/api/orders', token(CLIENTE), { beats: [] });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().code, 'FST_ERR_VALIDATION');
  });

  test('C3 cuerpo sin beats ni packId → 400', async () => {
    const r = await pedir('POST', '/api/orders', token(CLIENTE), {});
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, 'Se requiere beats o packId');
  });

  test('C4 tipo incorrecto: un objeto en lugar de arreglo → 400', async () => {
    const r = await pedir('POST', '/api/orders', token(CLIENTE), { beats: { a: 1 } });
    assert.equal(r.statusCode, 400);
  });

  test('C4b un texto suelto se convierte en arreglo (coerceTypes de Fastify) y aun así se rechaza', async () => {
    // Hallazgo OBS-01: Ajv en Fastify usa coerceTypes:'array', así que "b1" llega como ["b1"].
    const r = await pedir('POST', '/api/orders', token(CLIENTE), { beats: 'b1' });
    assert.equal(r.statusCode, 422);
    assert.equal(await contar('orders'), 0);
  });

  test('C5 beat inexistente → 422 y no se escribe nada', async () => {
    const r = await pedir('POST', '/api/orders', token(CLIENTE), { beats: [NO_EXISTE] });
    assert.equal(r.statusCode, 422);
    assert.equal(await contar('orders'), 0);
  });

  test('C6 uno existe y otro no → 422 (antes cobraba solo el que existía)', async () => {
    const r = await pedir('POST', '/api/orders', token(CLIENTE), { beats: [B1.id, NO_EXISTE] });
    assert.equal(r.statusCode, 422);
    assert.equal(await contar('orders'), 0);
  });

  test('C6b un beat dado de baja ya no se vende → 422', async () => {
    await bd`update beats set activo = false where id = ${B2.id}`;
    const r = await pedir('POST', '/api/orders', token(CLIENTE), { beats: [B2.id] });
    assert.equal(r.statusCode, 422);
  });

  test('C7 id con formato inválido (PostgreSQL 22P02) → 422, no 500', async () => {
    const r = await pedir('POST', '/api/orders', token(CLIENTE), { beats: ['no-es-uuid'] });
    assert.equal(r.statusCode, 422);
  });

  test('C8 la base no responde → 500 con mensaje genérico', async () => {
    const r = await conTablaCaida('beats', () => pedir('POST', '/api/orders', token(CLIENTE), { beats: [B1.id] }));
    assert.equal(r.statusCode, 500);
    const texto = JSON.stringify(r.json());
    assert.ok(!/relation|beats_caida|42P01/.test(texto), 'no debe filtrar detalles internos');
    assert.equal(await contar('orders'), 0);
  });

  test('C9 ya compró uno de los beats → 409 (conflicto)', async () => {
    await compra(CLIENTE.id, [B1.id]);
    const r = await pedir('POST', '/api/orders', token(CLIENTE), { beats: [B1.id, B2.id] });
    assert.equal(r.statusCode, 409);
    assert.equal(await contar('orders'), 1, 'solo la compra anterior');
  });

  test('C10 compra válida → 201, total = suma de precios de la BD y JSON consistente', async () => {
    // El cliente no manda precios: el total se calcula con los de la base.
    const r = await pedir('POST', '/api/orders', token(CLIENTE), { beats: [B1.id, B2.id, B1.id], user_id: ADMIN.id });
    assert.equal(r.statusCode, 201);
    const { order } = r.json();
    assert.deepEqual(Object.keys(order).sort(), ['id', 'items', 'status', 'total']);
    assert.equal(order.total, 449);
    assert.equal(order.status, 'COMPLETADO');
    const [o] = await bd`select total, user_id, status from orders where id = ${order.id}`;
    assert.equal(o.total, 449);
    assert.equal(o.user_id, CLIENTE.id, 'el dueño sale del token, no del cuerpo');
    assert.equal(await contar(`order_items where order_id = '${order.id}'`), 2, 'un beat repetido no se cobra dos veces');
  });

  test('C11 fallan los renglones → 500 y la orden se deshace (sin compras a medias)', async () => {
    // Un trigger temporal hace fallar el INSERT de renglones a media transacción.
    await bd.unsafe(`
      create function falla_renglon() returns trigger language plpgsql as
        $$ begin raise exception 'falla simulada' using errcode = '23503'; end $$;
      create trigger falla_renglon before insert on order_items for each row execute function falla_renglon();`);
    try {
      const r = await pedir('POST', '/api/orders', token(CLIENTE), { beats: [B1.id] });
      assert.equal(r.statusCode, 500);
    } finally {
      await bd.unsafe('drop trigger falla_renglon on order_items; drop function falla_renglon();');
    }
    assert.equal(await contar('orders'), 0, 'la transacción no deja la orden sin renglones');
  });

  test('C11b dos compras simultáneas del mismo beat (sin clave) → una 201 y otra 409, una sola orden', async () => {
    const pagar = () => pedir('POST', '/api/orders', token(CLIENTE), { beats: [B1.id] });
    const codigos = (await Promise.all([pagar(), pagar()])).map(r => r.statusCode).sort();
    assert.deepEqual(codigos, [201, 409]);
    assert.equal(await contar('orders'), 1);
    assert.equal(await contar('order_items'), 1);
  });

  test('C12 reintento con la misma Idempotency-Key → 200 con la orden original', async () => {
    const primero = await pedir('POST', '/api/orders', token(CLIENTE), { beats: [B1.id] }, CLAVE);
    const r = await pedir('POST', '/api/orders', token(CLIENTE), { beats: [B1.id] }, CLAVE);
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().repetida, true);
    assert.equal(r.json().order.id, primero.json().order.id);
    assert.equal(await contar('orders'), 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2 · GET /api/beats/:id y GET /api/beats (consulta)
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/beats · caminos del grafo', () => {
  test('C1 beat existente → 200 con { beat } y solo las columnas que usa la app', async () => {
    const r = await pedir('GET', `/api/beats/${B1.id}`);
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().beat.id, B1.id);
    assert.deepEqual(Object.keys(r.json().beat).sort(),
      ['audio_url', 'bpm', 'created_at', 'descripcion', 'genero', 'id', 'imagen_url', 'nombre', 'precio']);
  });

  test('C2 id con formato válido pero inexistente → 404', async () => {
    const r = await pedir('GET', `/api/beats/${NO_EXISTE}`);
    assert.equal(r.statusCode, 404);
    assert.deepEqual(r.json(), { error: 'Beat no encontrado' });
  });

  test('C3 id que no es UUID → 404 (no puede existir)', async () => {
    const r = await pedir('GET', '/api/beats/123');
    assert.equal(r.statusCode, 404);
  });

  test('C4 la base falla → 500 (antes respondía 404 y ocultaba la caída)', async () => {
    const r = await conTablaCaida('beats', () => pedir('GET', `/api/beats/${B1.id}`));
    assert.equal(r.statusCode, 500);
  });

  test('C5 lista paginada: límites de limit (0 → 20, 1000 → 100) y estructura estable', async () => {
    for (const [pedido, esperado] of [['0', 20], ['1', 1], ['100', 100], ['1000', 100], ['-5', 1]] as const) {
      const r = await pedir('GET', `/api/beats?limit=${pedido}&page=1`);
      assert.equal(r.statusCode, 200);
      const j = r.json();
      assert.deepEqual(Object.keys(j).sort(), ['beats', 'generos', 'limit', 'page', 'total']);
      assert.equal(j.limit, esperado, `limit=${pedido}`);
      assert.ok(j.beats.length <= esperado);
    }
  });

  test('C5b una página después del final → 200 con lista vacía (con PostgREST era 500)', async () => {
    const r = await pedir('GET', '/api/beats?limit=20&page=9');
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json().beats, []);
    assert.equal(r.json().total, 2);
  });

  test('C6 la búsqueda no puede inyectar filtros ni SQL', async () => {
    for (const intento of ['x),precio.lt.1,(nombre.ilike.*', "' or 1=1 --", '%', '_']) {
      const r = await pedir('GET', '/api/beats?limit=20&search=' + encodeURIComponent(intento));
      assert.equal(r.statusCode, 200, intento);
      assert.equal(r.json().total, 0, `"${intento}" se busca literalmente, no amplía el filtro`);
    }
    assert.equal(await contar('beats'), 2, 'la tabla no se alteró');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E3 · POST /api/auth/login y control de acceso (401 ≠ 403)
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/auth/login y autorización', () => {
  const login = (email: string, password: string) => pedir('POST', '/api/auth/login', undefined, { email, password });
  const cuenta = async () => (await bd`select intentos_fallidos, bloqueado_hasta from users where id = ${ADMIN.id}`)[0];

  test('C1 faltan campos → 400', async () => {
    const r = await pedir('POST', '/api/auth/login', undefined, { email: 'a@b.c' });
    assert.equal(r.statusCode, 400);
  });

  test('C2 correo no registrado → 401 genérico (no revela si existe) y queda en la bitácora', async () => {
    const r = await login('nadie@x.com', 'x');
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().error, 'Credenciales inválidas');
    assert.equal(await contar(`bitacora where accion = 'LOGIN_FALLIDO' and email = 'nadie@x.com'`), 1);
  });

  test('C3 contraseña incorrecta → 401 con el MISMO mensaje que C2 y suma un intento', async () => {
    const r = await login('admin@local.test', 'mala');
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().error, 'Credenciales inválidas');
    assert.equal((await cuenta()).intentos_fallidos, 1);
  });

  test('C4 quinto intento fallido (valor límite) → 423 y bloqueo', async () => {
    await bd`update users set intentos_fallidos = 4 where id = ${ADMIN.id}`;
    const r = await login('admin@local.test', 'mala');
    assert.equal(r.statusCode, 423);
    const c = await cuenta();
    assert.ok(c.bloqueado_hasta && Date.parse(c.bloqueado_hasta) > Date.now());
    assert.equal(c.intentos_fallidos, 0);
  });

  test('C5 cuenta bloqueada todavía vigente → 423 sin comparar la contraseña', async () => {
    await bd`update users set bloqueado_hasta = now() + interval '5 minutes' where id = ${ADMIN.id}`;
    const r = await login('admin@local.test', CONTRASENA);
    assert.equal(r.statusCode, 423);
  });

  test('C5b bloqueo vencido → entra y se reinician los intentos', async () => {
    await bd`update users set intentos_fallidos = 3, bloqueado_hasta = now() - interval '1 minute' where id = ${ADMIN.id}`;
    const r = await login('admin@local.test', CONTRASENA);
    assert.equal(r.statusCode, 200);
    const c = await cuenta();
    assert.equal(c.intentos_fallidos, 0);
    assert.equal(c.bloqueado_hasta, null);
  });

  test('C6 cuenta desactivada → 401', async () => {
    await bd`update users set activo = false where id = ${ADMIN.id}`;
    const r = await login('admin@local.test', CONTRASENA);
    assert.equal(r.statusCode, 401);
  });

  test('C7 credenciales correctas (admin) → 200 con token y SIN el hash de la contraseña', async () => {
    // El correo se normaliza (mayúsculas y espacios) antes de consultar.
    const r = await login(' ADMIN@local.test ', CONTRASENA);
    assert.equal(r.statusCode, 200);
    const j = r.json();
    assert.ok(j.token);
    assert.deepEqual(Object.keys(j.user).sort(), ['email', 'foto_url', 'id', 'nombre', 'rol', 'username']);
    sinDatosSensibles(j.user);
    assert.equal(await contar(`bitacora where accion = 'LOGIN' and user_id = '${ADMIN.id}'`), 1);
  });

  test('C8 cliente con contraseña correcta → pide código OTP y lo guarda vigente', async () => {
    const r = await login('cliente@local.test', CONTRASENA);
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().requires2fa, true);
    const codigos = await bd`select code, used, expires_at from otp_codes where user_id = ${CLIENTE.id}`;
    assert.equal(codigos.length, 1);
    assert.equal(codigos[0].used, false);
    // En desarrollo (sin correo configurado) el código viaja en otpDev.
    const v = await pedir('POST', '/api/auth/verify-otp', undefined, { email: 'cliente@local.test', code: codigos[0].code });
    assert.equal(v.statusCode, 200);
    assert.ok(v.json().token);
    const otraVez = await pedir('POST', '/api/auth/verify-otp', undefined, { email: 'cliente@local.test', code: codigos[0].code });
    assert.equal(otraVez.statusCode, 401, 'un código ya usado no vuelve a entrar');
  });

  test('401 sin token vs 403 con token sin permiso (no se confunden)', async () => {
    const sin = await pedir('GET', '/api/users');
    const falso = await pedir('GET', '/api/users', 'token.falso.x');
    const cliente = await pedir('GET', '/api/users', token(CLIENTE));
    assert.equal(sin.statusCode, 401);
    assert.equal(falso.statusCode, 401);
    assert.equal(cliente.statusCode, 403);
  });

  test('la lista de usuarios (admin) no expone contraseñas', async () => {
    const r = await pedir('GET', '/api/users', token(ADMIN));
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().users.length, 2);
    sinDatosSensibles(r.json());
  });

  test('correo con formato inválido → 400 en registro y contacto (antes se aceptaba)', async () => {
    for (const email of ['nope', 'a@b', 'a b@c.com', '']) {
      const reg = await pedir('POST', '/api/auth/register', undefined, { email, password: 'Prueba-12345!', nombre: 'Ana', edad: 20 });
      const con = await pedir('POST', '/api/contact', undefined, { nombre: 'Ana', email, mensaje: 'Hola, tengo una duda' });
      assert.equal(reg.statusCode, 400, `registro con "${email}"`);
      assert.equal(con.statusCode, 400, `contacto con "${email}"`);
    }
    assert.equal(await contar('users'), 2);
    assert.equal(await contar('contact_messages'), 0);
  });

  test('registro correcto → 201, rol CLIENTE y el mismo correo otra vez → 409', async () => {
    const datos = { email: 'Nueva@Prueba.test', password: 'Prueba-12345!', nombre: 'Nueva', edad: 20 };
    const r = await pedir('POST', '/api/auth/register', undefined, datos);
    assert.equal(r.statusCode, 201);
    assert.equal(r.json().user.rol, 'CLIENTE');
    sinDatosSensibles(r.json());
    const [u] = await bd`select email, rol, permissions from users where id = ${r.json().user.id}`;
    assert.deepEqual({ ...u }, { email: 'nueva@prueba.test', rol: 'CLIENTE', permissions: [] });
    assert.equal((await pedir('POST', '/api/auth/register', undefined, datos)).statusCode, 409);
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

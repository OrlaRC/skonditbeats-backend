// Pruebas de control de acceso (Práctica 10), ahora contra una base PostgreSQL real
// (skondit_test, ver scripts/pruebas/entorno.ts): además del código HTTP se revisa lo
// que quedó guardado en la base.
//   npm test
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { bd, iniciar, terminar, vaciar, usuario, ticket, compra, beat, token, pedir, CONTRASENA } from './pruebas/entorno';

type U = Awaited<ReturnType<typeof usuario>>;
let CLIENTE: U, ADMIN: U, DEGRADADO: U, INACTIVO: U;
let MENSAJE: string;

before(iniciar);
after(terminar);

beforeEach(async () => {
  await vaciar();
  CLIENTE = await usuario({ rol: 'CLIENTE', email: 'cliente@prueba.test' });
  ADMIN = await usuario({ rol: 'ADMIN', email: 'admin@prueba.test' });
  DEGRADADO = await usuario({ rol: 'CLIENTE' });            // su token dirá ADMIN
  INACTIVO = await usuario({ rol: 'CLIENTE', activo: false });
  MENSAJE = (await ticket({ user_id: CLIENTE.id })).id;
});

const rutasAdmin = (): ['GET' | 'POST' | 'PUT' | 'DELETE', string, object?][] => [
  ['GET', '/api/users'],
  ['GET', `/api/users/${ADMIN.id}`],
  ['PUT', `/api/users/${CLIENTE.id}/rol`, { rol: 'ADMIN' }],
  ['PUT', `/api/users/${ADMIN.id}/password`, { password: 'Otra-Clave-123!' }],
  ['GET', '/api/stats'],
  ['GET', '/api/audit'],
  ['GET', '/api/contact'],
  ['DELETE', '/api/contact/1'],
  ['PUT', `/api/contact/${MENSAJE}/asignar`, { adminId: ADMIN.id }],
  ['PUT', `/api/contact/${MENSAJE}/devolver`, { motivo: 'Faltan datos' }],
  ['POST', '/api/beats', { nombre: 'x' }],
  ['DELETE', '/api/beats/1'],
  ['DELETE', '/api/packs/1'],
];

test('sin token se responde 401', async () => {
  for (const [m, u, b] of [...rutasAdmin(), ['GET', '/api/profile'], ['GET', '/api/orders/mis-compras']] as ReturnType<typeof rutasAdmin>) {
    assert.equal((await pedir(m, u, undefined, b)).statusCode, 401, `${m} ${u}`);
  }
});

test('un token firmado con otro secreto se rechaza aunque diga ADMIN', async () => {
  const falso = token(ADMIN, 'secreto-del-atacante');
  assert.equal((await pedir('GET', '/api/users', falso)).statusCode, 401);
});

test('un cliente recibe 403 en las rutas de administrador y la base no cambia', async () => {
  const tk = token(CLIENTE);
  for (const [m, u, b] of rutasAdmin()) {
    assert.equal((await pedir(m, u, tk, b)).statusCode, 403, `${m} ${u}`);
  }
  const [c] = await bd`select rol from users where id = ${CLIENTE.id}`;
  assert.equal(c.rol, 'CLIENTE');
});

test('un admin degradado pierde el acceso aunque su token diga ADMIN', async () => {
  assert.equal((await pedir('GET', '/api/users', token({ ...DEGRADADO, rol: 'ADMIN' }))).statusCode, 403);
});

test('una cuenta desactivada o inexistente ya no entra con su token', async () => {
  assert.equal((await pedir('GET', '/api/profile', token(INACTIVO))).statusCode, 401);
  const inexistente = { id: '55555555-5555-4555-8555-555555555555', rol: 'CLIENTE' };
  assert.equal((await pedir('GET', '/api/profile', token(inexistente))).statusCode, 401);
});

test('un cliente no puede hacerse ADMIN editando su perfil', async () => {
  const r = await pedir('PUT', '/api/profile', token(CLIENTE), {
    nombre: 'Nuevo',
    rol: 'ADMIN',
    activo: false,
    password: 'x',
    permissions: ['user:delete'],
  });
  assert.equal(r.statusCode, 200);
  const [fila] = await bd`select nombre, rol, activo, password, permissions from users where id = ${CLIENTE.id}`;
  assert.equal(fila.nombre, 'Nuevo');
  assert.equal(fila.rol, 'CLIENTE');
  assert.equal(fila.activo, true);
  assert.deepEqual(fila.permissions, []);
  assert.notEqual(fila.password, 'x');
  // La contraseña sigue siendo la original.
  assert.equal((await pedir('POST', '/api/auth/login', undefined, { email: CLIENTE.email, password: CONTRASENA })).statusCode, 200);
});

test('las compras se consultan solo del dueño del token', async () => {
  const b1 = await beat({ nombre: 'Del cliente' });
  const b2 = await beat({ nombre: 'Del admin' });
  await compra(CLIENTE.id, [b1.id]);
  await compra(ADMIN.id, [b2.id]);
  const r = await pedir('GET', `/api/orders/mis-compras?user_id=${ADMIN.id}`, token(CLIENTE));
  const nombres = r.json().orders.flatMap((o: any) => o.order_items.map((i: any) => i.beats.nombre));
  assert.deepEqual(nombres, ['Del cliente']);
});

test('solo el dueño o un admin responden un mensaje', async () => {
  const url = `/api/contact/${MENSAJE}/respuestas`;
  const payload = { texto: 'Hola' };
  assert.equal((await pedir('POST', url, undefined, payload)).statusCode, 401);
  assert.equal((await pedir('POST', url, token(DEGRADADO), payload)).statusCode, 404);
  assert.equal((await pedir('POST', url, token(CLIENTE), payload)).statusCode, 201);
  assert.equal((await pedir('POST', url, token(ADMIN), payload)).statusCode, 201);
  const respuestas = await bd`select es_admin from contact_replies where message_id = ${MENSAJE} order by created_at`;
  assert.deepEqual(respuestas.map(r => r.es_admin), [false, true]);
});

test('un caso solo se pasa a un administrador activo', async () => {
  const url = `/api/contact/${MENSAJE}/asignar`;
  const admin = token(ADMIN);
  assert.equal((await pedir('PUT', url, admin, { adminId: CLIENTE.id })).statusCode, 400);
  assert.equal((await pedir('PUT', url, admin, { adminId: ADMIN.id })).statusCode, 200);
  const [t] = await bd`select asignado_a from contact_messages where id = ${MENSAJE}`;
  assert.equal(t.asignado_a, ADMIN.id);
});

test('el mensaje se liga a la cuenta del token, no a lo que mande el cuerpo', async () => {
  const cuerpo = { nombre: 'Ana', email: 'a@b.c', mensaje: 'Mensaje de prueba', user_id: ADMIN.id, estado: 'RESPONDIDO' };
  const conSesion = await pedir('POST', '/api/contact', token(CLIENTE), cuerpo);
  const sinSesion = await pedir('POST', '/api/contact', undefined, cuerpo);
  const [a] = await bd`select user_id, estado from contact_messages where id = ${conSesion.json().ticket.id}`;
  const [b] = await bd`select user_id, estado from contact_messages where id = ${sinSesion.json().ticket.id}`;
  assert.equal(a.user_id, CLIENTE.id);
  assert.equal(a.estado, 'ABIERTO');
  assert.equal(b.user_id, null);
});

test('un cliente solo pide URLs de subida para su foto', async () => {
  const tk = token(CLIENTE);
  const audio = await pedir('POST', '/api/uploads/presign', tk, { bucket: 'beats-audio', contentType: 'audio/mpeg' });
  assert.equal(audio.statusCode, 403);
  const html = await pedir('POST', '/api/uploads/presign', tk, { bucket: 'avatars', contentType: 'text/html' });
  assert.equal(html.statusCode, 400);
  const foto = await pedir('POST', '/api/uploads/presign', tk, { bucket: 'avatars', contentType: 'image/jpeg' });
  assert.notEqual(foto.statusCode, 403);
  assert.notEqual(foto.statusCode, 400);
});

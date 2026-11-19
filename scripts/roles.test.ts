// Roles (CLIENTE, ADMIN, SUPER_ADMIN) y avisos de tickets no leídos, contra una base
// PostgreSQL real (skondit_test, ver scripts/pruebas/entorno.ts).
//   npm test
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { bd, iniciar, terminar, vaciar, usuario, ticket, token, pedir } from './pruebas/entorno';

type U = Awaited<ReturnType<typeof usuario>>;
let CLIENTE: U, ADMIN: U, SUPER: U, ADMIN2: U;
let TICKET: string;

before(iniciar);
after(terminar);
beforeEach(async () => {
  await vaciar();
  CLIENTE = await usuario({ rol: 'CLIENTE' });
  ADMIN = await usuario({ rol: 'ADMIN' });
  SUPER = await usuario({ rol: 'SUPER_ADMIN' });
  ADMIN2 = await usuario({ rol: 'ADMIN' });
  TICKET = (await ticket({ user_id: CLIENTE.id })).id;
});

const rolDe = async (u: U) => (await bd`select rol from users where id = ${u.id}`)[0].rol;
const tk = (u: U) => token(u);

test('un SUPER_ADMIN entra al panel igual que un ADMIN', async () => {
  for (const ruta of ['/api/stats', '/api/users', '/api/audit', '/api/contact']) {
    assert.equal((await pedir('GET', ruta, tk(SUPER))).statusCode, 200, ruta);
  }
  assert.equal((await pedir('GET', '/api/users', tk(CLIENTE))).statusCode, 403);
});

test('un ADMIN gestiona clientes pero no administradores', async () => {
  assert.equal((await pedir('PUT', `/api/users/${CLIENTE.id}/rol`, tk(ADMIN), { rol: 'ADMIN' })).statusCode, 403, 'no puede ascender a admin');
  assert.equal((await pedir('PUT', `/api/users/${ADMIN2.id}/rol`, tk(ADMIN), { rol: 'CLIENTE' })).statusCode, 403, 'no puede degradar a otro admin');
  assert.equal((await pedir('PUT', `/api/users/${ADMIN2.id}`, tk(ADMIN), { activo: false })).statusCode, 403, 'no puede desactivar a otro admin');
  assert.equal((await pedir('PUT', `/api/users/${ADMIN2.id}/password`, tk(ADMIN), { password: 'Otra-Clave-123!' })).statusCode, 403);
  assert.equal(
    (await pedir('POST', '/api/users', tk(ADMIN), { email: 'n@b.c', password: 'Otra-Clave-123!', nombre: 'N', rol: 'ADMIN' })).statusCode,
    403,
    'no puede crear admins',
  );
  // Ningún cambio llegó a la base.
  assert.equal(await rolDe(CLIENTE), 'CLIENTE');
  assert.equal(await rolDe(ADMIN2), 'ADMIN');
  assert.equal((await bd`select activo from users where id = ${ADMIN2.id}`)[0].activo, true);
  assert.equal((await bd`select count(*) as n from users where email = 'n@b.c'`)[0].n, 0);

  assert.equal((await pedir('PUT', `/api/users/${CLIENTE.id}`, tk(ADMIN), { activo: false })).statusCode, 200, 'sí desactiva clientes');
  assert.equal((await bd`select activo from users where id = ${CLIENTE.id}`)[0].activo, false);
});

test('el SUPER_ADMIN asigna y quita roles de administrador', async () => {
  assert.equal((await pedir('PUT', `/api/users/${CLIENTE.id}/rol`, tk(SUPER), { rol: 'ADMIN' })).statusCode, 200);
  assert.equal((await pedir('PUT', `/api/users/${ADMIN2.id}/rol`, tk(SUPER), { rol: 'SUPER_ADMIN' })).statusCode, 200);
  assert.equal((await pedir('PUT', `/api/users/${ADMIN2.id}/rol`, tk(SUPER), { rol: 'MODERADOR' })).statusCode, 400, 'rol fuera de los tres');
  assert.equal(await rolDe(CLIENTE), 'ADMIN');
  assert.equal(await rolDe(ADMIN2), 'SUPER_ADMIN');
});

test('nadie cambia su propio rol y no puede quedar cero super administradores', async () => {
  assert.equal((await pedir('PUT', `/api/users/${SUPER.id}/rol`, tk(SUPER), { rol: 'CLIENTE' })).statusCode, 400);
  assert.equal(await rolDe(SUPER), 'SUPER_ADMIN');

  // otroSuper inactivo: el único super administrador activo es quien hace el cambio.
  const otroSuper = await usuario({ rol: 'SUPER_ADMIN', activo: false });
  const quitar = () => pedir('PUT', `/api/users/${otroSuper.id}/rol`, tk(SUPER), { rol: 'ADMIN' });
  assert.equal((await quitar()).statusCode, 400, 'solo hay un super administrador activo');
  assert.equal(await rolDe(otroSuper), 'SUPER_ADMIN');

  // Con dos activos ya se puede.
  await bd`update users set activo = true where id = ${otroSuper.id}`;
  assert.equal((await quitar()).statusCode, 200);
  assert.equal(await rolDe(otroSuper), 'ADMIN');
});

test('responder un ticket marca la novedad para el otro lado', async () => {
  await bd`update contact_messages set no_leido_cliente = false, no_leido_admin = false where id = ${TICKET}`;
  assert.equal((await pedir('POST', `/api/contact/${TICKET}/respuestas`, tk(ADMIN), { texto: 'Listo' })).statusCode, 201);
  let [t] = await bd`select no_leido_cliente, no_leido_admin, estado from contact_messages where id = ${TICKET}`;
  assert.equal(t.no_leido_cliente, true);
  assert.equal(t.no_leido_admin, false);
  assert.equal(t.estado, 'RESPONDIDO');

  await bd`update contact_messages set no_leido_cliente = false where id = ${TICKET}`;
  assert.equal((await pedir('POST', `/api/contact/${TICKET}/respuestas`, tk(CLIENTE), { texto: 'Gracias' })).statusCode, 201);
  [t] = await bd`select no_leido_cliente, no_leido_admin, estado from contact_messages where id = ${TICKET}`;
  assert.equal(t.no_leido_admin, true);
  assert.equal(t.no_leido_cliente, false, 'responder el cliente no le genera aviso a él mismo');
  assert.equal(t.estado, 'ABIERTO');
});

test('los avisos no leídos se filtran por quien pregunta', async () => {
  const otro = await usuario({ rol: 'CLIENTE' });
  await bd`update contact_messages set no_leido_cliente = true, no_leido_admin = false where id = ${TICKET}`;
  for (let i = 0; i < 2; i++) {
    const t = await ticket({ user_id: CLIENTE.id });
    await bd`update contact_messages set no_leido_cliente = true where id = ${t.id}`;
  }
  const ajeno = await ticket({ user_id: otro.id });
  await bd`update contact_messages set no_leido_cliente = true where id = ${ajeno.id}`;

  const c = await pedir('GET', '/api/contact/no-leidos', tk(CLIENTE));
  assert.equal(c.json().total, 3, 'solo los suyos');
  assert.ok(c.json().tickets.every((t: any) => t.id !== ajeno.id));

  // El admin ve los que tienen no_leido_admin (los nuevos lo traen en true), no TICKET.
  const a = await pedir('GET', '/api/contact/no-leidos', tk(ADMIN));
  assert.equal(a.json().total, 3);
  assert.ok(a.json().tickets.every((t: any) => t.id !== TICKET));
});

test('marcar visto solo apaga el aviso de quien lo ve, y un cliente solo el suyo', async () => {
  await bd`update contact_messages set no_leido_cliente = true, no_leido_admin = true where id = ${TICKET}`;
  const otro = await usuario({ rol: 'CLIENTE' });
  assert.equal((await pedir('PUT', `/api/contact/${TICKET}/visto`, tk(otro))).statusCode, 404, 'ticket ajeno');

  assert.equal((await pedir('PUT', `/api/contact/${TICKET}/visto`, tk(CLIENTE))).statusCode, 204);
  let [t] = await bd`select no_leido_cliente, no_leido_admin from contact_messages where id = ${TICKET}`;
  assert.deepEqual({ ...t }, { no_leido_cliente: false, no_leido_admin: true });

  assert.equal((await pedir('PUT', `/api/contact/${TICKET}/visto`, tk(ADMIN))).statusCode, 204);
  [t] = await bd`select no_leido_cliente, no_leido_admin from contact_messages where id = ${TICKET}`;
  assert.deepEqual({ ...t }, { no_leido_cliente: false, no_leido_admin: false });
});

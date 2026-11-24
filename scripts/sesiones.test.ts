// Sesiones revocables (varios dispositivos) y baja definitiva de cuentas, contra una
// base PostgreSQL real (skondit_test, ver scripts/pruebas/entorno.ts).
//   npm test
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { app, bd, iniciar, terminar, vaciar, usuario, beat, compra, ticket, token, pedir, CONTRASENA } from './pruebas/entorno';

before(iniciar);
after(terminar);
beforeEach(vaciar);

/** Inicia sesión como lo haría un dispositivo (admin: directo; cliente: con OTP). */
async function entrar(email: string, dispositivo: string): Promise<{ token: string; otras_sesiones: number }> {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/login', headers: { 'x-dispositivo': dispositivo },
    payload: { email, password: CONTRASENA },
  });
  assert.equal(res.statusCode, 200, res.body);
  let cuerpo = res.json();
  if (cuerpo.requires2fa) {
    const otp = await app.inject({
      method: 'POST', url: '/api/auth/verify-otp', headers: { 'x-dispositivo': dispositivo },
      payload: { email, code: cuerpo.otpDev },
    });
    assert.equal(otp.statusCode, 200, otp.body);
    cuerpo = otp.json();
  }
  return cuerpo;
}

test('cada inicio de sesión abre una sesión y avisa de las otras abiertas', async () => {
  const u = await usuario({ rol: 'CLIENTE' });
  const cel = await entrar(u.email, 'HUAWEI FRL-L23 · Android 10');
  assert.equal(cel.otras_sesiones, 0);
  const web = await entrar(u.email, 'Chrome · Windows');
  assert.equal(web.otras_sesiones, 1, 'el segundo dispositivo sabe que hay otra sesión abierta');

  const lista = await pedir('GET', '/api/sesiones', web.token);
  assert.equal(lista.statusCode, 200);
  const sesiones = lista.json().sesiones;
  assert.equal(sesiones.length, 2);
  assert.equal(sesiones[0].actual, true, 'la sesión actual va primero');
  assert.equal(sesiones[0].dispositivo, 'Chrome · Windows');
  assert.equal(sesiones[1].dispositivo, 'HUAWEI FRL-L23 · Android 10');
});

test('cerrar sesión invalida ese token de inmediato y no los demás', async () => {
  const u = await usuario({ rol: 'ADMIN' });
  const a = await entrar(u.email, 'Celular A');
  const b = await entrar(u.email, 'Celular B');

  assert.equal((await pedir('POST', '/api/auth/logout', a.token, {})).statusCode, 200);
  assert.equal((await pedir('GET', '/api/auth/me', a.token)).statusCode, 401, 'el token de A ya no sirve');
  assert.equal((await pedir('GET', '/api/auth/me', b.token)).statusCode, 200, 'B sigue dentro');
});

test('cerrar una sesión remota y "cerrar las demás"', async () => {
  const u = await usuario({ rol: 'ADMIN' });
  const a = await entrar(u.email, 'A');
  const b = await entrar(u.email, 'B');
  const c = await entrar(u.email, 'C');

  const idB = (await pedir('GET', '/api/sesiones', a.token)).json().sesiones.find((s: { dispositivo: string }) => s.dispositivo === 'B').id;
  assert.equal((await pedir('DELETE', `/api/sesiones/${idB}`, a.token)).statusCode, 204);
  assert.equal((await pedir('GET', '/api/auth/me', b.token)).statusCode, 401);

  const res = await pedir('POST', '/api/sesiones/cerrar-otras', a.token, {});
  assert.deepEqual(res.json(), { cerradas: 1 });
  assert.equal((await pedir('GET', '/api/auth/me', c.token)).statusCode, 401);
  assert.equal((await pedir('GET', '/api/auth/me', a.token)).statusCode, 200, 'la propia sigue abierta');
});

test('no se puede cerrar la sesión de otro usuario', async () => {
  const u1 = await usuario({ rol: 'ADMIN' });
  const u2 = await usuario({ rol: 'ADMIN' });
  const s1 = await entrar(u1.email, 'uno');
  const s2 = await entrar(u2.email, 'dos');
  const id2 = (await pedir('GET', '/api/sesiones', s2.token)).json().sesiones[0].id;
  assert.equal((await pedir('DELETE', `/api/sesiones/${id2}`, s1.token)).statusCode, 404);
  assert.equal((await pedir('DELETE', '/api/sesiones/no-es-uuid', s1.token)).statusCode, 404);
  assert.equal((await pedir('GET', '/api/auth/me', s2.token)).statusCode, 200);
});

test('cambiar la contraseña cierra las demás sesiones; desactivar cierra todas', async () => {
  const u = await usuario({ rol: 'CLIENTE' });
  const a = await entrar(u.email, 'A');
  const b = await entrar(u.email, 'B');
  const r = await pedir('PUT', '/api/profile/password', a.token, { password_actual: CONTRASENA, password_nueva: 'Otra-Clave-123!' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().sesiones_cerradas, 1);
  assert.equal((await pedir('GET', '/api/auth/me', b.token)).statusCode, 401);
  assert.equal((await pedir('GET', '/api/auth/me', a.token)).statusCode, 200);

  const admin = await usuario({ rol: 'ADMIN' });
  assert.equal((await pedir('PUT', `/api/users/${u.id}`, token(admin), { activo: false })).statusCode, 200);
  const [{ n }] = await bd`select count(*) as n from sesiones where user_id = ${u.id} and revocada_at is null`;
  assert.equal(n, 0);
});

test('un token sin jti (emitido antes de las sesiones) sigue valiendo hasta caducar', async () => {
  const u = await usuario({ rol: 'CLIENTE' });
  assert.equal((await pedir('GET', '/api/auth/me', token(u))).statusCode, 200);
  assert.equal((await pedir('GET', '/api/sesiones', token(u))).json().sesiones.length, 0);
});

test('baja definitiva sin compras: la cuenta se borra', async () => {
  const admin = await usuario({ rol: 'ADMIN' });
  const u = await usuario({ rol: 'CLIENTE', email: 'borrar@prueba.test' });
  const s = await entrar(u.email, 'cel');
  const t = await ticket({ user_id: u.id, email: u.email, nombre: u.nombre });

  const res = await pedir('DELETE', `/api/users/${u.id}`, token(admin));
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { modo: 'borrada' });
  assert.equal((await bd`select count(*) as n from users where id = ${u.id}`)[0].n, 0);
  assert.equal((await pedir('GET', '/api/auth/me', s.token)).statusCode, 401);
  const [tk] = await bd`select user_id, email, nombre from contact_messages where id = ${t.id}`;
  assert.deepEqual({ ...tk }, { user_id: null, email: 'eliminado@skondit.invalid', nombre: 'Cuenta eliminada' });
});

test('baja definitiva con compras: se anonimiza, desaparece del gestor y no puede entrar', async () => {
  const admin = await usuario({ rol: 'ADMIN' });
  const u = await usuario({ rol: 'CLIENTE', email: 'compro@prueba.test', nombre: 'Luis Compra' });
  const b = await beat();
  await compra(u.id, [b.id]);

  const res = await pedir('DELETE', `/api/users/${u.id}`, token(admin));
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { modo: 'anonimizada' });

  const [fila] = await bd`select email, nombre, telefono, activo, eliminado_at from users where id = ${u.id}`;
  assert.equal(fila.nombre, 'Cuenta eliminada');
  assert.match(fila.email, /@skondit\.invalid$/);
  assert.equal(fila.activo, false);
  assert.ok(fila.eliminado_at);
  assert.equal((await bd`select count(*) as n from orders where user_id = ${u.id}`)[0].n, 1, 'la venta se conserva');

  const lista = (await pedir('GET', '/api/users', token(admin))).json().users;
  assert.ok(!lista.some((x: { id: string }) => x.id === u.id));
  assert.equal((await pedir('GET', `/api/users/${u.id}`, token(admin))).statusCode, 404);
  assert.equal((await pedir('POST', '/api/auth/login', undefined, { email: 'compro@prueba.test', password: CONTRASENA })).statusCode, 401);
  assert.equal((await pedir('DELETE', `/api/users/${u.id}`, token(admin))).statusCode, 404, 'no se elimina dos veces');
});

test('baja definitiva: reglas de permisos', async () => {
  const admin = await usuario({ rol: 'ADMIN' });
  const otroAdmin = await usuario({ rol: 'ADMIN' });
  const superA = await usuario({ rol: 'SUPER_ADMIN' });
  const cliente = await usuario({ rol: 'CLIENTE' });

  assert.equal((await pedir('DELETE', `/api/users/${admin.id}`, token(cliente))).statusCode, 403, 'un cliente no');
  assert.equal((await pedir('DELETE', `/api/users/${otroAdmin.id}`, token(admin))).statusCode, 403, 'un admin no borra admins');
  assert.equal((await pedir('DELETE', `/api/users/${admin.id}`, token(admin))).statusCode, 400, 'ni a sí mismo');
  assert.equal((await pedir('DELETE', `/api/users/no-es-uuid`, token(admin))).statusCode, 404);
  assert.equal((await pedir('DELETE', `/api/users/${otroAdmin.id}`, token(superA))).statusCode, 200, 'el super sí');

  const otroSuper = await usuario({ rol: 'SUPER_ADMIN' });
  assert.equal((await pedir('DELETE', `/api/users/${otroSuper.id}`, token(superA))).statusCode, 200);
});

test('un DELETE con Content-Type JSON y sin cuerpo funciona (antes 400 FST_ERR_CTP_EMPTY_JSON_BODY)', async () => {
  const u = await usuario({ rol: 'ADMIN' });
  const a = await entrar(u.email, 'A');
  const b = await entrar(u.email, 'B');
  const idB = (await pedir('GET', '/api/sesiones', a.token)).json().sesiones.find((s: { dispositivo: string }) => s.dispositivo === 'B').id;
  const res = await app.inject({
    method: 'DELETE', url: `/api/sesiones/${idB}`,
    headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
  });
  assert.equal(res.statusCode, 204, res.body);
  assert.equal((await pedir('GET', '/api/auth/me', b.token)).statusCode, 401);

  const malo = await app.inject({
    method: 'POST', url: '/api/sesiones/cerrar-otras', payload: '{no es json',
    headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
  });
  assert.equal(malo.statusCode, 400, 'un JSON mal formado sigue respondiendo 400');
});

// Gestión de paquetes desde el panel (app móvil y web), contra PostgreSQL real.
//   npm test
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bd, iniciar, terminar, vaciar, usuario, beat, token, pedir } from './pruebas/entorno';

before(iniciar);
after(terminar);
beforeEach(vaciar);

test('alta, edición y baja de un paquete', async () => {
  const admin = token(await usuario({ rol: 'ADMIN' }));
  const [b1, b2, b3] = [await beat({ nombre: 'Uno' }), await beat({ nombre: 'Dos' }), await beat({ nombre: 'Tres' })];

  const alta = await pedir('POST', '/api/packs', admin, { nombre: 'Trap pack', precio: 500, beat_ids: [b1.id, b2.id] });
  assert.equal(alta.statusCode, 201, alta.body);
  const id = alta.json().pack.id;

  const edit = await pedir('PUT', `/api/packs/${id}`, admin, { nombre: 'Trap pack 2', precio: 650, descripcion: 'Tres beats', beat_ids: [b1.id, b2.id, b3.id] });
  assert.equal(edit.statusCode, 200, edit.body);
  const pack = (await pedir('GET', `/api/packs/${id}`)).json().pack;
  assert.equal(pack.nombre, 'Trap pack 2');
  assert.equal(pack.pack_beats.length, 3);

  assert.equal((await pedir('DELETE', `/api/packs/${id}`, admin)).statusCode, 204);
  assert.equal((await pedir('GET', '/api/packs')).json().packs.length, 0, 'ya no se muestra en la tienda');
});

test('un reintento con la misma Idempotency-Key no duplica el paquete', async () => {
  const admin = token(await usuario({ rol: 'ADMIN' }));
  const b = await beat();
  const clave = randomUUID();
  const cuerpo = { nombre: 'Pack', precio: 300, beat_ids: [b.id] };
  const r1 = await pedir('POST', '/api/packs', admin, cuerpo, clave);
  const r2 = await pedir('POST', '/api/packs', admin, cuerpo, clave);
  assert.equal(r1.statusCode, 201);
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.json().pack.id, r1.json().pack.id);
  assert.equal((await bd`select count(*) as n from packs`)[0].n, 1);
});

test('datos inválidos se rechazan con 400 y nada llega a la base', async () => {
  const admin = token(await usuario({ rol: 'ADMIN' }));
  const b = await beat();
  for (const cuerpo of [
    { nombre: 'P', precio: 100, beat_ids: [b.id] },
    { nombre: 'Pack', precio: -5, beat_ids: [b.id] },
    { nombre: 'Pack', precio: 100, beat_ids: [] },
    { nombre: 'Pack', precio: 100, beat_ids: ['no-es-uuid'] },
    { nombre: 'Pack', precio: 100, beat_ids: [b.id, b.id] },
    { nombre: 'Pack', precio: 100, beat_ids: [randomUUID()] },
  ]) {
    const r = await pedir('POST', '/api/packs', admin, cuerpo);
    assert.equal(r.statusCode, 400, JSON.stringify(cuerpo) + ' ' + r.body);
  }
  assert.equal((await bd`select count(*) as n from packs`)[0].n, 0);
});

test('solo un administrador gestiona paquetes', async () => {
  const cliente = token(await usuario({ rol: 'CLIENTE' }));
  const b = await beat();
  assert.equal((await pedir('POST', '/api/packs', cliente, { nombre: 'Pack', precio: 1, beat_ids: [b.id] })).statusCode, 403);
  assert.equal((await pedir('POST', '/api/packs', undefined, { nombre: 'Pack', precio: 1, beat_ids: [b.id] })).statusCode, 401);
});

// Rutas del proyecto Skondit (phone_app y smart_tv_pwa) contra una base PostgreSQL
// real (skondit_test, ver scripts/pruebas/entorno.ts).
//   npm test
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { bd, iniciar, terminar, vaciar, usuario, beat, compra, app } from './pruebas/entorno';

const CLAVE = 'clave-de-dispositivo-de-prueba';
process.env['SKONDIT_DEVICE_KEY'] = CLAVE;

before(iniciar);
after(terminar);
beforeEach(vaciar);

const pedir = (method: 'GET' | 'PUT', url: string, payload?: object, clave: string | null = CLAVE) =>
  app.inject({ method, url, headers: clave === null ? {} : { 'x-skondit-key': clave }, ...(payload ? { payload } : {}) });

test('sin clave de dispositivo, o con una incorrecta, → 401', async () => {
  for (const clave of [null, '', 'otra', `${CLAVE}x`]) {
    assert.equal((await pedir('GET', '/api/skondit/now-playing', undefined, clave)).statusCode, 401, String(clave));
  }
  assert.equal((await pedir('PUT', '/api/skondit/now-playing', { position_sec: 0, duration_sec: 0, playing: false }, 'otra')).statusCode, 401);
  assert.equal(await bd`select count(*)::int as n from now_playing`.then(r => r[0].n), 0);
});

test('la biblioteca trae los beats comprados (órdenes completadas), sin repetir', async () => {
  const yo = await usuario();
  const otro = await usuario();
  const [a, b, c, d] = await Promise.all(['A', 'B', 'C', 'D'].map(n => beat({ nombre: n })));
  await compra(yo.id, [a.id, b.id]);
  const paquete = await compra(yo.id, [c.id]);
  await bd`update orders set status = 'CANCELADO' where id = ${paquete.id}`;   // no cuenta
  await compra(otro.id, [d.id]);                                               // ajena

  const r = await pedir('GET', `/api/skondit/biblioteca/${yo.id}`);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().beats.map((x: any) => x.nombre).sort(), ['A', 'B']);
  assert.deepEqual(Object.keys(r.json().beats[0]).sort(), ['audio_url', 'bpm', 'genero', 'id', 'imagen_url', 'nombre', 'precio']);

  assert.deepEqual((await pedir('GET', '/api/skondit/biblioteca/no-es-uuid')).json().beats, []);
});

test('now-playing: el teléfono publica y la TV lee el mismo renglón', async () => {
  assert.equal((await pedir('GET', '/api/skondit/now-playing')).json().nowPlaying, null);
  const datos = { beat_id: 'b1', beat_name: 'Night City', genre: 'Trap', bpm: 140, position_sec: 12, duration_sec: 180, playing: true };
  assert.equal((await pedir('PUT', '/api/skondit/now-playing', datos)).statusCode, 200);
  assert.equal((await pedir('PUT', '/api/skondit/now-playing', { ...datos, position_sec: 15 })).statusCode, 200);

  const r = await pedir('GET', '/api/skondit/now-playing');
  assert.equal(r.json().nowPlaying.position_sec, 15);
  assert.equal(r.json().nowPlaying.target, 'app');
  assert.equal(await bd`select count(*)::int as n from now_playing`.then(r => r[0].n), 1, 'siempre un solo renglón');
});

test('now-playing rechaza datos fuera de rango e ignora campos extra', async () => {
  const base = { position_sec: 0, duration_sec: 10, playing: false };
  for (const malo of [{ ...base, position_sec: -1 }, { ...base, bpm: 999 }, { ...base, target: 'radio' }, {}]) {
    assert.equal((await pedir('PUT', '/api/skondit/now-playing', malo)).statusCode, 400, JSON.stringify(malo));
  }
  // Fastify quita los campos que no están en el esquema (removeAdditional): un id
  // distinto no puede crear otro renglón.
  assert.equal((await pedir('PUT', '/api/skondit/now-playing', { ...base, id: 2 })).statusCode, 200);
  assert.deepEqual((await bd`select id from now_playing`).map(r => r.id), [1]);
});

test('CORS: /api/skondit acepta cualquier origen sin credenciales; el resto sigue limitado', async () => {
  const preflight = (url: string, origin: string) => app.inject({
    method: 'OPTIONS', url,
    headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-skondit-key' },
  });
  const tv = await preflight('/api/skondit/now-playing', 'http://localhost:8080');
  assert.equal(tv.headers['access-control-allow-origin'], 'http://localhost:8080');
  assert.equal(tv.headers['access-control-allow-credentials'], undefined);

  const web = await preflight('/api/users', 'http://localhost:4200');   // origen permitido (ALLOWED_ORIGINS)
  assert.equal(web.headers['access-control-allow-origin'], 'http://localhost:4200');
  assert.equal(web.headers['access-control-allow-credentials'], 'true');

  const ajeno = await preflight('/api/users', 'https://sitio-ajeno.example');
  assert.equal(ajeno.headers['access-control-allow-origin'], undefined);
});

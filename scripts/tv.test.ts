// Smart TV vinculada a una cuenta (smart_tv_pwa + app móvil), contra una base
// PostgreSQL real (skondit_test, ver scripts/pruebas/entorno.ts).
//   npm test
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { app, bd, iniciar, terminar, vaciar, usuario, beat, compra, token, pedir } from './pruebas/entorno';

before(iniciar);
after(terminar);
beforeEach(vaciar);

const tv = (method: 'GET' | 'POST' | 'DELETE', url: string, tokenTv: string | null, payload?: object) =>
  app.inject({ method, url, headers: tokenTv === null ? {} : { 'x-tv-token': tokenTv }, ...(payload ? { payload } : {}) });

async function nuevaTv(nombre?: string) {
  const r = await app.inject({ method: 'POST', url: '/api/tv/emparejar', ...(nombre ? { payload: { nombre } } : {}) });
  assert.equal(r.statusCode, 201, r.body);
  return r.json() as { id: string; token: string; codigo: string; codigo_expira_at: string };
}

async function cuentaConTv() {
  const yo = await usuario();
  const tk = token(yo);
  const t = await nuevaTv('Sala');
  assert.equal((await pedir('POST', '/api/tv/vincular', tk, { codigo: t.codigo })).statusCode, 200);
  return { yo, tk, t };
}

test('emparejar: la TV recibe un token y un código de 6 dígitos; en la base solo queda el hash', async () => {
  const t = await nuevaTv();
  assert.match(t.codigo, /^[0-9]{6}$/);
  assert.ok(t.token.length >= 40);
  const [fila] = await bd`select token_hash, nombre, user_id from tv_dispositivos where id = ${t.id}`;
  assert.notEqual(fila.token_hash, t.token);
  assert.equal(fila.token_hash.length, 64, 'SHA-256 en hexadecimal');
  assert.equal(fila.nombre, 'Smart TV');
  assert.equal(fila.user_id, null);

  const estado = await tv('GET', '/api/tv/estado', t.token);
  assert.equal(estado.statusCode, 200);
  assert.equal(estado.json().vinculado, false);
  assert.equal(estado.json().codigo, t.codigo);
});

test('sin token de TV, o con uno inventado, → 401; sin vincular, la biblioteca → 409', async () => {
  for (const malo of [null, '', 'corto', 'x'.repeat(43)]) {
    assert.equal((await tv('GET', '/api/tv/estado', malo)).statusCode, 401, String(malo));
  }
  const t = await nuevaTv();
  assert.equal((await tv('GET', '/api/tv/biblioteca', t.token)).statusCode, 409);
  assert.equal((await tv('GET', '/api/tv/reproduccion', t.token)).statusCode, 409);
});

test('vincular: el teléfono con sesión liga la TV; la TV ve el nombre y la biblioteca de esa cuenta', async () => {
  const yo = await usuario({ nombre: 'Orlando' });
  const otro = await usuario();
  const [a, b, c] = await Promise.all(['A', 'B', 'C'].map(n => beat({ nombre: n })));
  await compra(yo.id, [a.id, b.id]);
  await compra(otro.id, [c.id]);
  const t = await nuevaTv('Sala');

  assert.equal((await pedir('POST', '/api/tv/vincular', undefined, { codigo: t.codigo })).statusCode, 401, 'sin sesión');
  const r = await pedir('POST', '/api/tv/vincular', token(yo), { codigo: t.codigo });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().tv.nombre, 'Sala');

  const estado = (await tv('GET', '/api/tv/estado', t.token)).json();
  assert.equal(estado.vinculado, true);
  assert.equal(estado.usuario, 'Orlando');
  assert.equal(estado.codigo, null, 'el código ya no se muestra');

  const lib = await tv('GET', '/api/tv/biblioteca', t.token);
  assert.deepEqual(lib.json().beats.map((x: any) => x.nombre).sort(), ['A', 'B'], 'solo lo comprado por esa cuenta');

  // El código ya se usó: otra cuenta no puede robarse la TV.
  assert.equal((await pedir('POST', '/api/tv/vincular', token(otro), { codigo: t.codigo })).statusCode, 404);
  const [audit] = await bd`select accion from bitacora where user_id = ${yo.id}`;
  assert.equal(audit.accion, 'TV_VINCULADA');
});

test('vincular rechaza códigos mal formados, vencidos y frena la fuerza bruta (429)', async () => {
  const yo = await usuario();
  const tk = token(yo);
  for (const malo of ['12345', '1234567', 'abcdef', '']) {
    assert.equal((await pedir('POST', '/api/tv/vincular', tk, { codigo: malo })).statusCode, 400, malo);
  }
  const t = await nuevaTv();
  await bd`update tv_dispositivos set codigo_expira_at = now() - interval '1 second' where id = ${t.id}`;
  assert.equal((await pedir('POST', '/api/tv/vincular', tk, { codigo: t.codigo })).statusCode, 404, 'vencido');

  // La TV renueva su código con el mismo token.
  const renovado = await tv('POST', '/api/tv/codigo', t.token);
  assert.equal(renovado.statusCode, 200);
  const codigoNuevo = renovado.json().codigo as string;

  // 5 intentos fallidos (incluido el vencido) y el sexto se bloquea aunque sea correcto.
  for (let i = 0; i < 4; i++) {
    const otro = codigoNuevo === '000000' ? '000001' : '000000';
    assert.equal((await pedir('POST', '/api/tv/vincular', tk, { codigo: otro })).statusCode, 404);
  }
  assert.equal((await pedir('POST', '/api/tv/vincular', tk, { codigo: codigoNuevo })).statusCode, 429);
});

test('control: el teléfono ordena, la TV lo lee con los datos del beat y reporta su posición', async () => {
  const { tk, t } = await cuentaConTv();
  const b = await beat({ nombre: 'Night City', bpm: 140 });

  const orden = await pedir('PUT', '/api/tv/control', tk,
    { beat_id: b.id, position_sec: 10, duration_sec: 180, playing: true, destino: 'tv', volumen: 70 });
  assert.equal(orden.statusCode, 200, orden.body);
  const c1 = orden.json().reproduccion.comando;

  const leida = (await tv('GET', '/api/tv/reproduccion', t.token)).json().reproduccion;
  assert.equal(leida.beat_nombre, 'Night City');
  assert.equal(leida.bpm, 140);
  assert.equal(leida.destino, 'tv');
  assert.equal(leida.volumen, 70);

  assert.equal((await tv('POST', '/api/tv/reproduccion/reporte', t.token, { position_sec: 25, playing: true })).statusCode, 204);
  const vista = (await pedir('GET', '/api/tv/control', tk)).json().reproduccion;
  assert.equal(vista.tv_position_sec, 25);
  assert.equal(vista.comando, c1, 'el reporte de la TV no cuenta como orden');

  // Pausa sin mandar volumen: se conserva el anterior y el comando sube.
  const pausa = (await pedir('PUT', '/api/tv/control', tk,
    { beat_id: b.id, position_sec: 25, duration_sec: 180, playing: false, destino: 'tv' })).json().reproduccion;
  assert.equal(pausa.volumen, 70);
  assert.equal(pausa.comando, c1 + 1);
});

test('control valida el cuerpo y el beat', async () => {
  const { tk } = await cuentaConTv();
  const base = { position_sec: 0, duration_sec: 10, playing: false, destino: 'tv' };
  for (const malo of [{ ...base, destino: 'radio' }, { ...base, volumen: 101 }, { ...base, position_sec: -1 },
    { ...base, beat_id: 'no-uuid' }, { ...base, extra: 1, beat_id: 5 }]) {
    assert.equal((await pedir('PUT', '/api/tv/control', tk, malo)).statusCode, 400, JSON.stringify(malo));
  }
  const fantasma = '00000000-0000-4000-8000-000000000000';
  assert.equal((await pedir('PUT', '/api/tv/control', tk, { ...base, beat_id: fantasma })).statusCode, 404);
});

test('cada cuenta tiene su propia reproducción: una TV no ve lo de otra cuenta', async () => {
  const uno = await cuentaConTv();
  const dos = await cuentaConTv();
  const [a, b] = await Promise.all([beat({ nombre: 'Uno' }), beat({ nombre: 'Dos' })]);
  await pedir('PUT', '/api/tv/control', uno.tk, { beat_id: a.id, position_sec: 0, duration_sec: 9, playing: true, destino: 'tv' });
  await pedir('PUT', '/api/tv/control', dos.tk, { beat_id: b.id, position_sec: 0, duration_sec: 9, playing: true, destino: 'tv' });
  assert.equal((await tv('GET', '/api/tv/reproduccion', uno.t.token)).json().reproduccion.beat_nombre, 'Uno');
  assert.equal((await tv('GET', '/api/tv/reproduccion', dos.t.token)).json().reproduccion.beat_nombre, 'Dos');
});

test('mias y desvincular: la lista marca si la TV está en línea; al revocarla, su token deja de servir', async () => {
  const { yo, tk, t } = await cuentaConTv();
  const otro = await usuario();
  await tv('GET', '/api/tv/estado', t.token);   // la TV consulta (anota su último contacto)

  const lista = (await pedir('GET', '/api/tv/mias', tk)).json().tvs;
  assert.equal(lista.length, 1);
  assert.equal(lista[0].en_linea, true, 'acaba de consultar');
  await bd`update tv_dispositivos set ultimo_contacto = now() - interval '1 minute'`;
  assert.equal((await pedir('GET', '/api/tv/mias', tk)).json().tvs[0].en_linea, false);

  assert.equal((await pedir('DELETE', `/api/tv/${t.id}`, token(otro))).statusCode, 404, 'TV ajena');
  assert.equal((await pedir('DELETE', '/api/tv/no-uuid', tk)).statusCode, 404);
  assert.equal((await pedir('DELETE', `/api/tv/${t.id}`, tk)).statusCode, 204);
  assert.equal((await tv('GET', '/api/tv/estado', t.token)).statusCode, 401, 'token revocado');
  assert.equal((await pedir('GET', '/api/tv/mias', tk)).json().tvs.length, 0);
  const acciones = (await bd`select accion from bitacora where user_id = ${yo.id} order by created_at`).map(r => r.accion);
  assert.deepEqual(acciones, ['TV_VINCULADA', 'TV_DESVINCULADA']);
});

test('la TV se desvincula sola (DELETE /api/tv/yo): su token deja de servir y la app ya no la lista', async () => {
  const { yo, tk, t } = await cuentaConTv();
  assert.equal((await tv('DELETE', '/api/tv/yo', null)).statusCode, 401);
  assert.equal((await tv('DELETE', '/api/tv/yo', t.token)).statusCode, 204);
  assert.equal((await tv('GET', '/api/tv/estado', t.token)).statusCode, 401);
  assert.equal((await pedir('GET', '/api/tv/mias', tk)).json().tvs.length, 0);
  const [audit] = await bd`select accion from bitacora where user_id = ${yo.id} order by created_at desc limit 1`;
  assert.equal(audit.accion, 'TV_DESVINCULADA');
});

test('CORS: /api/tv acepta cualquier origen sin credenciales y deja pasar X-Tv-Token', async () => {
  const r = await app.inject({
    method: 'OPTIONS', url: '/api/tv/estado',
    headers: { origin: 'http://localhost:8080', 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-tv-token' },
  });
  assert.equal(r.headers['access-control-allow-origin'], 'http://localhost:8080');
  assert.equal(r.headers['access-control-allow-credentials'], undefined);
  assert.match(String(r.headers['access-control-allow-headers']), /X-Tv-Token/i);
});

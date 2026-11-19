// Pruebas de caja blanca de tickets, idempotencia y catálogo (Práctica 12), contra una
// base PostgreSQL real (skondit_test, ver scripts/pruebas/entorno.ts): se revisa la
// respuesta HTTP y lo que quedó guardado.
//   npm test
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { bd, iniciar, terminar, vaciar, usuario, ticket, beat, token, pedir } from './pruebas/entorno';

const CLAVE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

type U = Awaited<ReturnType<typeof usuario>>;
let CLIENTE: U, OTRO: U, ADMIN: U;
let TICKET: string;

before(iniciar);
after(terminar);

beforeEach(async () => {
  await vaciar();
  CLIENTE = await usuario({ rol: 'CLIENTE' });
  OTRO = await usuario({ rol: 'CLIENTE' });
  ADMIN = await usuario({ rol: 'ADMIN' });
  TICKET = (await ticket({ user_id: CLIENTE.id })).id;
});

const contar = async (tabla: string) => (await bd.unsafe(`select count(*)::int as n from ${tabla}`))[0].n as number;

// ── Tickets ──────────────────────────────────────────────────────────────────

test('un reporte de error abre un ticket de prioridad alta y devuelve su folio', async () => {
  const res = await pedir('POST', '/api/contact', token(CLIENTE), {
    nombre: 'Ana', email: 'ana@b.c', mensaje: 'El beat no suena al comprarlo', tipo: 'ERROR', asunto: '  No suena  ',
  }, CLAVE);
  assert.equal(res.statusCode, 201);
  const { id, folio } = res.json().ticket;
  assert.ok(Number.isInteger(folio) && folio > 0, 'folio numérico de la secuencia');
  const [t] = await bd`select prioridad, asunto, client_ref, user_id, tipo from contact_messages where id = ${id}`;
  assert.equal(t.prioridad, 'ALTA');
  assert.equal(t.asunto, 'No suena');
  assert.equal(t.client_ref, CLAVE);
  assert.equal(t.user_id, CLIENTE.id);
  assert.equal(t.tipo, 'ERROR');
});

test('reintentar el mismo ticket no lo duplica: responde el original', async () => {
  const cuerpo = { nombre: 'Ana', email: 'ana@b.c', mensaje: 'Mensaje que se reintenta' };
  const primero = await pedir('POST', '/api/contact', undefined, cuerpo, CLAVE);
  const reintento = await pedir('POST', '/api/contact', undefined, cuerpo, CLAVE);
  assert.equal(primero.statusCode, 201);
  assert.equal(reintento.statusCode, 200);
  assert.equal(reintento.json().repetida, true);
  assert.equal(reintento.json().ticket.folio, primero.json().ticket.folio);
  assert.equal(await contar(`contact_messages where client_ref = '${CLAVE}'`), 1);
});

test('una clave de idempotencia mal formada se ignora en vez de guardarse', async () => {
  const r = await pedir('POST', '/api/contact', undefined, { nombre: 'Ana', email: 'ana@b.c', mensaje: 'Mensaje de prueba' }, "x'; drop table users; --");
  assert.equal(r.statusCode, 201);
  const [t] = await bd`select client_ref from contact_messages where id = ${r.json().ticket.id}`;
  assert.equal(t.client_ref, null);
  assert.ok((await contar('users')) > 0, 'la tabla sigue ahí');
});

test('la bandeja paginada trae solo una página, filtra en la base y solo cuenta respuestas', async () => {
  for (let i = 0; i < 45; i++) await bd`insert into contact_messages (nombre, email, mensaje, tipo, estado) values ('C', 'c@b.c', 'Mensaje de prueba', ${i % 3 ? 'MENSAJE' : 'ERROR'}, 'ABIERTO')`;
  const errores = await contar(`contact_messages where tipo = 'ERROR' and estado = 'ABIERTO'`);
  const res = await pedir('GET', '/api/contact?limit=5&page=2&estado=ABIERTO&tipo=ERROR', token(ADMIN));
  assert.equal(res.statusCode, 200);
  const cuerpo = res.json();
  assert.deepEqual([cuerpo.total, cuerpo.page, cuerpo.limit], [errores, 2, 5]);
  assert.equal(cuerpo.messages.length, 5);
  assert.ok(cuerpo.messages.every((m: any) => m.tipo === 'ERROR' && m.estado === 'ABIERTO'));
  // Solo el conteo de respuestas, sin su texto: contact_replies: [{ count }]
  assert.deepEqual(cuerpo.messages[0].contact_replies, [{ count: 0 }]);
});

test('sin limit la bandeja responde como antes (todo, con las respuestas), para la web', async () => {
  await bd`insert into contact_replies (message_id, autor_nombre, es_admin, texto) values (${TICKET}, 'Admin', true, 'Hola')`;
  const res = await pedir('GET', '/api/contact', token(ADMIN));
  assert.equal(res.json().page, undefined);
  const t = res.json().messages.find((m: any) => m.id === TICKET);
  assert.equal(t.contact_replies[0].texto, 'Hola');
  assert.equal(t.contact_replies[0].autor_nombre, 'Admin');
});

test('el cliente solo ve sus tickets y no puede filtrar por admin asignado', async () => {
  const ajeno = await ticket({ user_id: OTRO.id });
  await bd`update contact_messages set asignado_a = ${ADMIN.id} where id = ${ajeno.id}`;
  const res = await pedir('GET', `/api/contact/mios?limit=10&asignado=${ADMIN.id}`, token(CLIENTE));
  const ids = res.json().messages.map((m: any) => m.id);
  assert.deepEqual(ids, [TICKET], 'el filtro asignado se ignora y nunca ve tickets ajenos');
});

test('el detalle de un ticket ajeno se responde como inexistente', async () => {
  const url = `/api/contact/${TICKET}`;
  assert.equal((await pedir('GET', url, token(OTRO))).statusCode, 404);
  assert.equal((await pedir('GET', url, token(CLIENTE))).statusCode, 200);
  assert.equal((await pedir('GET', url, token(ADMIN))).statusCode, 200);
  assert.equal((await pedir('GET', url)).statusCode, 401);
  assert.equal((await pedir('GET', '/api/contact/no-es-uuid', token(ADMIN))).statusCode, 404);
});

test('el cliente puede cerrar su ticket pero no ponerlo en proceso', async () => {
  const url = `/api/contact/${TICKET}/estado`;
  const tk = token(CLIENTE);
  assert.equal((await pedir('PUT', url, tk, { estado: 'EN_PROCESO' })).statusCode, 403);
  assert.equal((await bd`select estado from contact_messages where id = ${TICKET}`)[0].estado, 'ABIERTO');
  assert.equal((await pedir('PUT', url, tk, { estado: 'CERRADO' })).statusCode, 200);
  const [t] = await bd`select estado, cerrado_at from contact_messages where id = ${TICKET}`;
  assert.equal(t.estado, 'CERRADO');
  assert.ok(t.cerrado_at);
  assert.equal((await pedir('PUT', url, token(OTRO), { estado: 'CERRADO' })).statusCode, 404);
  assert.equal((await pedir('PUT', url, tk, { estado: 'INVENTADO' })).statusCode, 400);
});

test('dos admins mueven el mismo ticket: el segundo recibe 409 y no pisa el cambio', async () => {
  // Otro admin ya lo pasó a EN_PROCESO; este todavía veía ABIERTO.
  await bd`update contact_messages set estado = 'EN_PROCESO' where id = ${TICKET}`;
  const res = await pedir('PUT', `/api/contact/${TICKET}/estado`, token(ADMIN), { estado: 'RESUELTO', esperado: 'ABIERTO' });
  assert.equal(res.statusCode, 409);
  assert.equal((await bd`select estado from contact_messages where id = ${TICKET}`)[0].estado, 'EN_PROCESO');
  assert.equal(await contar('bitacora'), 0, 'un cambio que no se aplicó no va a la bitácora');

  const bien = await pedir('PUT', `/api/contact/${TICKET}/estado`, token(ADMIN), { estado: 'RESUELTO', esperado: 'EN_PROCESO' });
  assert.equal(bien.statusCode, 200);
  assert.equal(await contar(`bitacora where accion = 'ESTADO_TICKET'`), 1);
});

test('no se puede responder un ticket cerrado', async () => {
  await bd`update contact_messages set estado = 'CERRADO' where id = ${TICKET}`;
  const res = await pedir('POST', `/api/contact/${TICKET}/respuestas`, token(CLIENTE), { texto: 'Sigue fallando' });
  assert.equal(res.statusCode, 409);
  assert.equal(await contar('contact_replies'), 0);
});

test('reintentar una respuesta no la duplica ni reenvía el correo', async () => {
  const url = `/api/contact/${TICKET}/respuestas`;
  const primera = await pedir('POST', url, token(ADMIN), { texto: 'Ya quedó' }, CLAVE);
  await bd`update contact_messages set estado = 'EN_PROCESO' where id = ${TICKET}`;
  const reintento = await pedir('POST', url, token(ADMIN), { texto: 'Ya quedó' }, CLAVE);
  assert.equal(primera.statusCode, 201);
  assert.equal(reintento.statusCode, 200);
  assert.equal(reintento.json().repetida, true);
  assert.equal(reintento.json().correoEnviado, false);
  assert.equal(await contar('contact_replies'), 1);
  // La transacción del reintento se deshizo: el estado no volvió a RESPONDIDO.
  assert.equal((await bd`select estado from contact_messages where id = ${TICKET}`)[0].estado, 'EN_PROCESO');
});

test('solo un admin cambia la prioridad', async () => {
  const url = `/api/contact/${TICKET}/prioridad`;
  assert.equal((await pedir('PUT', url, token(CLIENTE), { prioridad: 'ALTA' })).statusCode, 403);
  assert.equal((await pedir('PUT', url, token(ADMIN), { prioridad: 'URGENTE' })).statusCode, 400);
  assert.equal((await pedir('PUT', url, token(ADMIN), { prioridad: 'BAJA' })).statusCode, 200);
  assert.equal((await bd`select prioridad from contact_messages where id = ${TICKET}`)[0].prioridad, 'BAJA');
});

// ── Catálogo ─────────────────────────────────────────────────────────────────

test('la tienda paginada usa la caché del resumen y la búsqueda no altera el filtro', async () => {
  for (const [nombre, genero] of [['Dark One', 'Trap'], ['Dark, (x) Two', 'Rap']]) await beat({ nombre, genero });
  // El tercero se da de alta por la API: eso invalida la caché que hubiera de otras pruebas.
  const alta = await pedir('POST', '/api/beats', token(ADMIN), { nombre: 'Luz', genero: 'Trap', bpm: 90, precio: 100 });
  assert.equal(alta.statusCode, 201);

  const r1 = await pedir('GET', '/api/beats?limit=20&page=1&search=' + encodeURIComponent('dark, (x'));
  assert.deepEqual(r1.json().generos, ['Rap', 'Trap']);
  // Los caracteres especiales se buscan literalmente: solo coincide el que los contiene.
  assert.deepEqual(r1.json().beats.map((b: any) => b.nombre), ['Dark, (x) Two']);
  assert.equal(r1.json().total, 1);

  // Un género nuevo agregado por fuera: con la caché vigente todavía no aparece...
  await beat({ nombre: 'Nuevo', genero: 'Drill' });
  const r2 = await pedir('GET', '/api/beats?limit=20&page=1');
  assert.deepEqual(r2.json().generos, ['Rap', 'Trap'], 'con la caché vigente no se recalculan los géneros');
  assert.equal(r2.json().total, 4, 'el total de la página sí es el actual');
  // ...y en cuanto un admin edita el catálogo (aquí, borra un beat) se recalcula.
  const borrar = await pedir('DELETE', `/api/beats/${alta.json().beat.id}`, token(ADMIN));
  assert.equal(borrar.statusCode, 204);
  const r3 = await pedir('GET', '/api/beats?limit=20&page=1');
  assert.deepEqual(r3.json().generos, ['Drill', 'Rap', 'Trap']);
  assert.equal(r3.json().total, 3);
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

  const res = await pedir('POST', '/api/beats', token(ADMIN), { ...ok, bpm: 999 });
  assert.equal(res.statusCode, 422); // Práctica 11: valor fuera de rango = validación semántica
  assert.equal(await contar('beats'), 0);
  const sinCampos = await pedir('POST', '/api/beats', token(ADMIN), { nombre: 'Solo nombre' });
  assert.equal(sinCampos.statusCode, 400);

  const alta = await pedir('POST', '/api/beats', token(ADMIN), ok, CLAVE);
  assert.equal(alta.statusCode, 201);
  const repetida = await pedir('POST', '/api/beats', token(ADMIN), ok, CLAVE);
  assert.equal(repetida.statusCode, 200);
  assert.equal(repetida.json().beat.id, alta.json().beat.id);
  assert.equal(await contar('beats'), 1, 'el reintento del alta no duplica el beat');
});

test('ligar el audio de un beat no toca sus demás datos', async () => {
  const b = await beat({ nombre: 'Original', precio: 300 });
  await bd`update beats set imagen_url = 'https://x/portada.jpg' where id = ${b.id}`;
  const url = `/api/beats/${b.id}/media`;
  assert.equal((await pedir('PUT', url, token(CLIENTE), { audio_url: 'https://x/y.mp3' })).statusCode, 403);
  assert.equal((await pedir('PUT', url, token(ADMIN), {})).statusCode, 400);
  assert.equal((await pedir('PUT', url, token(ADMIN), { audio_url: 'https://x/y.mp3' })).statusCode, 200);
  const [fila] = await bd`select nombre, precio, imagen_url, audio_url from beats where id = ${b.id}`;
  assert.deepEqual({ ...fila }, { nombre: 'Original', precio: 300, imagen_url: 'https://x/portada.jpg', audio_url: 'https://x/y.mp3' });
  assert.equal((await pedir('PUT', '/api/beats/no-es-uuid/media', token(ADMIN), { audio_url: 'https://x/y.mp3' })).statusCode, 404);
});

test('la URL firmada incluye los datos para la subida reanudable', async () => {
  const res = await pedir('POST', '/api/uploads/presign', token(ADMIN), {
    bucket: 'beats-audio', contentType: 'audio/mpeg', fileName: 'mi beat.mp3',
  });
  assert.equal(res.statusCode, 200);
  const { resumable } = res.json();
  assert.equal(resumable.endpoint, 'http://supabase.invalid/storage/v1/upload/resumable/sign');
  assert.equal(resumable.bucket, 'beats-audio');
  assert.equal(resumable.token, 'tok');
});

// ── Pagos ────────────────────────────────────────────────────────────────────

test('reintentar un pago con la misma clave devuelve la orden original sin cobrar otra vez', async () => {
  const b = await beat({ precio: 299 });
  const primero = await pedir('POST', '/api/orders', token(CLIENTE), { beats: [b.id] }, CLAVE);
  const reintento = await pedir('POST', '/api/orders', token(CLIENTE), { beats: [b.id] }, CLAVE);
  assert.equal(primero.statusCode, 201);
  assert.equal(reintento.statusCode, 200);
  assert.equal(reintento.json().repetida, true);
  assert.equal(reintento.json().order.id, primero.json().order.id);
  assert.equal(await contar('orders'), 1);
  assert.equal(await contar('order_items'), 1);
});

test('dos pagos simultáneos con la misma clave: el que pierde la carrera recibe la misma orden', async () => {
  const b = await beat({ precio: 299 });
  const pagar = () => pedir('POST', '/api/orders', token(CLIENTE), { beats: [b.id] }, CLAVE);
  const [r1, r2] = await Promise.all([pagar(), pagar()]);
  const codigos = [r1.statusCode, r2.statusCode].sort();
  assert.deepEqual(codigos, [200, 201]);
  assert.equal(r1.json().order.id, r2.json().order.id);
  assert.equal(await contar('orders'), 1, 'una sola orden');
  assert.equal(await contar('order_items'), 1, 'un solo cobro del beat');
});

// Práctica 11 · Fase 4: caja blanca de la base de datos (PostgreSQL 16 local, el
// mismo motor de Supabase). Ejecuta las operaciones de persistencia que hace la API,
// mide su tiempo, revisa restricciones, transacciones, planes de ejecución y
// concurrencia real con dos sesiones de psql al mismo tiempo.
//
//   node scripts/p11/db-whitebox.mjs   → scripts/p11/resultados/db.md y db.json
//
// Solo toca registros de prueba propios (prefijo "P11 ") y los borra al terminar.
// Requiere la base skondit_local (local/preparar.ps1).
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..', '..');
const SALIDA = join(AQUI, 'resultados');
const BIN = process.env.PG_BIN ?? 'D:\\PostgreSQL\\16\\bin';
const PSQL = join(BIN, 'psql');
const CONEXION = ['-U', process.env.PGUSER ?? 'postgres', '-h', process.env.PGHOST ?? '127.0.0.1', '-d', process.env.PGDATABASE ?? 'skondit_local'];
const REPETICIONES = 7;
process.env.PGOPTIONS = '-c client_min_messages=warning';
process.env.PGCLIENTENCODING = 'UTF8';

/** Ejecuta SQL; si falla devuelve el SQLSTATE y el mensaje en lugar de lanzar. */
function psql(texto) {
  try {
    const out = execFileSync(PSQL, [...CONEXION, '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'], {
      encoding: 'utf8', input: `\\set VERBOSITY verbose\n\\timing on\n${texto}`, stdio: ['pipe', 'pipe', 'pipe'],
    });
    // psql traduce "Time:" al idioma de Windows ("Duración:"), así que se busca el patrón.
    const TIEMPO = /^[^\s:|]+: ([\d.,]+) ms$/;
    const lineas = out.split(/\r?\n/);
    const tiempos = lineas.map((l) => TIEMPO.exec(l)?.[1]).filter(Boolean).map((t) => Number(t.replace(',', '.')));
    const filas = lineas.filter((l, i) => l && !TIEMPO.test(l) && !(i === 0 && /timing|despliegue/i.test(l)));
    return { ok: true, filas, ms: tiempos.at(-1) ?? null, tiempos };
  } catch (e) {
    const err = String(e.stderr ?? e.message);
    return { ok: false, sqlstate: /ERROR:\s+([0-9A-Z]{5})/.exec(err)?.[1] ?? '?', mensaje: /ERROR:\s+(?:[0-9A-Z]{5}:\s+)?(.*)/.exec(err)?.[1]?.trim() ?? err.trim() };
  }
}
const uno = (t) => psql(t).filas?.[0];
const mediana = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];

/** Abre una sesión de psql en paralelo con el script dado; resuelve con su salida. */
function sesion(nombre, script) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const p = spawn(PSQL, [...CONEXION, '-X', '-At', '-v', 'ON_ERROR_STOP=0'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => resolve({ nombre, out: out.trim(), err: err.trim(), ms: Math.round(performance.now() - t0) }));
    p.stdin.end(script);
  });
}

function explicar(consulta) {
  const tiempos = [];
  const planeacion = [];
  let plan;
  for (let i = 0; i < REPETICIONES; i++) {
    const r = psql(`explain (analyze, buffers, format json) ${consulta}`);
    const json = JSON.parse(r.filas.join(''))[0];
    tiempos.push(json['Execution Time']);
    planeacion.push(json['Planning Time']);
    plan = json.Plan;
  }
  const indices = new Set();
  const nodos = [];
  (function recorrer(n) {
    nodos.push(n['Node Type'] + (n['Index Name'] ? ` (${n['Index Name']})` : ''));
    if (n['Index Name']) indices.add(n['Index Name']);
    (n.Plans ?? []).forEach(recorrer);
  })(plan);
  const filas = plan['Actual Rows'];
  const bytes = Number(uno(`select coalesce(length(json_agg(t)::text), 0) from (${consulta}) t`));
  return {
    ejecucion_ms: +mediana(tiempos).toFixed(3),
    planeacion_ms: +mediana(planeacion).toFixed(3),
    min_ms: +Math.min(...tiempos).toFixed(3),
    max_ms: +Math.max(...tiempos).toFixed(3),
    filas, bytes, indices: [...indices], nodos,
  };
}

// ── Datos de prueba ───────────────────────────────────────────────────────────
const res = { fecha: new Date().toISOString(), motor: uno('select version()'), operaciones: [], restricciones: [], consultas: [], concurrencia: [], transaccion: {} };
const op = (id, nombre, r, esperado, extra = {}) => {
  const fila = { id, nombre, ok: r.ok, ms: r.ms, sqlstate: r.sqlstate ?? null, mensaje: r.mensaje ?? null, resultado: extra.resultado ?? r.filas?.join(' | ') ?? null, esperado, ...extra };
  fila.cumple = extra.cumple ?? (esperado === 'éxito' ? r.ok : !r.ok && r.sqlstate === esperado);
  res.operaciones.push(fila);
  return fila;
};

psql(`delete from order_items where order_id in (select id from orders where user_id in (select id from users where email like 'p11.%@local.test'));
      delete from orders where user_id in (select id from users where email like 'p11.%@local.test');
      delete from beats where nombre like 'P11 %';
      delete from users where email like 'p11.%@local.test';`);
const USUARIO = uno(`insert into users (email, password, nombre, rol) values ('p11.db@local.test', 'x', 'P11 Cliente', 'CLIENTE') returning id`);

// 1. Inserción válida
const ins = psql(`insert into beats (nombre, genero, bpm, precio) values ('P11 Noche', 'Trap', 140, 299) returning id`);
const BEAT = ins.filas[0];
op('DB-01', 'Inserción de un beat válido', ins, 'éxito', { resultado: `id = ${BEAT}` });

// 2. Inserción con datos incompletos o inválidos (cada restricción del esquema)
const invalidos = [
  ['NOT NULL', 'beat sin nombre', `insert into beats (genero, bpm, precio) values ('Trap', 140, 299)`, '23502'],
  ['NOT NULL', 'orden sin usuario', `insert into orders (total, status) values (10, 'COMPLETADO')`, '23502'],
  ['CHECK', 'bpm = 300 (fuera de 1..299)', `insert into beats (nombre, genero, bpm, precio) values ('P11 X', 'Trap', 300, 1)`, '23514'],
  ['CHECK', 'bpm = 0', `insert into beats (nombre, genero, bpm, precio) values ('P11 X', 'Trap', 0, 1)`, '23514'],
  ['CHECK', 'precio negativo', `insert into beats (nombre, genero, bpm, precio) values ('P11 X', 'Trap', 120, -0.01)`, '23514'],
  ['TIPO', 'precio con 9 dígitos enteros (numeric(10,2))', `insert into beats (nombre, genero, bpm, precio) values ('P11 X', 'Trap', 120, 123456789)`, '22003'],
  ['TIPO', 'nombre de 151 caracteres (varchar(150))', `insert into beats (nombre, genero, bpm, precio) values ('P11 ${'x'.repeat(147)}', 'Trap', 120, 1)`, '22001'],
  ['UNIQUE', 'correo de usuario repetido', `insert into users (email, password, nombre) values ('p11.db@local.test', 'x', 'Otro')`, '23505'],
  ['FK', 'orden de un usuario inexistente', `insert into orders (user_id, total, status) values ('00000000-0000-4000-8000-000000000000', 1, 'COMPLETADO')`, '23503'],
  ['FK', 'renglón con beat inexistente', `insert into order_items (order_id, beat_id, precio_unitario) select id, '00000000-0000-4000-8000-000000000000', 1 from orders limit 1`, '23503'],
  ['ENUM', 'estado de orden inválido', `insert into orders (user_id, total, status) values ('${USUARIO}', 1, 'REGALADO')`, '22P02'],
  ['TIPO', 'id que no es UUID', `select * from beats where id = 'abc'`, '22P02'],
];
for (const [tipo, nombre, sql, estado] of invalidos) {
  const r = psql(sql);
  res.restricciones.push({ tipo, nombre, esperado: estado, obtenido: r.ok ? 'ACEPTADO' : r.sqlstate, mensaje: r.mensaje, cumple: !r.ok && r.sqlstate === estado });
}
op('DB-02', 'Inserción con datos inválidos', { ok: false, ms: null }, 'rechazo', {
  resultado: `${res.restricciones.filter((x) => x.cumple).length}/${res.restricciones.length} rechazados con el SQLSTATE esperado`,
  cumple: res.restricciones.every((x) => x.cumple),
});

// 3 y 4. Consulta por id existente / inexistente
const q1 = psql(`select id, nombre, precio from beats where id = '${BEAT}' and activo`);
op('DB-03a', 'Consulta por id existente', q1, 'éxito', { resultado: `${q1.filas.length} fila` });
const q2 = psql(`select id from beats where id = '00000000-0000-4000-8000-000000000000' and activo`);
op('DB-03b', 'Consulta por id inexistente', q2, 'éxito', { resultado: `${q2.filas.length} filas (la API responde 404)`, cumple: q2.ok && q2.filas.length === 0 });

// 5. Actualización + 7. persistencia (se lee en otra conexión)
const up = psql(`update beats set precio = 349, updated_at = now() where id = '${BEAT}' returning precio`);
const persiste = uno(`select precio from beats where id = '${BEAT}'`);
op('DB-04', 'Actualización del precio', up, 'éxito', { resultado: `precio devuelto ${up.filas[0]}; leído en otra conexión ${persiste}`, cumple: up.ok && Number(persiste) === 349 });

// Eliminación con regla de negocio: un beat ya vendido no se puede borrar (FK restrict)
const ORDEN = uno(`insert into orders (user_id, total, status) values ('${USUARIO}', 349, 'COMPLETADO') returning id`);
psql(`insert into order_items (order_id, beat_id, precio_unitario) values ('${ORDEN}', '${BEAT}', 349)`);
const delVendido = psql(`delete from beats where id = '${BEAT}'`);
op('DB-05a', 'Eliminar un beat ya vendido', delVendido, '23503', { resultado: delVendido.ok ? 'BORRADO' : `rechazado ${delVendido.sqlstate}` });

// 6. Eliminación + persistencia; la orden borra sus renglones en cascada
const delOrden = psql(`delete from orders where id = '${ORDEN}'`);
const huerfanos = uno(`select count(*) from order_items where order_id = '${ORDEN}'`);
op('DB-05b', 'Eliminar la orden (cascada a renglones)', delOrden, 'éxito', { resultado: `renglones que quedan: ${huerfanos}`, cumple: delOrden.ok && huerfanos === '0' });
const delBeat = psql(`delete from beats where id = '${BEAT}' returning id`);
const tras = uno(`select count(*) from beats where id = '${BEAT}'`);
op('DB-05c', 'Eliminar el beat sin ventas y consultar después', delBeat, 'éxito', { resultado: `filas tras borrar: ${tras}`, cumple: delBeat.ok && tras === '0' });

// Inyección SQL: el valor viaja como parámetro (así lo hace PostgREST), no como texto del SQL
const iny = psql(`\\set v '''' or 1=1 --'\nselect count(*) from users where email = :'v'`);
op('DB-07', 'Intento de inyección como parámetro', iny, 'éxito', { resultado: `filas: ${iny.filas.at(-1)}`, cumple: iny.ok && iny.filas.at(-1) === '0' });

// ── Transacción vs. autocommit (lo que hace la API con dos llamadas a PostgREST) ──
const B2 = uno(`insert into beats (nombre, genero, bpm, precio) values ('P11 Lluvia', 'Lofi', 90, 150) returning id`);
const antesOrdenes = Number(uno(`select count(*) from orders where user_id = '${USUARIO}'`));
psql(`begin;
  insert into orders (user_id, total, status) values ('${USUARIO}', 150, 'COMPLETADO');
  insert into order_items (order_id, beat_id, precio_unitario) values ((select id from orders where user_id = '${USUARIO}' order by created_at desc limit 1), '00000000-0000-4000-8000-000000000000', 150);
  commit;`);
const conTx = Number(uno(`select count(*) from orders where user_id = '${USUARIO}'`)) - antesOrdenes;
const sueltaId = uno(`insert into orders (user_id, total, status) values ('${USUARIO}', 150, 'COMPLETADO') returning id`);
psql(`insert into order_items (order_id, beat_id, precio_unitario) values ('${sueltaId}', '00000000-0000-4000-8000-000000000000', 150)`);
const sinTx = Number(uno(`select count(*) from orders o where user_id = '${USUARIO}' and not exists (select 1 from order_items i where i.order_id = o.id)`));
psql(`delete from orders where id = '${sueltaId}'`);
res.transaccion = { con_transaccion_ordenes_que_quedan: conTx, sin_transaccion_ordenes_huerfanas: sinTx };

// ── Medición de consultas (EXPLAIN ANALYZE, mediana de 7) ────────────────────
const UCLIENTE = uno(`select user_id from orders group by user_id order by count(*) desc limit 1`);
// Una compra real de un beat activo: Q1 encuentra el beat y Q3 encuentra la compra.
const [UCOMPRO, BVENDIDO] = uno(`select o.user_id || '|' || i.beat_id from order_items i join orders o on o.id = i.order_id
  join beats b on b.id = i.beat_id where b.activo and o.status = 'COMPLETADO' order by o.created_at limit 1`).split('|');
const consultas = [
  ['Q1', 'Beat por id (GET /beats/:id)', `select * from beats where id = '${BVENDIDO}' and activo`],
  ['Q2', 'Primera página del catálogo (GET /beats?limit=20)', `select id, nombre, genero, bpm, precio, imagen_url, audio_url, descripcion, created_at from beats where activo order by created_at desc limit 20`],
  ['Q3', '¿Ya compró estos beats? (POST /orders)', `select i.beat_id from order_items i join orders o on o.id = i.order_id where i.beat_id in ('${BVENDIDO}') and o.user_id = '${UCOMPRO}' and o.status = 'COMPLETADO'`],
  ['Q4', 'Mis compras con sus beats (GET /orders/mis-compras)', `select o.id, o.total, o.created_at, b.id as beat_id, b.nombre from orders o join order_items i on i.order_id = o.id join beats b on b.id = i.beat_id where o.user_id = '${UCLIENTE}' and o.status = 'COMPLETADO' order by o.created_at desc`],
  ['Q5', 'Columnas de más: beat por id con * vs. solo lo que usa la app', `select id, nombre, genero, bpm, precio, imagen_url, audio_url, descripcion from beats where id = '${BVENDIDO}' and activo`],
];
for (const [id, nombre, sql] of consultas) res.consultas.push({ id, nombre, sql, ...explicar(sql) });

// ── Concurrencia ─────────────────────────────────────────────────────────────
// C1: dos actualizaciones del mismo registro a la vez. PostgreSQL bloquea la fila:
// la segunda espera a la primera y ninguna se pierde.
psql(`update beats set precio = 100 where id = '${B2}'`);
const [a1, a2] = await Promise.all([
  sesion('A', `begin;\nupdate beats set precio = precio + 10 where id = '${B2}';\nselect pg_sleep(1);\ncommit;\n`),
  new Promise((r) => setTimeout(r, 150)).then(() => sesion('B', `update beats set precio = precio + 25 where id = '${B2}';\n`)),
]);
const final = Number(uno(`select precio from beats where id = '${B2}'`));
res.concurrencia.push({ id: 'DB-06a', nombre: 'Dos UPDATE simultáneos al mismo beat (precio = precio + n)', esperado: 135, obtenido: final, espera_sesion_b_ms: a2.ms, cumple: final === 135 });

// C2: dos compras simultáneas del MISMO beat por el MISMO usuario con claves de
// idempotencia distintas (dos teléfonos). Se reproduce el flujo de la API: revisar si
// ya lo compró → crear la orden → crear el renglón, cada paso en su propia llamada.
function compra(nombre) {
  return sesion(nombre, `\\set QUIET on
select count(*) > 0 as ya from order_items i join orders o on o.id = i.order_id where o.user_id = '${USUARIO}' and o.status = 'COMPLETADO' and i.beat_id = '${B2}' \\gset
\\if :ya
\\echo ${nombre}: 409 ya comprado
\\quit
\\endif
select pg_sleep(0.4);
insert into orders (user_id, total, status) values ('${USUARIO}', 150, 'COMPLETADO') returning id as orden \\gset
insert into order_items (order_id, beat_id, precio_unitario) values (:'orden', '${B2}', 150);
\\if :ERROR
delete from orders where id = :'orden';
\\echo ${nombre}: 409 rechazado por la base (orden deshecha)
\\else
\\echo ${nombre}: 201 compra creada
\\endif
`);
}
async function carrera(etiqueta) {
  psql(`delete from orders where user_id = '${USUARIO}'`);
  const s = await Promise.all([compra('A'), compra('B')]);
  const compras = Number(uno(`select count(*) from order_items i join orders o on o.id = i.order_id where o.user_id = '${USUARIO}' and i.beat_id = '${B2}' and o.status = 'COMPLETADO'`));
  return { id: 'DB-06b', nombre: `Dos compras simultáneas del mismo beat (${etiqueta})`, esperado: 1, obtenido: compras, sesiones: s.map((x) => x.out.split(/\r?\n/).filter((l) => l.includes(':')).join(' ') || x.err), cumple: compras === 1 };
}
const correccion = join(RAIZ, 'local', 'p11_compras_unicas.sql');
psql('drop trigger if exists trg_compra_unica on order_items; drop function if exists evitar_compra_repetida();');
res.concurrencia.push(await carrera('ANTES: sin protección en la base'));
const aplicada = psql(readFileSync(correccion, 'utf8'));
if (!aplicada.ok) throw new Error('No se pudo aplicar p11_compras_unicas.sql: ' + aplicada.mensaje);
res.concurrencia.push(await carrera('DESPUÉS: con trg_compra_unica'));


// ── Limpieza ─────────────────────────────────────────────────────────────────
psql(`delete from orders where user_id = '${USUARIO}'; delete from beats where nombre like 'P11 %'; delete from users where id = '${USUARIO}';`);

// ── Reporte ──────────────────────────────────────────────────────────────────
mkdirSync(SALIDA, { recursive: true });
writeFileSync(join(SALIDA, 'db.json'), JSON.stringify(res, null, 2));
const si = (b) => (b ? '✅' : '❌');
const md = [
  `# Práctica 11 · Fase 4 — Base de datos (${res.fecha})`, '', `Motor: ${res.motor}`, '',
  '## Operaciones', '', '| ID | Operación | Tiempo (ms) | Resultado | Cumple |', '|---|---|---:|---|:---:|',
  ...res.operaciones.map((o) => `| ${o.id} | ${o.nombre} | ${o.ms ?? '—'} | ${o.resultado ?? ''}${o.sqlstate ? ` (${o.sqlstate})` : ''} | ${si(o.cumple)} |`),
  '', '## Restricciones', '', '| Tipo | Caso | SQLSTATE esperado | Obtenido | Mensaje | Cumple |', '|---|---|---|---|---|:---:|',
  ...res.restricciones.map((r) => `| ${r.tipo} | ${r.nombre} | ${r.esperado} | ${r.obtenido} | ${(r.mensaje ?? '').slice(0, 90)} | ${si(r.cumple)} |`),
  '', '## Transacción', '', `- Con BEGIN/COMMIT, si el renglón falla: órdenes que quedan = **${res.transaccion.con_transaccion_ordenes_que_quedan}**`,
  `- Sin transacción (como la API, dos llamadas): órdenes huérfanas = **${res.transaccion.sin_transaccion_ordenes_huerfanas}**`,
  '', '## Consultas (EXPLAIN ANALYZE, mediana de 7)', '', '| ID | Consulta | Ejecución ms | Planeación ms | Mín–Máx | Filas | Bytes | Índices | Plan |', '|---|---|---:|---:|---|---:|---:|---|---|',
  ...res.consultas.map((c) => `| ${c.id} | ${c.nombre} | ${c.ejecucion_ms} | ${c.planeacion_ms} | ${c.min_ms}–${c.max_ms} | ${c.filas} | ${c.bytes} | ${c.indices.join(', ') || '—'} | ${c.nodos.join(' → ')} |`),
  '', '## Concurrencia', '', '| ID | Prueba | Esperado | Obtenido | Detalle | Cumple |', '|---|---|---:|---:|---|:---:|',
  ...res.concurrencia.map((c) => `| ${c.id} | ${c.nombre} | ${c.esperado} | ${c.obtenido} | ${c.sesiones?.join(' / ') ?? `B esperó ${c.espera_sesion_b_ms} ms el bloqueo`} | ${si(c.cumple)} |`),
  '',
].join('\n');
writeFileSync(join(SALIDA, 'db.md'), md);
console.log(md);

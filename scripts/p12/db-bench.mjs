// Práctica 12 · Fase 4: pruebas de base de datos sobre el PostgreSQL local.
// Mide cada consulta ANTES (como la hacía la API original, sin los índices nuevos)
// y DESPUÉS (paginada, con solo lo necesario y con los índices de local/indices.sql),
// y ejecuta las pruebas de concurrencia con pgbench.
//
//   node scripts/p12/db-bench.mjs            → imprime y guarda scripts/p12/resultados/db.md
//
// Requiere la base skondit_local (local/preparar.ps1). Variables opcionales:
//   PG_BIN (carpeta de psql/pgbench), PGHOST, PGUSER, PGDATABASE.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..', '..');
const BIN = process.env.PG_BIN ?? 'D:\\PostgreSQL\\16\\bin';
const BASE = process.env.PGDATABASE ?? 'skondit_local';
const CONEXION = ['-U', process.env.PGUSER ?? 'postgres', '-h', process.env.PGHOST ?? '127.0.0.1', '-d', BASE];
const REPETICIONES = 7;
process.env.PGOPTIONS = '-c client_min_messages=warning';

const psql = (args, input) =>
  execFileSync(join(BIN, 'psql'), [...CONEXION, '-X', '-At', '-v', 'ON_ERROR_STOP=1', ...args], {
    encoding: 'utf8',
    input,
    maxBuffer: 256 * 1024 * 1024,
  }).trim();

const sql = (texto) => psql(['-c', texto]);
const mediana = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];

/** Ejecuta la consulta varias veces con EXPLAIN ANALYZE y resume el plan. */
function medir(consulta) {
  const tiempos = [];
  let plan;
  for (let i = 0; i < REPETICIONES; i++) {
    const json = JSON.parse(sql(`explain (analyze, buffers, format json) ${consulta}`))[0];
    tiempos.push(json['Execution Time']);
    plan = json.Plan;
  }
  const indices = new Set();
  const nodos = new Set();
  (function recorrer(n) {
    nodos.add(n['Node Type']);
    if (n['Index Name']) indices.add(n['Index Name']);
    (n.Plans ?? []).forEach(recorrer);
  })(plan);
  const bytes = Number(sql(`select coalesce(length(json_agg(t)::text), 0) from (${consulta}) t`));
  return {
    ms: mediana(tiempos),
    filas: plan['Actual Rows'],
    kb: bytes / 1024,
    indices: [...indices],
    secuencial: nodos.has('Seq Scan'),
    ordena: nodos.has('Sort'),
  };
}

const beatId = sql(`select id from beats where activo order by created_at desc offset 2500 limit 1`);
const clienteId = sql(`select user_id from orders group by user_id order by count(*) desc limit 1`);

const COLS_BEAT = 'id, nombre, genero, bpm, precio, imagen_url, audio_url, descripcion, created_at';
const COLS_TICKET = `m.id, m.nombre, m.email, m.mensaje, m.tipo, m.estado, m.user_id, m.asignado_a, m.created_at,
  (select row_to_json(u) from (select nombre from users where id = m.asignado_a) u) asignado`;

// Cada prueba: la consulta original y la optimizada. Si son iguales, solo cambian los índices.
const PRUEBAS = [
  {
    id: 'DB-01',
    nombre: 'Beat por identificador',
    antes: `select * from beats where id = '${beatId}' and activo`,
  },
  {
    id: 'DB-02',
    nombre: 'Conjunto pequeño: primera pantalla de la tienda',
    nota: 'Antes la tienda traía el catálogo completo para mostrar ~8 tarjetas; ahora pide una página de 20.',
    antes: `select ${COLS_BEAT} from beats where activo order by created_at desc`,
    despues: `select ${COLS_BEAT} from beats where activo order by created_at desc limit 20`,
  },
  {
    id: 'DB-03',
    nombre: 'Conjunto grande: catálogo completo (4 800 beats)',
    nota: 'Misma consulta; se conserva para la web. Solo cambia el índice disponible.',
    antes: `select ${COLS_BEAT} from beats where activo order by created_at desc`,
  },
  {
    id: 'DB-04',
    nombre: 'Consulta con filtros (género + BPM + precio)',
    antes: `select ${COLS_BEAT} from beats where activo and genero = 'Trap' and bpm between 120 and 150 and precio <= 600 order by created_at desc`,
    despues: `select ${COLS_BEAT} from beats where activo and genero = 'Trap' and bpm between 120 and 150 and precio <= 600 order by created_at desc limit 20`,
  },
  {
    id: 'DB-05',
    nombre: 'Consulta crítica: bandeja de tickets del administrador',
    nota: 'Antes: los 12 000 tickets con el texto de todas sus respuestas. Ahora: 20 tickets abiertos y solo el número de respuestas.',
    antes: `select ${COLS_TICKET},
      coalesce((select json_agg(r) from (select id, autor_nombre, es_admin, texto, created_at
                from contact_replies where message_id = m.id) r), '[]') contact_replies
      from contact_messages m order by m.created_at desc`,
    despues: `select ${COLS_TICKET}, m.folio, m.asunto, m.prioridad,
      (select count(*) from contact_replies where message_id = m.id) respuestas
      from contact_messages m where m.estado = 'ABIERTO' order by m.created_at desc limit 20`,
  },
  {
    id: 'DB-06',
    nombre: 'Tickets de un cliente',
    antes: `select ${COLS_TICKET},
      coalesce((select json_agg(r) from (select id, autor_nombre, es_admin, texto, created_at
                from contact_replies where message_id = m.id) r), '[]') contact_replies
      from contact_messages m where m.user_id = '${clienteId}' order by m.created_at desc`,
    despues: `select ${COLS_TICKET}, m.folio, m.asunto, m.prioridad,
      (select count(*) from contact_replies where message_id = m.id) respuestas
      from contact_messages m where m.user_id = '${clienteId}' order by m.created_at desc limit 20`,
  },
  {
    id: 'DB-07',
    nombre: 'Compras de un cliente (órdenes completadas con sus beats)',
    antes: `select o.id, o.total, o.created_at, b.id beat_id, b.nombre from orders o
      join order_items i on i.order_id = o.id join beats b on b.id = i.beat_id
      where o.user_id = '${clienteId}' and o.status = 'COMPLETADO' order by o.created_at desc`,
  },
];

function fase(etiqueta, quitarIndices) {
  psql(quitarIndices ? ['-q', '-v', 'quitar=1', '-f', join(RAIZ, 'local', 'indices.sql')] : ['-q', '-f', join(RAIZ, 'local', 'indices.sql')]);
  const r = {};
  for (const p of PRUEBAS) {
    r[p.id] = medir(etiqueta === 'antes' ? p.antes : (p.despues ?? p.antes));
  }
  return r;
}

// ── Concurrencia (pgbench) ───────────────────────────────────────────────────
function pgbench(script, clientes, transacciones) {
  const archivo = join(AQUI, 'resultados', '_pgbench.sql');
  writeFileSync(archivo, script);
  const salida = execFileSync(
    join(BIN, 'pgbench'),
    // En pgbench la base es posicional y va al final (-d significa --debug).
    [...CONEXION.slice(0, 4), '-n', '-c', String(clientes), '-j', '4', '-t', String(transacciones), '-f', archivo, BASE],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const num = (re) => Number(re.exec(salida)?.[1] ?? NaN);
  return {
    clientes,
    transacciones: clientes * transacciones,
    latenciaMs: num(/latency average = ([\d.]+) ms/),
    tps: num(/tps = ([\d.]+)/),
    fallidas: num(/number of failed transactions: (\d+)/),
  };
}

function concurrencia() {
  sql(`drop table if exists p12_resultado; create table p12_resultado (prueba text, exito int)`);
  const r = {};

  // CON-01: 20 clientes actualizan tickets DISTINTOS al mismo tiempo.
  r.distintos = pgbench(
    `\\set f random(1, 12000)\nupdate contact_messages set updated_at = now() where folio = :f;\n`,
    20, 100,
  );

  // CON-02: 20 clientes escriben sobre EL MISMO ticket (bloqueo de fila).
  r.mismo = pgbench(`update contact_messages set updated_at = now() where folio = 1;\n`, 20, 100);

  // CON-03: 20 administradores toman el mismo ticket abierto a la vez. La API
  // condiciona el UPDATE al estado que veía cada uno: solo uno debe ganarlo.
  sql(`update contact_messages set estado = 'ABIERTO' where folio = 1`);
  pgbench(
    `with c as (update contact_messages set estado = 'EN_PROCESO' where folio = 1 and estado = 'ABIERTO' returning 1)
     insert into p12_resultado select 'tomar', count(*) from c;\n`,
    20, 1,
  );
  r.tomar = { intentos: 20, ganadores: Number(sql(`select sum(exito) from p12_resultado where prueba = 'tomar'`)) };

  // CON-04: el mismo pago llega 20 veces con la misma clave de idempotencia.
  const ref = '11111111-2222-4333-8444-555555555555';
  sql(`delete from orders where client_ref = '${ref}'`);
  pgbench(
    `with c as (insert into orders (user_id, total, status, client_ref)
       values ('${clienteId}', 100, 'COMPLETADO', '${ref}') on conflict (client_ref) do nothing returning 1)
     insert into p12_resultado select 'pago', count(*) from c;\n`,
    20, 1,
  );
  r.pago = {
    intentos: 20,
    insertados: Number(sql(`select sum(exito) from p12_resultado where prueba = 'pago'`)),
    enBase: Number(sql(`select count(*) from orders where client_ref = '${ref}'`)),
  };

  // CON-05: lo mismo SIN clave (comportamiento original): cada reintento crea otra orden.
  sql(`delete from orders where total = 100.01 and user_id = '${clienteId}'`);
  pgbench(`insert into orders (user_id, total, status) values ('${clienteId}', 100.01, 'COMPLETADO');\n`, 20, 1);
  r.sinClave = { intentos: 20, enBase: Number(sql(`select count(*) from orders where total = 100.01 and user_id = '${clienteId}'`)) };

  // Integridad después de las pruebas.
  r.integridad = {
    renglonesHuerfanos: Number(sql(`select count(*) from order_items i left join orders o on o.id = i.order_id where o.id is null`)),
    respuestasHuerfanas: Number(sql(`select count(*) from contact_replies r left join contact_messages m on m.id = r.message_id where m.id is null`)),
    foliosRepetidos: Number(sql(`select count(*) from (select folio from contact_messages group by folio having count(*) > 1) x`)),
    tickets: Number(sql(`select count(*) from contact_messages`)),
    estadoTicket1: sql(`select estado from contact_messages where folio = 1`),
  };

  sql(`delete from orders where client_ref = '${ref}' or (total = 100.01 and user_id = '${clienteId}'); drop table p12_resultado`);
  return r;
}

// ── Ejecución y reporte ──────────────────────────────────────────────────────
mkdirSync(join(AQUI, 'resultados'), { recursive: true });
const version = sql('select version()').split(',')[0];
const antes = fase('antes', true);
const despues = fase('despues', false);
const con = concurrencia();

const f = (n, d = 3) => n.toFixed(d);
const plan = (m) => [m.indices.length ? `índice ${m.indices.join(', ')}` : 'sin índice', m.secuencial ? 'recorrido secuencial' : null, m.ordena ? 'ordena en memoria' : null].filter(Boolean).join(' · ');

let md = `# Práctica 12 · Rendimiento de base de datos\n\n`;
md += `${version} · base \`${BASE}\` · mediana de ${REPETICIONES} ejecuciones (tiempo de ejecución de EXPLAIN ANALYZE).\n\n`;
md += `## Consultas (antes y después)\n\n`;
md += `| Prueba | Consulta | Antes ms | Filas | KB | Después ms | Filas | KB | Mejora |\n|---|---|---:|---:|---:|---:|---:|---:|---:|\n`;
for (const p of PRUEBAS) {
  const a = antes[p.id], d = despues[p.id];
  md += `| ${p.id} | ${p.nombre} | ${f(a.ms)} | ${a.filas} | ${f(a.kb, 1)} | ${f(d.ms)} | ${d.filas} | ${f(d.kb, 1)} | ${f((1 - d.ms / a.ms) * 100, 0)} % |\n`;
}
md += `\n## Uso de índices\n\n| Prueba | Antes | Después |\n|---|---|---|\n`;
for (const p of PRUEBAS) md += `| ${p.id} | ${plan(antes[p.id])} | ${plan(despues[p.id])} |\n`;
md += `\n` + PRUEBAS.filter((p) => p.nota).map((p) => `- **${p.id}**: ${p.nota}`).join('\n') + `\n`;
md += `\n## Concurrencia\n\n| Prueba | Resultado |\n|---|---|\n`;
md += `| CON-01 · 20 clientes actualizan tickets distintos (${con.distintos.transacciones} escrituras) | ${f(con.distintos.tps, 0)} tps · latencia media ${f(con.distintos.latenciaMs, 2)} ms · ${con.distintos.fallidas || 0} fallidas |\n`;
md += `| CON-02 · 20 clientes escriben el mismo ticket (${con.mismo.transacciones} escrituras) | ${f(con.mismo.tps, 0)} tps · latencia media ${f(con.mismo.latenciaMs, 2)} ms (espera por bloqueo de fila) · ${con.mismo.fallidas || 0} fallidas |\n`;
md += `| CON-03 · 20 admins toman el mismo ticket a la vez | ${con.tomar.ganadores} lo obtiene, ${con.tomar.intentos - con.tomar.ganadores} reciben "el ticket cambió" (409) |\n`;
md += `| CON-04 · mismo pago 20 veces con Idempotency-Key | ${con.pago.enBase} orden en la base (${con.pago.intentos - con.pago.insertados} reintentos descartados por UNIQUE) |\n`;
md += `| CON-05 · mismo pago 20 veces sin clave (original) | ${con.sinClave.enBase} órdenes duplicadas |\n`;
md += `\n## Integridad después de las pruebas\n\n`;
md += `- Renglones de orden sin orden: ${con.integridad.renglonesHuerfanos}\n- Respuestas sin ticket: ${con.integridad.respuestasHuerfanas}\n`;
md += `- Folios repetidos: ${con.integridad.foliosRepetidos}\n- Tickets: ${con.integridad.tickets} (sin pérdidas)\n- Estado final del ticket #1: ${con.integridad.estadoTicket1}\n`;

writeFileSync(join(AQUI, 'resultados', 'db.md'), md);
writeFileSync(join(AQUI, 'resultados', 'db.json'), JSON.stringify({ version, antes, despues, concurrencia: con }, null, 2));
console.log(md);

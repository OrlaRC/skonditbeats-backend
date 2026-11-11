// Práctica 12 · Fase 3: prueba de estrés reproducible de la API (sin dependencias).
// Sube la carga por escalones de usuarios concurrentes y, por cada escalón, mide
// RPS, latencia promedio, P90, P95, máximo, errores y códigos HTTP. Mientras tanto
// sondea /health para ver si el servidor sigue respondiendo.
//
//   node scripts/p12/carga.mjs --etiqueta despues
//   node scripts/p12/carga.mjs --etiqueta antes --base http://127.0.0.1:3001 --lectura /api/beats
//
// Opciones (todas opcionales):
//   --base      URL del servidor                     (http://127.0.0.1:3000)
//   --lectura   ruta GET a estresar                  (/api/beats?limit=20&page=1)
//   --escritura ruta POST a estresar, o "no"         (/api/contact)
//   --usuarios  escalones de concurrencia            (1,10,25,50,100,200)
//   --segundos  duración de cada escalón             (10)
//   --etiqueta  nombre del reporte en resultados/    (prueba)
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (nombre, defecto) => {
  const i = process.argv.indexOf(`--${nombre}`);
  return i > 0 ? process.argv[i + 1] : defecto;
};

const BASE = new URL(arg('base', 'http://127.0.0.1:3000'));
const LECTURA = arg('lectura', '/api/beats?limit=20&page=1');
const ESCRITURA = arg('escritura', '/api/contact');
const USUARIOS = arg('usuarios', '1,10,25,50,100,200').split(',').map(Number);
const SEGUNDOS = Number(arg('segundos', '10'));
const ETIQUETA = arg('etiqueta', 'prueba');

function pedir(agente, metodo, ruta, cuerpo) {
  return new Promise((resolve) => {
    const inicio = performance.now();
    const datos = cuerpo ? Buffer.from(JSON.stringify(cuerpo)) : null;
    const req = http.request(
      {
        host: BASE.hostname,
        port: BASE.port,
        path: ruta,
        method: metodo,
        agent: agente,
        timeout: 30_000,
        headers: datos
          ? { 'content-type': 'application/json', 'content-length': datos.length, 'idempotency-key': randomUUID() }
          : {},
      },
      (res) => {
        let bytes = 0;
        res.on('data', (t) => (bytes += t.length));
        res.on('end', () => resolve({ ms: performance.now() - inicio, status: res.statusCode, bytes }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ms: performance.now() - inicio, status: e.message === 'timeout' ? 'TIMEOUT' : 'RED', bytes: 0 }));
    req.end(datos ?? undefined);
  });
}

const percentil = (ordenados, p) => ordenados[Math.min(ordenados.length - 1, Math.ceil((p / 100) * ordenados.length) - 1)];

async function escalon(metodo, ruta, usuarios, cuerpoDe) {
  const agente = new http.Agent({ keepAlive: true, maxSockets: usuarios });
  const sonda = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const fin = performance.now() + SEGUNDOS * 1000;
  const muestras = [];
  const sondas = [];
  let n = 0;

  const usuario = async () => {
    while (performance.now() < fin) muestras.push(await pedir(agente, metodo, ruta, cuerpoDe?.(n++)));
  };
  const vigia = async () => {
    while (performance.now() < fin) {
      sondas.push((await pedir(sonda, 'GET', '/health')).ms);
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  const inicio = performance.now();
  await Promise.all([...Array.from({ length: usuarios }, usuario), vigia()]);
  const duracion = (performance.now() - inicio) / 1000;
  agente.destroy();
  sonda.destroy();

  const tiempos = muestras.map((m) => m.ms).sort((a, b) => a - b);
  const codigos = {};
  for (const m of muestras) codigos[m.status] = (codigos[m.status] ?? 0) + 1;
  const errores = muestras.filter((m) => typeof m.status !== 'number' || m.status >= 400).length;

  return {
    usuarios,
    solicitudes: muestras.length,
    exitosas: muestras.length - errores,
    rps: muestras.length / duracion,
    promedio: tiempos.reduce((a, b) => a + b, 0) / tiempos.length,
    p50: percentil(tiempos, 50),
    p90: percentil(tiempos, 90),
    p95: percentil(tiempos, 95),
    max: tiempos.at(-1),
    errores,
    errorPct: (errores / muestras.length) * 100,
    codigos,
    kbPorRespuesta: muestras.reduce((a, m) => a + m.bytes, 0) / muestras.length / 1024,
    healthMaxMs: Math.max(...sondas),
  };
}

/** Punto de saturación: el primer escalón donde más usuarios ya no dan más RPS (<10 %). */
function saturacion(filas) {
  for (let i = 1; i < filas.length; i++) {
    if (filas[i].rps < filas[i - 1].rps * 1.1) return filas[i - 1];
  }
  return null;
}

const f = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '—');

function tabla(titulo, filas) {
  let md = `### ${titulo}\n\n| Usuarios | Solicitudes | Exitosas | RPS | Prom. ms | P50 | P90 | P95 | Máx. ms | Errores % | Códigos HTTP | KB/resp. | /health máx. ms |\n|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|\n`;
  for (const r of filas) {
    const codigos = Object.entries(r.codigos).map(([c, n]) => `${c}×${n}`).join(' ');
    md += `| ${r.usuarios} | ${r.solicitudes} | ${r.exitosas} | ${f(r.rps, 0)} | ${f(r.promedio)} | ${f(r.p50)} | ${f(r.p90)} | ${f(r.p95)} | ${f(r.max)} | ${f(r.errorPct, 2)} | ${codigos} | ${f(r.kbPorRespuesta)} | ${f(r.healthMaxMs)} |\n`;
  }
  const s = saturacion(filas);
  const primero = filas[0], ultimo = filas.at(-1);
  md += `\n`;
  md += s
    ? `**Punto de saturación:** alrededor de ${s.usuarios} usuarios (${f(s.rps, 0)} RPS). A partir de ahí agregar usuarios ya no aumenta las solicitudes atendidas: se forman en cola y la latencia crece (de ${f(primero.promedio)} ms con ${primero.usuarios} usuario(s) a ${f(ultimo.promedio)} ms con ${ultimo.usuarios}).\n`
    : `**Sin saturación en el rango probado:** el RPS siguió creciendo hasta ${ultimo.usuarios} usuarios (${f(ultimo.rps, 0)} RPS).\n`;
  return md + '\n';
}

const salud = await pedir(new http.Agent(), 'GET', '/health');
if (salud.status !== 200) {
  console.error(`La API no responde en ${BASE.origin} (${salud.status}). Arráncala antes de medir.`);
  process.exit(1);
}

const resultado = { etiqueta: ETIQUETA, base: BASE.origin, fecha: new Date().toISOString(), segundosPorEscalon: SEGUNDOS };

console.log(`Lectura: GET ${LECTURA}`);
resultado.lectura = { ruta: LECTURA, filas: [] };
for (const u of USUARIOS) {
  const r = await escalon('GET', LECTURA, u);
  resultado.lectura.filas.push(r);
  console.log(`  ${u} usuarios → ${f(r.rps, 0)} RPS, prom ${f(r.promedio)} ms, P95 ${f(r.p95)} ms, errores ${f(r.errorPct, 2)} %`);
}

if (ESCRITURA !== 'no') {
  console.log(`Escritura: POST ${ESCRITURA}`);
  resultado.escritura = { ruta: ESCRITURA, filas: [] };
  const cuerpo = (n) => ({
    nombre: 'Prueba de carga',
    email: `carga${n}@local.test`,
    asunto: `Carga ${ETIQUETA} ${n}`,
    mensaje: `Ticket generado por la prueba de estrés (${ETIQUETA}) número ${n}.`,
    tipo: 'MENSAJE',
  });
  for (const u of USUARIOS) {
    const r = await escalon('POST', ESCRITURA, u, cuerpo);
    resultado.escritura.filas.push(r);
    console.log(`  ${u} usuarios → ${f(r.rps, 0)} RPS, prom ${f(r.promedio)} ms, P95 ${f(r.p95)} ms, errores ${f(r.errorPct, 2)} %`);
  }
}

let md = `# Práctica 12 · Prueba de estrés de la API (${ETIQUETA})\n\n`;
md += `Servidor: ${BASE.origin} · ${SEGUNDOS} s por escalón · ${resultado.fecha}\n\n`;
md += tabla(`Lectura · GET ${LECTURA}`, resultado.lectura.filas);
if (resultado.escritura) md += tabla(`Escritura · POST ${ESCRITURA}`, resultado.escritura.filas);

const carpeta = join(dirname(fileURLToPath(import.meta.url)), 'resultados');
mkdirSync(carpeta, { recursive: true });
writeFileSync(join(carpeta, `carga-${ETIQUETA}.md`), md);
writeFileSync(join(carpeta, `carga-${ETIQUETA}.json`), JSON.stringify(resultado, null, 2));
console.log(`\n${md}`);

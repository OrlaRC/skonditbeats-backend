// Práctica 11 · Fase 5: conectividad y rendimiento entre app (celular), API y base.
//
//   node scripts/p11/red.mjs            → scripts/p11/resultados/red.md y red.json
//   node scripts/p11/red.mjs --sin-prod (no toca producción)
//
// Requiere el entorno local levantado (local/iniciar.ps1) y el celular por USB con
// `adb reverse tcp:3000` y `tcp:54321`. Mide:
//   A. Ping ICMP desde el celular (20 paquetes por destino).
//   B. Latencia HTTP: 10 solicitudes consecutivas desde la PC y desde el celular.
//   C. Tasa de transferencia de descarga y de subida (3 mediciones cada una).
//   D. Consistencia de las 10 respuestas (mismo contenido y misma estructura).
//   E. Carga controlada con 1, 5 y 10 usuarios: un endpoint de lectura y uno de escritura.
// Producción (skonditbeats-backend.vercel.app) solo recibe lecturas pequeñas; las
// escrituras y la carga van únicamente al entorno local.
import { execFileSync, execSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const SALIDA = join(AQUI, 'resultados');
const LOCAL = process.env.API ?? 'http://127.0.0.1:3000';
const PROD = 'https://skonditbeats-backend.vercel.app';
const ADB = process.env.ADB ?? 'D:\\AndroidSDK\\platform-tools\\adb.exe';
const PSQL = join(process.env.PG_BIN ?? 'D:\\PostgreSQL\\16\\bin', 'psql');
const SIN_PROD = process.argv.includes('--sin-prod');
const LECTURA = '/api/beats?limit=20&page=1';

const r2 = (n) => Math.round(n * 100) / 100;
const promedio = (v) => v.reduce((a, b) => a + b, 0) / v.length;
const desv = (v) => { const m = promedio(v); return Math.sqrt(promedio(v.map((x) => (x - m) ** 2))); };
const pct = (v, p) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const mbps = (bytes, ms) => r2((bytes * 8) / (ms / 1000) / 1_000_000);
const adb = (cmd) => execFileSync(ADB, ['shell', cmd], { encoding: 'utf8', timeout: 180_000 }).trim();
const sql = (t) => execFileSync(PSQL, ['-U', 'postgres', '-h', '127.0.0.1', '-d', 'skondit_local', '-X', '-At', '-c', t], { encoding: 'utf8' }).trim();

/** Una petición HTTP con tiempos por fase (DNS, TCP, TLS, primer byte, total). */
function pedir(url, { method = 'GET', headers = {}, body, agent } = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const t = { inicio: performance.now() };
    const datos = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = lib.request(u, {
      method, agent: agent ?? false,
      headers: { ...(datos ? { 'content-type': 'application/json', 'content-length': datos.length } : {}), ...headers },
    }, (res) => {
      t.primerByte = performance.now();
      const trozos = [];
      res.on('data', (d) => trozos.push(d));
      res.on('end', () => {
        const fin = performance.now();
        const cuerpo = Buffer.concat(trozos);
        resolve({
          status: res.statusCode, bytes: cuerpo.length, cuerpo,
          ms: r2(fin - t.inicio), ttfb: r2(t.primerByte - t.inicio),
          dns: t.dns ? r2(t.dns - t.inicio) : 0, tcp: t.tcp ? r2(t.tcp - (t.dns ?? t.inicio)) : 0,
          tls: t.tls ? r2(t.tls - t.tcp) : 0,
        });
      });
    });
    req.on('socket', (s) => {
      s.once('lookup', () => (t.dns = performance.now()));
      s.once('connect', () => (t.tcp = performance.now()));
      s.once('secureConnect', () => (t.tls = performance.now()));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.code ?? e.message, ms: r2(performance.now() - t.inicio), bytes: 0 }));
    req.setTimeout(30_000, () => req.destroy(new Error('timeout')));
    if (datos) req.write(datos);
    req.end();
  });
}

function resumen(lista) {
  const ms = lista.map((x) => x.ms);
  return { n: ms.length, min: r2(Math.min(...ms)), max: r2(Math.max(...ms)), promedio: r2(promedio(ms)), desv: r2(desv(ms)), p95: r2(pct(ms, 95)) };
}

const res = { fecha: new Date().toISOString(), entorno: {}, ping: [], http: [], transferencia: [], consistencia: [], carga: [] };

// ── Entorno ──────────────────────────────────────────────────────────────────
const git = (dir) => { try { return execSync('git rev-parse --short HEAD', { cwd: dir, encoding: 'utf8' }).trim(); } catch { return '?'; } };
const wifiPc = Object.entries(os.networkInterfaces()).find(([n]) => /wi-?fi/i.test(n))?.[1]?.find((a) => a.family === 'IPv4')?.address;
let cel = {};
try {
  cel = {
    modelo: adb('getprop ro.product.model'), android: adb('getprop ro.build.version.release'),
    ip: /inet ([\d.]+)/.exec(adb('ip -f inet addr show wlan0'))?.[1],
    gateway: /via ([\d.]+)/.exec(adb('ip route get 1.1.1.1'))?.[1] ?? process.env.ROUTER,
  };
  execFileSync(ADB, ['reverse', 'tcp:3000', 'tcp:3000']);
  execFileSync(ADB, ['reverse', 'tcp:54321', 'tcp:54321']);
} catch (e) {
  console.warn('Sin celular por ADB:', e.message);
}
res.entorno = {
  pc: `${os.type()} ${os.release()} · ${os.cpus()[0].model} · ${os.cpus().length} hilos · ${Math.round(os.totalmem() / 2 ** 30)} GB`,
  node: process.version, pc_wifi: wifiPc, celular: cel,
  conexion_cel_api: 'USB (adb reverse tcp:3000 → PC)', api_local: LOCAL, produccion: PROD,
  commit_api: git(join(AQUI, '..', '..')), commit_app: git('D:\\Flutter\\skondit_beats_mobile'),
};

// ── A. Ping ICMP desde el celular ────────────────────────────────────────────
function pingCel(destino, nombre) {
  let out = '';
  try { out = adb(`ping -c 20 -i 0.2 -W 2 ${destino}`); } catch (e) { out = String(e.stdout ?? ''); }
  const tiempos = [...out.matchAll(/time=([\d.]+) ms/g)].map((m) => Number(m[1]));
  const perdida = Number(/(\d+(?:\.\d+)?)% packet loss/.exec(out)?.[1] ?? 100);
  const rtt = /= ([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+) ms/.exec(out);
  res.ping.push({
    origen: 'Celular', destino: `${nombre} (${destino})`, enviados: 20, recibidos: tiempos.length, perdida_pct: perdida,
    min: rtt ? +rtt[1] : null, promedio: rtt ? +rtt[2] : null, max: rtt ? +rtt[3] : null, desv: rtt ? +rtt[4] : null,
  });
}
if (cel.ip) {
  if (cel.gateway) pingCel(cel.gateway, 'Router Wi-Fi');
  if (wifiPc) pingCel(wifiPc, 'PC con la API');
  if (!SIN_PROD) pingCel(new URL(PROD).hostname, 'Producción (Vercel)');
}

// ── B y D. 10 solicitudes consecutivas ───────────────────────────────────────
async function diezDesdePc(base, etiqueta, ruta = LECTURA) {
  const lista = [];
  for (let i = 0; i < 10; i++) lista.push(await pedir(base + ruta));
  res.http.push({ origen: 'PC', destino: etiqueta, ruta, solicitudes: lista.map(({ cuerpo, ...x }) => x), ...resumen(lista) });
  const hashes = lista.filter((x) => x.cuerpo).map((x) => createHash('sha256').update(x.cuerpo).digest('hex').slice(0, 12));
  const claves = lista.filter((x) => x.status === 200).map((x) => Object.keys(JSON.parse(x.cuerpo)).sort().join(','));
  res.consistencia.push({ destino: etiqueta, ruta, codigos: [...new Set(lista.map((x) => x.status))], cuerpos_distintos: new Set(hashes).size, estructura: [...new Set(claves)], bytes: [...new Set(lista.map((x) => x.bytes))] });
}
const FORMATO = '%{http_code} %{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total} %{size_download} %{speed_download} %{size_upload} %{speed_upload}';
function curlCel(url, veces, extra = '') {
  const out = adb(`for i in $(seq 1 ${veces}); do curl -s -o /dev/null ${extra} -w '${FORMATO}\\n' '${url}'; done`);
  return out.split(/\r?\n/).filter(Boolean).map((l) => {
    const [status, dns, tcp, tls, ttfb, total, bajada, vBajada, subida, vSubida] = l.split(' ').map(Number);
    return { status, dns: r2(dns * 1000), tcp: r2(tcp * 1000), tls: r2(tls ? (tls - tcp) * 1000 : 0), ttfb: r2(ttfb * 1000), ms: r2(total * 1000), bytes: bajada, vBajada, subida, vSubida };
  });
}
function diezDesdeCel(url, etiqueta) {
  const lista = curlCel(url, 10);
  res.http.push({ origen: `Celular (${cel.modelo})`, destino: etiqueta, ruta: new URL(url).pathname + new URL(url).search, solicitudes: lista, ...resumen(lista) });
}

await diezDesdePc(LOCAL, 'API local', '/health');
await diezDesdePc(LOCAL, 'API local');
if (cel.ip) diezDesdeCel(`http://127.0.0.1:3000${LECTURA}`, 'API local por USB');
if (!SIN_PROD) {
  await diezDesdePc(PROD, 'Producción (Vercel + Supabase)');
  if (cel.ip) diezDesdeCel(`${PROD}${LECTURA}`, 'Producción por Wi-Fi');
}

// ── C. Transferencia ─────────────────────────────────────────────────────────
const login = await pedir(`${LOCAL}/api/auth/login`, { method: 'POST', body: { email: 'admin@local.test', password: 'Prueba-12345!' } });
const TOKEN = JSON.parse(login.cuerpo).token;
if (!TOKEN) throw new Error('No se pudo iniciar sesión como admin local: ' + login.cuerpo);
const auth = { authorization: `Bearer ${TOKEN}` };

for (let i = 0; i < 3; i++) {
  const r = await pedir(`${LOCAL}/api/beats`);
  res.transferencia.push({ sentido: 'Descarga', origen: 'PC', destino: 'API local', bytes: r.bytes, ms: r.ms, mbps: mbps(r.bytes, r.ms) });
}
if (cel.ip) {
  for (const r of curlCel('http://127.0.0.1:3000/api/beats', 3)) {
    res.transferencia.push({ sentido: 'Descarga', origen: 'Celular', destino: 'API local por USB', bytes: r.bytes, ms: r.ms, mbps: mbps(r.bytes, r.ms) });
  }
  if (!SIN_PROD) {
    for (const r of curlCel(`${PROD}/api/beats`, 3)) {
      res.transferencia.push({ sentido: 'Descarga', origen: 'Celular', destino: 'Producción por Wi-Fi', bytes: r.bytes, ms: r.ms, mbps: mbps(r.bytes, r.ms) });
    }
  }
}

// Subida: el mismo camino que usa la app para subir un audio (URL firmada → Storage).
const MB = 5;
const archivo = Buffer.alloc(MB * 1024 * 1024, 7);
async function urlFirmada(i) {
  const p = await pedir(`${LOCAL}/api/uploads/presign`, { method: 'POST', headers: auth, body: { bucket: 'beats-audio', contentType: 'audio/mpeg', fileName: `p11-subida-${i}.mp3` } });
  return JSON.parse(p.cuerpo).signedUrl;
}
for (let i = 0; i < 3; i++) {
  const url = await urlFirmada(`pc-${i}`);
  const r = await pedir(url, { method: 'PUT', headers: { 'content-type': 'audio/mpeg', 'content-length': archivo.length }, body: archivo });
  res.transferencia.push({ sentido: 'Subida', origen: 'PC', destino: 'Storage local', status: r.status, bytes: archivo.length, ms: r.ms, mbps: mbps(archivo.length, r.ms) });
}
if (cel.ip) {
  adb(`dd if=/dev/zero of=/data/local/tmp/p11.bin bs=1048576 count=${MB} 2>/dev/null; ls -l /data/local/tmp/p11.bin`);
  for (let i = 0; i < 3; i++) {
    const url = await urlFirmada(`cel-${i}`);
    const [r] = curlCel(url, 1, "-X PUT -H 'Content-Type: audio/mpeg' --data-binary @/data/local/tmp/p11.bin");
    res.transferencia.push({ sentido: 'Subida', origen: 'Celular', destino: 'Storage local por USB', status: r.status, bytes: r.subida, ms: r.ms, mbps: mbps(r.subida, r.ms) });
  }
  adb('rm -f /data/local/tmp/p11.bin');
}

// ── E. Carga controlada ──────────────────────────────────────────────────────
function pidApi() {
  const out = execSync('netstat -ano -p tcp', { encoding: 'utf8' });
  return /:3000\s+\S+\s+LISTENING\s+(\d+)/.exec(out)?.[1] ?? /127\.0\.0\.1:3000\s+0\.0\.0\.0:0\s+\S+\s+(\d+)/.exec(out)?.[1];
}
const PID = pidApi();
function proceso() {
  if (!PID) return null;
  const [cpu, mem] = execSync(`powershell -NoProfile -Command "$p = Get-Process -Id ${PID}; $p.TotalProcessorTime.TotalMilliseconds; $p.WorkingSet64"`, { encoding: 'utf8' }).trim().split(/\r?\n/).map(Number);
  return { cpu, mem };
}
const commits = () => Number(sql(`select xact_commit from pg_stat_database where datname = 'skondit_local'`));

async function escenario(nombre, usuarios, total, hacer) {
  const agente = new http.Agent({ keepAlive: true, maxSockets: usuarios });
  const lista = [];
  let siguiente = 0;
  let conexionesMax = 0;
  const vigia = setInterval(() => {
    try { conexionesMax = Math.max(conexionesMax, Number(sql(`select count(*) from pg_stat_activity where datname = 'skondit_local' and state = 'active'`))); } catch { /* */ }
  }, 300);
  const p0 = proceso();
  const c0 = commits();
  const t0 = performance.now();
  await Promise.all(Array.from({ length: usuarios }, async () => {
    while (siguiente < total) {
      const i = siguiente++;
      lista.push(await hacer(i, agente));
    }
  }));
  const pared = performance.now() - t0;
  clearInterval(vigia);
  const p1 = proceso();
  agente.destroy();
  const ok = lista.filter((x) => x.status >= 200 && x.status < 300);
  const bytes = lista.reduce((s, x) => s + x.bytes, 0);
  res.carga.push({
    endpoint: nombre, usuarios, solicitudes: total, exitosas: ok.length, fallidas: total - ok.length,
    codigos: Object.fromEntries([...new Set(lista.map((x) => x.status))].map((c) => [c, lista.filter((x) => x.status === c).length])),
    ...resumen(lista), p50: r2(pct(lista.map((x) => x.ms), 50)),
    rps: r2(total / (pared / 1000)), mbps: mbps(bytes, pared), kb_por_respuesta: r2(bytes / total / 1024),
    cpu_api_pct: p0 && p1 ? r2(((p1.cpu - p0.cpu) / pared) * 100) : null,
    ram_api_mb: p1 ? r2(p1.mem / 2 ** 20) : null,
    db_transacciones: commits() - c0, db_conexiones_activas_max: conexionesMax,
  });
}
const SOLICITUDES = 40;
for (const u of [1, 5, 10]) {
  await escenario('GET /api/beats?limit=20 (lectura)', u, SOLICITUDES, (i, agent) =>
    pedir(`${LOCAL}/api/beats?limit=20&page=${(i % 50) + 1}`, { agent }));
}
for (const u of [1, 5, 10]) {
  await escenario('POST /api/contact (escritura)', u, SOLICITUDES, (i, agent) =>
    pedir(`${LOCAL}/api/contact`, {
      method: 'POST', agent, headers: { 'idempotency-key': randomUUID() },
      body: { nombre: 'P11 Carga', email: 'carga.p11@local.test', mensaje: `Prueba de carga controlada #${i}`, asunto: 'P11 carga' },
    }));
}
const creados = Number(sql(`select count(*) from contact_messages where asunto = 'P11 carga'`));
res.carga_tickets_creados = creados;
sql(`delete from contact_messages where asunto = 'P11 carga'`);

// ── Reporte ──────────────────────────────────────────────────────────────────
mkdirSync(SALIDA, { recursive: true });
writeFileSync(join(SALIDA, 'red.json'), JSON.stringify(res, (k, v) => (k === 'cuerpo' ? undefined : v), 2));
const t = (cab, filas) => [`| ${cab.join(' | ')} |`, `|${cab.map(() => '---').join('|')}|`, ...filas.map((f) => `| ${f.join(' | ')} |`)].join('\n');
const md = [
  `# Práctica 11 · Fase 5 — Conectividad y rendimiento (${res.fecha})`, '',
  '```', JSON.stringify(res.entorno, null, 2), '```', '',
  '## A. Ping (ICMP, 20 paquetes)', '',
  t(['Origen', 'Destino', 'Recibidos', 'Pérdida %', 'Mín ms', 'Prom ms', 'Máx ms', 'Desv ms'],
    res.ping.map((p) => [p.origen, p.destino, `${p.recibidos}/20`, p.perdida_pct, p.min ?? '—', p.promedio ?? '—', p.max ?? '—', p.desv ?? '—'])), '',
  '## B. Latencia HTTP (10 solicitudes consecutivas)', '',
  t(['Origen', 'Destino', 'Ruta', 'Mín', 'Prom', 'Máx', 'Desv', 'P95'], res.http.map((h) => [h.origen, h.destino, h.ruta, h.min, h.promedio, h.max, h.desv, h.p95])), '',
  ...res.http.flatMap((h) => [`### ${h.origen} → ${h.destino} ${h.ruta}`, '',
    t(['#', 'HTTP', 'Total ms', 'TTFB ms', 'DNS ms', 'TCP ms', 'TLS ms', 'Bytes'], h.solicitudes.map((s, i) => [i + 1, s.status, s.ms, s.ttfb, s.dns, s.tcp, s.tls, s.bytes])), '']),
  '## C. Transferencia', '',
  t(['Sentido', 'Origen', 'Destino', 'Bytes', 'Tiempo ms', 'Mbps'], res.transferencia.map((x) => [x.sentido, x.origen, x.destino, x.bytes, x.ms, x.mbps])), '',
  '## D. Consistencia de las 10 respuestas', '',
  t(['Destino', 'Ruta', 'Códigos', 'Cuerpos distintos', 'Estructura', 'Bytes'], res.consistencia.map((c) => [c.destino, c.ruta, c.codigos.join(','), c.cuerpos_distintos, c.estructura.join(' / '), c.bytes.join(',')])), '',
  '## E. Carga controlada (40 solicitudes por escenario)', '',
  t(['Endpoint', 'Usuarios', 'OK', 'Fallidas', 'Prom ms', 'P50', 'P95', 'Máx', 'Req/s', 'Mbps', 'CPU API %', 'RAM API MB', 'Tx BD', 'Conex. BD máx'],
    res.carga.map((c) => [c.endpoint, c.usuarios, c.exitosas, c.fallidas, c.promedio, c.p50, c.p95, c.max, c.rps, c.mbps, c.cpu_api_pct, c.ram_api_mb, c.db_transacciones, c.db_conexiones_activas_max])), '',
  `Tickets creados por la carga de escritura: ${res.carga_tickets_creados} (se borraron al terminar).`, '',
].join('\n');
writeFileSync(join(SALIDA, 'red.md'), md);
console.log(md);

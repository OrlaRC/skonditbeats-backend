// Práctica 11 · Fase 3: matriz de códigos HTTP contra la API local REAL (como una
// colección de Postman, pero reproducible). Crea solo datos de prueba "P11 " y los borra.
//   node scripts/p11/codigos.mjs   → scripts/p11/resultados/codigos.md y codigos.json
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const API = process.env.API ?? 'http://127.0.0.1:3000/api';
const PSQL = join(process.env.PG_BIN ?? 'D:\\PostgreSQL\\16\\bin', 'psql');
const sql = (t) => execFileSync(PSQL, ['-U', 'postgres', '-h', '127.0.0.1', '-d', 'skondit_local', '-X', '-At', '-c', t], { encoding: 'utf8' }).trim();

const filas = [];
async function caso(codigo, situacion, metodo, ruta, { token, body, headers = {} } = {}) {
  const t0 = performance.now();
  const r = await fetch(API + ruta, {
    method: metodo,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const texto = await r.text();
  const ms = Math.round((performance.now() - t0) * 10) / 10;
  const sensible = /"password"|\$2[ab]\$|service_role|PGRST|stack/i.test(texto);
  filas.push({ esperado: codigo, obtenido: r.status, situacion, peticion: `${metodo} /api${ruta.split('?')[0]}`, ms, bytes: Buffer.byteLength(texto), cuerpo: texto.slice(0, 110), sensible, cumple: r.status === codigo && !sensible });
  try { return JSON.parse(texto); } catch { return null; }
}

const login = async (email) => (await (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Prueba-12345!' }) })).json());
const admin = (await login('admin@local.test')).token;
// El cliente entra con OTP; en local la API devuelve el código en otpDev.
const paso1 = await login('cliente@local.test');
const cliente = (await (await fetch(`${API}/auth/verify-otp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: paso1.email, code: paso1.otpDev }) })).json()).token;
if (!admin || !cliente) throw new Error('No se pudo iniciar sesión con las cuentas de prueba');

const beatActivo = sql(`select id from beats where activo order by created_at desc limit 1`);
const comprado = sql(`select i.beat_id from order_items i join orders o on o.id = i.order_id join users u on u.id = o.user_id
  join beats b on b.id = i.beat_id where u.email = 'cliente@local.test' and o.status = 'COMPLETADO' and b.activo limit 1`);

await caso(200, 'Consulta exitosa (catálogo paginado)', 'GET', '/beats?limit=20&page=1');
await caso(200, 'Consulta por id existente', 'GET', `/beats/${beatActivo}`);
const nuevo = await caso(201, 'Registro creado (beat, admin)', 'POST', '/beats', { token: admin, body: { nombre: 'P11 Beat HTTP', genero: 'Trap', bpm: 140, precio: 199 } });
await caso(201, 'Registro creado (ticket de contacto)', 'POST', '/contact', { body: { nombre: 'P11 Codigos', email: 'p11@local.test', mensaje: 'Prueba de la matriz de códigos HTTP', asunto: 'P11 codigos' }, headers: { 'idempotency-key': randomUUID() } });
await caso(204, 'Eliminación sin cuerpo de respuesta', 'DELETE', `/beats/${nuevo?.beat?.id}`, { token: admin });
await caso(404, 'Consulta después de eliminar', 'GET', `/beats/${nuevo?.beat?.id}`);
await caso(400, 'Datos mal estructurados (beats no es arreglo)', 'POST', '/orders', { token: cliente, body: { beats: { a: 1 } } });
await caso(400, 'Datos mal estructurados (correo inválido)', 'POST', '/contact', { body: { nombre: 'P11', email: 'nope', mensaje: 'Mensaje de prueba P11' } });
await caso(401, 'Usuario no autenticado (sin token)', 'GET', '/orders/mis-compras');
await caso(401, 'Token falso', 'GET', '/orders/mis-compras', { token: 'token.falso.x' });
await caso(401, 'Contraseña incorrecta', 'POST', '/auth/login', { body: { email: 'admin2@local.test', password: 'incorrecta' } });
await caso(403, 'Usuario sin permisos (cliente → /users)', 'GET', '/users', { token: cliente });
await caso(403, 'Usuario sin permisos (cliente borra un beat)', 'DELETE', `/beats/${beatActivo}`, { token: cliente });
await caso(404, 'Recurso inexistente (UUID válido)', 'GET', '/beats/00000000-0000-4000-8000-000000000000');
await caso(404, 'Ruta inexistente', 'GET', '/no-existe');
await caso(409, 'Conflicto: beat ya comprado', 'POST', '/orders', { token: cliente, body: { beats: [comprado] } });
await caso(422, 'Validación semántica: beat inexistente', 'POST', '/orders', { token: cliente, body: { beats: ['00000000-0000-4000-8000-000000000000'] } });
await caso(422, 'Validación semántica: BPM fuera de rango', 'POST', '/beats', { token: admin, body: { nombre: 'P11 X', genero: 'Trap', bpm: 999, precio: 1 } });

// 500 (base caída) se mide aparte deteniendo PostgREST; ver resultados/codigos.md.

sql(`delete from contact_messages where asunto = 'P11 codigos'; delete from beats where nombre like 'P11 %'`);

mkdirSync(join(AQUI, 'resultados'), { recursive: true });
writeFileSync(join(AQUI, 'resultados', 'codigos.json'), JSON.stringify(filas, null, 2));
const md = ['| Esperado | Obtenido | Situación | Petición | ms | Bytes | Datos sensibles | Cumple |', '|---|---|---|---|---:|---:|---|:---:|',
  ...filas.map((f) => `| ${f.esperado} | ${f.obtenido} | ${f.situacion} | ${f.peticion} | ${f.ms} | ${f.bytes} | ${f.sensible ? 'SÍ' : 'no'} | ${f.cumple ? '✅' : '❌'} |`)].join('\n');
writeFileSync(join(AQUI, 'resultados', 'codigos.md'), md);
console.log(md);
console.log(`\n${filas.filter((f) => f.cumple).length}/${filas.length} casos cumplen`);

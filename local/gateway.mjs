// "Supabase local" para pruebas sin internet: escucha en un solo puerto, igual que
// un proyecto de Supabase, y la API se conecta cambiando solo SUPABASE_URL.
//
//   /rest/v1/*     → PostgREST (el mismo motor que usa Supabase) sobre el PostgreSQL local
//   /storage/v1/*  → emulador de Storage en disco: URL firmadas, subida directa,
//                    subida reanudable (TUS) y descarga pública con Range
//
//   node local/gateway.mjs        (lo arranca local/iniciar.ps1)
//
// Para probar cortes de red sin desconectar nada:
//   FALLA_SUBIDA_BYTES=300000  corta cada PATCH/PUT de subida al llegar a esos bytes
//   LATENCIA_MS=800            retrasa todas las respuestas
import { createServer, request as httpRequest } from 'node:http';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const PUERTO = Number(process.env.GATEWAY_PORT ?? 54321);
const POSTGREST = Number(process.env.POSTGREST_PORT ?? 54322);
const DISCO = join(AQUI, 'storage');
const TEMPORALES = join(DISCO, '.tus');
const FALLA_SUBIDA = Number(process.env.FALLA_SUBIDA_BYTES ?? 0);
const LATENCIA = Number(process.env.LATENCIA_MS ?? 0);

mkdirSync(TEMPORALES, { recursive: true });

const MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

const json = (res, status, cuerpo, cabeceras = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...cabeceras });
  res.end(JSON.stringify(cuerpo));
};

/** Ruta en disco de un objeto, sin dejar salir de la carpeta de storage. */
function rutaObjeto(bucket, nombre) {
  const ruta = normalize(join(DISCO, bucket, nombre));
  if (!ruta.startsWith(DISCO)) throw new Error('ruta inválida');
  mkdirSync(dirname(ruta), { recursive: true });
  return ruta;
}

/** Escribe el cuerpo de la petición en `destino` y resuelve con los bytes recibidos. */
function recibir(req, destino, flags) {
  return new Promise((resolve) => {
    const salida = createWriteStream(destino, { flags });
    let recibidos = 0;
    let cortado = false;
    req.on('data', (trozo) => {
      if (cortado) return;
      if (FALLA_SUBIDA && recibidos + trozo.length > FALLA_SUBIDA) {
        // Corte simulado: se guarda lo que cabía y se tira la conexión.
        const resto = trozo.subarray(0, FALLA_SUBIDA - recibidos);
        recibidos += resto.length;
        cortado = true;
        salida.end(resto, () => {
          req.socket.destroy();
          resolve({ recibidos, cortado });
        });
        return;
      }
      recibidos += trozo.length;
      salida.write(trozo);
    });
    req.on('end', () => { if (!cortado) salida.end(() => resolve({ recibidos, cortado })); });
    req.on('close', () => { if (!cortado && !req.complete) salida.end(() => resolve({ recibidos, cortado: true })); });
  });
}

const meta = (id) => join(TEMPORALES, `${id}.json`);
const datos = (id) => join(TEMPORALES, `${id}.bin`);

async function storage(req, res, url) {
  const ruta = decodeURIComponent(url.pathname.replace('/storage/v1', ''));

  // ── URL firmada de subida (lo que pide supabase-js en createSignedUploadUrl) ──
  let m = /^\/object\/upload\/sign\/([^/]+)\/(.+)$/.exec(ruta);
  if (m && req.method === 'POST') {
    return json(res, 200, { url: `/object/upload/sign/${m[1]}/${encodeURI(m[2])}?token=local-${randomUUID()}` });
  }
  if (m && req.method === 'PUT') {
    if (!url.searchParams.get('token')) return json(res, 400, { error: 'falta el token' });
    const r = await recibir(req, rutaObjeto(m[1], m[2]), 'w');
    if (r.cortado) return;
    return json(res, 200, { Key: `${m[1]}/${m[2]}` });
  }

  // ── Subida reanudable (TUS 1.0.0) ───────────────────────────────────────────
  const tus = { 'tus-resumable': '1.0.0', 'access-control-expose-headers': 'Location, Upload-Offset, Upload-Length' };
  if (ruta === '/upload/resumable' && req.method === 'POST') {
    if (!req.headers['x-signature'] && !req.headers.authorization) return json(res, 403, { error: 'sin firma' }, tus);
    const campos = Object.fromEntries(
      String(req.headers['upload-metadata'] ?? '').split(',').filter(Boolean).map((par) => {
        const [k, v] = par.trim().split(' ');
        return [k, Buffer.from(v ?? '', 'base64').toString('utf8')];
      }),
    );
    const total = Number(req.headers['upload-length']);
    if (!campos.bucketName || !campos.objectName || !Number.isFinite(total)) return json(res, 400, { error: 'metadatos incompletos' }, tus);
    const id = randomUUID();
    writeFileSync(meta(id), JSON.stringify({ bucket: campos.bucketName, nombre: campos.objectName, total }));
    writeFileSync(datos(id), '');
    res.writeHead(201, { ...tus, location: `http://${req.headers.host}/storage/v1/upload/resumable/${id}` });
    return res.end();
  }
  m = /^\/upload\/resumable\/([0-9a-f-]{36})$/.exec(ruta);
  if (m) {
    const id = m[1];
    if (!existsSync(meta(id))) return json(res, 404, { error: 'la subida no existe o expiró' }, tus);
    const info = JSON.parse(readFileSync(meta(id), 'utf8'));
    const offset = info.completo ? info.total : statSync(datos(id)).size;

    if (req.method === 'HEAD') {
      res.writeHead(200, { ...tus, 'upload-offset': offset, 'upload-length': info.total, 'cache-control': 'no-store' });
      return res.end();
    }
    if (req.method === 'PATCH') {
      if (Number(req.headers['upload-offset']) !== offset) return json(res, 409, { error: 'offset distinto al del servidor' }, tus);
      const r = await recibir(req, datos(id), 'a');
      if (r.cortado) return;
      const nuevo = offset + r.recibidos;
      if (nuevo >= info.total) {
        renameSync(datos(id), rutaObjeto(info.bucket, info.nombre));
        writeFileSync(meta(id), JSON.stringify({ ...info, completo: true }));
      }
      res.writeHead(204, { ...tus, 'upload-offset': nuevo });
      return res.end();
    }
  }

  // ── Descarga pública, con soporte de Range para reanudar descargas ──────────
  m = /^\/object\/public\/([^/]+)\/(.+)$/.exec(ruta);
  if (m && (req.method === 'GET' || req.method === 'HEAD')) {
    const archivo = rutaObjeto(m[1], m[2]);
    if (!existsSync(archivo)) return json(res, 404, { error: 'Object not found' });
    const { size, mtimeMs } = statSync(archivo);
    const etag = `"${size}-${Math.round(mtimeMs)}"`;
    const base = {
      'content-type': MIME[archivo.split('.').pop().toLowerCase()] ?? 'application/octet-stream',
      'accept-ranges': 'bytes',
      etag,
    };
    const rango = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    // If-Range: si el archivo cambió desde que se empezó a bajar, se manda completo.
    const vigente = !req.headers['if-range'] || req.headers['if-range'] === etag;
    if (rango && vigente) {
      const inicio = Number(rango[1]);
      const fin = rango[2] ? Math.min(Number(rango[2]), size - 1) : size - 1;
      if (inicio >= size) {
        res.writeHead(416, { ...base, 'content-range': `bytes */${size}` });
        return res.end();
      }
      res.writeHead(206, { ...base, 'content-range': `bytes ${inicio}-${fin}/${size}`, 'content-length': fin - inicio + 1 });
      return req.method === 'HEAD' ? res.end() : createReadStream(archivo, { start: inicio, end: fin }).pipe(res);
    }
    res.writeHead(200, { ...base, 'content-length': size });
    return req.method === 'HEAD' ? res.end() : createReadStream(archivo).pipe(res);
  }

  return json(res, 404, { error: `storage local: ${req.method} ${ruta} no está emulado` });
}

function rest(req, res, url) {
  // PostgREST corre con un rol fijo (equivalente a service_role): no recibe llaves.
  const { authorization, apikey, host, ...cabeceras } = req.headers;
  const proxy = httpRequest(
    { host: '127.0.0.1', port: POSTGREST, method: req.method, path: url.pathname.replace('/rest/v1', '') + url.search, headers: cabeceras },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    },
  );
  proxy.on('error', () => json(res, 503, { message: 'PostgREST no responde: ¿corriste local/iniciar.ps1?' }));
  req.pipe(proxy);
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://local');
  const atender = () => {
    if (url.pathname.startsWith('/rest/v1')) return rest(req, res, url);
    if (url.pathname.startsWith('/storage/v1')) {
      return storage(req, res, url).catch((e) => json(res, 500, { error: String(e?.message ?? e) }));
    }
    return json(res, 200, { servicio: 'supabase local', rest: `:${POSTGREST}`, storage: DISCO });
  };
  LATENCIA ? setTimeout(atender, LATENCIA) : atender();
}).listen(PUERTO, '127.0.0.1', () => {
  console.log(`Supabase local en http://127.0.0.1:${PUERTO}  (REST → :${POSTGREST}, Storage → ${DISCO})`);
});

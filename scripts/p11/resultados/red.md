# Práctica 11 · Fase 5 — Conectividad y rendimiento (2026-11-12T00:59:31.703Z)

```
{
  "pc": "Windows_NT 10.0.26200 · 11th Gen Intel(R) Core(TM) i5-11400H @ 2.70GHz · 12 hilos · 32 GB",
  "node": "v20.20.1",
  "pc_wifi": "10.13.40.1",
  "celular": {
    "modelo": "FRL-L23",
    "android": "10",
    "ip": "10.13.39.141",
    "gateway": "10.13.63.250"
  },
  "conexion_cel_api": "USB (adb reverse tcp:3000 → PC)",
  "api_local": "http://127.0.0.1:3000",
  "produccion": "https://skonditbeats-backend.vercel.app",
  "commit_api": "de485cb",
  "commit_app": "f99209c"
}
```

## A. Ping (ICMP, 20 paquetes)

| Origen | Destino | Recibidos | Pérdida % | Mín ms | Prom ms | Máx ms | Desv ms |
|---|---|---|---|---|---|---|---|
| Celular | Router Wi-Fi (10.13.63.250) | 20/20 | 0 | 2.252 | 4.071 | 8.277 | 1.734 |
| Celular | PC con la API (10.13.40.1) | 0/20 | 100 | — | — | — | — |
| Celular | Producción (Vercel) (skonditbeats-backend.vercel.app) | 20/20 | 0 | 27.013 | 29.915 | 36.559 | 2.252 |

## B. Latencia HTTP (10 solicitudes consecutivas)

| Origen | Destino | Ruta | Mín | Prom | Máx | Desv | P95 |
|---|---|---|---|---|---|---|---|
| PC | API local | /health | 1.13 | 2.33 | 8.86 | 2.19 | 8.86 |
| PC | API local | /api/beats?limit=20&page=1 | 4.75 | 6.65 | 11.21 | 1.64 | 11.21 |
| Celular (FRL-L23) | API local por USB | /api/beats?limit=20&page=1 | 8.24 | 9.52 | 11.93 | 1.02 | 11.93 |
| PC | Producción (Vercel + Supabase) | /api/beats?limit=20&page=1 | 267.69 | 317.28 | 378.15 | 29.36 | 378.15 |
| Celular (FRL-L23) | Producción por Wi-Fi | /api/beats?limit=20&page=1 | 376.9 | 401.5 | 434.8 | 22.47 | 434.8 |

### PC → API local /health

| # | HTTP | Total ms | TTFB ms | DNS ms | TCP ms | TLS ms | Bytes |
|---|---|---|---|---|---|---|---|
| 1 | 200 | 8.86 | 8.02 | 0 | 5.69 | 0 | 47 |
| 2 | 200 | 2.11 | 2.01 | 0 | 1.48 | 0 | 47 |
| 3 | 200 | 1.4 | 1.17 | 0 | 0.64 | 0 | 47 |
| 4 | 200 | 1.6 | 1.49 | 0 | 0.88 | 0 | 47 |
| 5 | 200 | 1.53 | 1.43 | 0 | 0.85 | 0 | 47 |
| 6 | 200 | 1.61 | 1.52 | 0 | 0.77 | 0 | 47 |
| 7 | 200 | 1.13 | 1.06 | 0 | 0.66 | 0 | 47 |
| 8 | 200 | 1.41 | 1.3 | 0 | 0.72 | 0 | 47 |
| 9 | 200 | 1.86 | 1.71 | 0 | 1.18 | 0 | 47 |
| 10 | 200 | 1.75 | 1.59 | 0 | 1.14 | 0 | 47 |

### PC → API local /api/beats?limit=20&page=1

| # | HTTP | Total ms | TTFB ms | DNS ms | TCP ms | TLS ms | Bytes |
|---|---|---|---|---|---|---|---|
| 1 | 200 | 7.15 | 7.03 | 0 | 0.84 | 0 | 5634 |
| 2 | 200 | 6.69 | 6.56 | 0 | 1.03 | 0 | 5634 |
| 3 | 200 | 6.41 | 6.25 | 0 | 0.83 | 0 | 5634 |
| 4 | 200 | 6.46 | 6.28 | 0 | 0.85 | 0 | 5634 |
| 5 | 200 | 6.48 | 6.37 | 0 | 0.89 | 0 | 5634 |
| 6 | 200 | 5.84 | 5.76 | 0 | 0.8 | 0 | 5634 |
| 7 | 200 | 5.81 | 5.72 | 0 | 0.76 | 0 | 5634 |
| 8 | 200 | 11.21 | 11.11 | 0 | 0.91 | 0 | 5634 |
| 9 | 200 | 5.71 | 5.57 | 0 | 1 | 0 | 5634 |
| 10 | 200 | 4.75 | 4.66 | 0 | 0.74 | 0 | 5634 |

### Celular (FRL-L23) → API local por USB /api/beats?limit=20&page=1

| # | HTTP | Total ms | TTFB ms | DNS ms | TCP ms | TLS ms | Bytes |
|---|---|---|---|---|---|---|---|
| 1 | 200 | 11.93 | 11.72 | 0.18 | 3.9 | 0 | 5634 |
| 2 | 200 | 10.14 | 9.98 | 0.08 | 1.59 | 0 | 5634 |
| 3 | 200 | 8.24 | 7.98 | 0.08 | 1.63 | 0 | 5634 |
| 4 | 200 | 8.4 | 8.06 | 0.08 | 1.61 | 0 | 5634 |
| 5 | 200 | 10.19 | 10.06 | 0.08 | 1.52 | 0 | 5634 |
| 6 | 200 | 9.19 | 8.92 | 0.07 | 1.32 | 0 | 5634 |
| 7 | 200 | 8.94 | 8.72 | 0.09 | 1.29 | 0 | 5634 |
| 8 | 200 | 9.81 | 9.66 | 0.07 | 1.3 | 0 | 5634 |
| 9 | 200 | 9.43 | 9.29 | 0.13 | 1.44 | 0 | 5634 |
| 10 | 200 | 8.91 | 8.56 | 0.07 | 1.23 | 0 | 5634 |

### PC → Producción (Vercel + Supabase) /api/beats?limit=20&page=1

| # | HTTP | Total ms | TTFB ms | DNS ms | TCP ms | TLS ms | Bytes |
|---|---|---|---|---|---|---|---|
| 1 | 200 | 378.15 | 375.24 | 69.42 | 30.21 | 104.14 | 3285 |
| 2 | 200 | 322.65 | 320.26 | 1.32 | 29.15 | 102.73 | 3285 |
| 3 | 200 | 318.51 | 318.2 | 1.08 | 28.28 | 100.58 | 3285 |
| 4 | 200 | 282.86 | 273.61 | 1.28 | 40.97 | 102.8 | 3285 |
| 5 | 200 | 332.68 | 330.35 | 1.12 | 36.01 | 154.35 | 3285 |
| 6 | 200 | 319.53 | 317.99 | 1.03 | 31.62 | 131.52 | 3285 |
| 7 | 200 | 291.86 | 291.65 | 1.14 | 29.23 | 103.65 | 3285 |
| 8 | 200 | 334.69 | 330.75 | 3.64 | 28.77 | 123.66 | 3285 |
| 9 | 200 | 267.69 | 263.99 | 1.2 | 32.47 | 103.02 | 3285 |
| 10 | 200 | 324.14 | 320.28 | 1.19 | 28.21 | 130.68 | 3285 |

### Celular (FRL-L23) → Producción por Wi-Fi /api/beats?limit=20&page=1

| # | HTTP | Total ms | TTFB ms | DNS ms | TCP ms | TLS ms | Bytes |
|---|---|---|---|---|---|---|---|
| 1 | 200 | 423.59 | 422.94 | 4.43 | 66.03 | 206.01 | 3285 |
| 2 | 200 | 377.62 | 377.03 | 7.67 | 69.73 | 171.62 | 3285 |
| 3 | 200 | 388.01 | 387.35 | 4.24 | 63.14 | 180.2 | 3285 |
| 4 | 200 | 391.76 | 391.08 | 3.14 | 65.35 | 178.16 | 3285 |
| 5 | 200 | 383.56 | 381.7 | 4.19 | 62.3 | 174.02 | 3285 |
| 6 | 200 | 431.26 | 430.43 | 4.2 | 62.73 | 181.13 | 3285 |
| 7 | 200 | 376.9 | 376.49 | 4.22 | 63.13 | 175.7 | 3285 |
| 8 | 200 | 423.5 | 423 | 3.01 | 82.28 | 198.76 | 3285 |
| 9 | 200 | 434.8 | 434.35 | 4.22 | 82.55 | 180.8 | 3285 |
| 10 | 200 | 383.99 | 383.44 | 4.2 | 66.85 | 177.94 | 3285 |

## C. Transferencia

| Sentido | Origen | Destino | Bytes | Tiempo ms | Mbps |
|---|---|---|---|---|---|
| Descarga | PC | API local | 1345774 | 38.75 | 277.84 |
| Descarga | PC | API local | 1345774 | 38.91 | 276.69 |
| Descarga | PC | API local | 1345774 | 35.22 | 305.68 |
| Descarga | Celular | API local por USB | 1345774 | 134.2 | 80.22 |
| Descarga | Celular | API local por USB | 1345774 | 129.13 | 83.37 |
| Descarga | Celular | API local por USB | 1345774 | 134.71 | 79.92 |
| Descarga | Celular | Producción por Wi-Fi | 3265 | 395 | 0.07 |
| Descarga | Celular | Producción por Wi-Fi | 3265 | 388.09 | 0.07 |
| Descarga | Celular | Producción por Wi-Fi | 3265 | 439.74 | 0.06 |
| Subida | PC | Storage local | 5242880 | 249.37 | 168.2 |
| Subida | PC | Storage local | 5242880 | 243.85 | 172 |
| Subida | PC | Storage local | 5242880 | 202.66 | 206.96 |
| Subida | Celular | Storage local por USB | 5242880 | 398.89 | 105.15 |
| Subida | Celular | Storage local por USB | 5242880 | 390.43 | 107.43 |
| Subida | Celular | Storage local por USB | 5242880 | 378.28 | 110.88 |

## D. Consistencia de las 10 respuestas

| Destino | Ruta | Códigos | Cuerpos distintos | Estructura | Bytes |
|---|---|---|---|---|---|
| API local | /health | 200 | 10 | status,ts | 47 |
| API local | /api/beats?limit=20&page=1 | 200 | 1 | beats,generos,limit,page,total | 5634 |
| Producción (Vercel + Supabase) | /api/beats?limit=20&page=1 | 200 | 1 | beats,generos,limit,page,total | 3285 |

## E. Carga controlada (40 solicitudes por escenario)

| Endpoint | Usuarios | OK | Fallidas | Prom ms | P50 | P95 | Máx | Req/s | Mbps | CPU API % | RAM API MB | Tx BD | Conex. BD máx |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| GET /api/beats?limit=20 (lectura) | 1 | 40 | 0 | 4.43 | 2.91 | 4.8 | 54.79 | 220.4 | 10.04 | 17.22 | 80.35 | 11 | 1 |
| GET /api/beats?limit=20 (lectura) | 5 | 40 | 0 | 12.98 | 6.03 | 54 | 79.96 | 371.49 | 16.91 | 72.56 | 82.11 | 5 | 1 |
| GET /api/beats?limit=20 (lectura) | 10 | 40 | 0 | 24.74 | 11.9 | 69.39 | 93.36 | 394.29 | 17.95 | 61.61 | 83.39 | 81 | 1 |
| POST /api/contact (escritura) | 1 | 40 | 0 | 7.2 | 4.79 | 18.93 | 48.36 | 137 | 0.14 | 16.05 | 84.04 | 19 | 1 |
| POST /api/contact (escritura) | 5 | 40 | 0 | 14.96 | 7.44 | 53.54 | 59.28 | 323.68 | 0.34 | 101.15 | 84.61 | 79 | 1 |
| POST /api/contact (escritura) | 10 | 40 | 0 | 22.63 | 13.01 | 56.34 | 59.93 | 419.38 | 0.44 | 81.91 | 86.25 | 18 | 1 |

Tickets creados por la carga de escritura: 120 (se borraron al terminar).

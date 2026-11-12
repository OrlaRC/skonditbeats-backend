| Esperado | Obtenido | Situación | Petición | ms | Bytes | Datos sensibles | Cumple |
|---|---|---|---|---:|---:|---|:---:|
| 200 | 200 | Consulta exitosa (catálogo paginado) | GET /api/beats | 17.4 | 5634 | no | ✅ |
| 200 | 200 | Consulta por id existente | GET /api/beats/efa1abfe-dca5-4005-8417-082636c926c9 | 4.4 | 281 | no | ✅ |
| 201 | 201 | Registro creado (beat, admin) | POST /api/beats | 14.1 | 300 | no | ✅ |
| 201 | 201 | Registro creado (ticket de contacto) | POST /api/contact | 8.9 | 132 | no | ✅ |
| 204 | 204 | Eliminación sin cuerpo de respuesta | DELETE /api/beats/26345113-8690-432c-9b4a-075ae63315ee | 13.1 | 0 | no | ✅ |
| 404 | 404 | Consulta después de eliminar | GET /api/beats/26345113-8690-432c-9b4a-075ae63315ee | 3.9 | 30 | no | ✅ |
| 400 | 400 | Datos mal estructurados (beats no es arreglo) | POST /api/orders | 1.9 | 105 | no | ✅ |
| 400 | 400 | Datos mal estructurados (correo inválido) | POST /api/contact | 1.4 | 153 | no | ✅ |
| 401 | 401 | Usuario no autenticado (sin token) | GET /api/orders/mis-compras | 1 | 38 | no | ✅ |
| 401 | 401 | Token falso | GET /api/orders/mis-compras | 1.1 | 38 | no | ✅ |
| 401 | 401 | Contraseña incorrecta | POST /api/auth/login | 74.8 | 35 | no | ✅ |
| 403 | 403 | Usuario sin permisos (cliente → /users) | GET /api/users | 4.2 | 27 | no | ✅ |
| 403 | 403 | Usuario sin permisos (cliente borra un beat) | DELETE /api/beats/efa1abfe-dca5-4005-8417-082636c926c9 | 3.3 | 27 | no | ✅ |
| 404 | 404 | Recurso inexistente (UUID válido) | GET /api/beats/00000000-0000-4000-8000-000000000000 | 3.3 | 30 | no | ✅ |
| 404 | 404 | Ruta inexistente | GET /api/no-existe | 1.1 | 85 | no | ✅ |
| 409 | 409 | Conflicto: beat ya comprado | POST /api/orders | 16.2 | 47 | no | ✅ |
| 422 | 422 | Validación semántica: beat inexistente | POST /api/orders | 5.4 | 65 | no | ✅ |
| 422 | 422 | Validación semántica: BPM fuera de rango | POST /api/beats | 3.6 | 51 | no | ✅ |
## 500 en vivo: PostgREST detenido (la API no alcanza la base) — 2026-11-11

| Esperado | Obtenido | Situación | Petición | Tiempo | Bytes | Cuerpo |
|---|---|---|---|---|---:|---|
| 500 | 500 | Error inesperado del servidor (base caída) | GET /api/beats/efa1abfe-… | 7.05 s | 36 | {"error":"Error al obtener el beat"} |
| 500 | 500 | Error inesperado del servidor (base caída) | GET /api/beats?limit=20&page=1 | 7.05 s | 38 | {"error":"Error al obtener los beats"} |
| 200 | 200 | PostgREST restaurado | GET /api/beats/efa1abfe-… | 0.012 s | — | — |

Antes de DEF-05 el primer caso respondía 404 «Beat no encontrado». Los 7 s son el tiempo que tarda
el gateway local en rendirse al no poder conectar con PostgREST.

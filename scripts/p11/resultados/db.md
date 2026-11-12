# Práctica 11 · Fase 4 — Base de datos (2026-11-12T00:34:49.841Z)

Motor: PostgreSQL 16.11, compiled by Visual C++ build 1944, 64-bit

## Operaciones

| ID | Operación | Tiempo (ms) | Resultado | Cumple |
|---|---|---:|---|:---:|
| DB-01 | Inserción de un beat válido | 8.542 | id = 8c4dfcf3-ab09-4c7b-8600-f6ec8081a0a6 | ✅ |
| DB-02 | Inserción con datos inválidos | — | 12/12 rechazados con el SQLSTATE esperado | ✅ |
| DB-03a | Consulta por id existente | 5.26 | 1 fila | ✅ |
| DB-03b | Consulta por id inexistente | 4.395 | 0 filas (la API responde 404) | ✅ |
| DB-04 | Actualización del precio | 9.371 | precio devuelto 349.00; leído en otra conexión 349.00 | ✅ |
| DB-05a | Eliminar un beat ya vendido | — | rechazado 23503 (23503) | ✅ |
| DB-05b | Eliminar la orden (cascada a renglones) | 11.792 | renglones que quedan: 0 | ✅ |
| DB-05c | Eliminar el beat sin ventas y consultar después | 13.933 | filas tras borrar: 0 | ✅ |
| DB-07 | Intento de inyección como parámetro | 3.878 | filas: 0 | ✅ |

## Restricciones

| Tipo | Caso | SQLSTATE esperado | Obtenido | Mensaje | Cumple |
|---|---|---|---|---|:---:|
| NOT NULL | beat sin nombre | 23502 | 23502 | el valor nulo en la columna «nombre» de la relación «beats» viola la restricción de no nul | ✅ |
| NOT NULL | orden sin usuario | 23502 | 23502 | el valor nulo en la columna «user_id» de la relación «orders» viola la restricción de no n | ✅ |
| CHECK | bpm = 300 (fuera de 1..299) | 23514 | 23514 | el nuevo registro para la relación «beats» viola la restricción «check» «beats_bpm_check» | ✅ |
| CHECK | bpm = 0 | 23514 | 23514 | el nuevo registro para la relación «beats» viola la restricción «check» «beats_bpm_check» | ✅ |
| CHECK | precio negativo | 23514 | 23514 | el nuevo registro para la relación «beats» viola la restricción «check» «beats_precio_chec | ✅ |
| TIPO | precio con 9 dígitos enteros (numeric(10,2)) | 22003 | 22003 | desbordamiento de campo numeric | ✅ |
| TIPO | nombre de 151 caracteres (varchar(150)) | 22001 | 22001 | el valor es demasiado largo para el tipo character varying(150) | ✅ |
| UNIQUE | correo de usuario repetido | 23505 | 23505 | llave duplicada viola restricción de unicidad «users_email_key» | ✅ |
| FK | orden de un usuario inexistente | 23503 | 23503 | inserción o actualización en la tabla «orders» viola la llave foránea «orders_user_id_fkey | ✅ |
| FK | renglón con beat inexistente | 23503 | 23503 | inserción o actualización en la tabla «order_items» viola la llave foránea «order_items_be | ✅ |
| ENUM | estado de orden inválido | 22P02 | 22P02 | la sintaxis de entrada no es válida para el enum order_status: «REGALADO» | ✅ |
| TIPO | id que no es UUID | 22P02 | 22P02 | la sintaxis de entrada no es válida para tipo uuid: «abc» | ✅ |

## Transacción

- Con BEGIN/COMMIT, si el renglón falla: órdenes que quedan = **0**
- Sin transacción (como la API, dos llamadas): órdenes huérfanas = **1**

## Consultas (EXPLAIN ANALYZE, mediana de 7)

| ID | Consulta | Ejecución ms | Planeación ms | Mín–Máx | Filas | Bytes | Índices | Plan |
|---|---|---:|---:|---|---:|---:|---|---|
| Q1 | Beat por id (GET /beats/:id) | 0.117 | 4.147 | 0.108–0.127 | 1 | 362 | beats_pkey | Index Scan (beats_pkey) |
| Q2 | Primera página del catálogo (GET /beats?limit=20) | 0.11 | 4.319 | 0.096–0.114 | 20 | 5526 | idx_beats_activo_fecha | Limit → Index Scan (idx_beats_activo_fecha) |
| Q3 | ¿Ya compró estos beats? (POST /orders) | 0.161 | 7.011 | 0.148–0.233 | 1 | 52 | idx_orders_user_status, idx_order_items_beat | Hash Join → Bitmap Heap Scan → Bitmap Index Scan (idx_orders_user_status) → Hash → Bitmap Heap Scan → Bitmap Index Scan (idx_order_items_beat) |
| Q4 | Mis compras con sus beats (GET /orders/mis-compras) | 0.434 | 12.11 | 0.417–0.594 | 18 | 3282 | idx_orders_user, order_items_order_id_beat_id_key, beats_pkey | Sort → Nested Loop → Nested Loop → Bitmap Heap Scan → Bitmap Index Scan (idx_orders_user) → Index Only Scan (order_items_order_id_beat_id_key) → Index Scan (beats_pkey) |
| Q5 | Columnas de más: beat por id con * vs. solo lo que usa la app | 0.109 | 4.226 | 0.099–0.119 | 1 | 234 | beats_pkey | Index Scan (beats_pkey) |

## Concurrencia

| ID | Prueba | Esperado | Obtenido | Detalle | Cumple |
|---|---|---:|---:|---|:---:|
| DB-06a | Dos UPDATE simultáneos al mismo beat (precio = precio + n) | 135 | 135 | B esperó 914 ms el bloqueo | ✅ |
| DB-06b | Dos compras simultáneas del mismo beat (ANTES: sin protección en la base) | 1 | 2 | A: 201 compra creada / B: 201 compra creada | ❌ |
| DB-06b | Dos compras simultáneas del mismo beat (DESPUÉS: con trg_compra_unica) | 1 | 1 | A: 201 compra creada / B: 409 rechazado por la base (orden deshecha) | ✅ |

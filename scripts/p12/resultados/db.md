# Práctica 12 · Rendimiento de base de datos

PostgreSQL 16.11 · base `skondit_local` · mediana de 7 ejecuciones (tiempo de ejecución de EXPLAIN ANALYZE).

## Consultas (antes y después)

| Prueba | Consulta | Antes ms | Filas | KB | Después ms | Filas | KB | Mejora |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| DB-01 | Beat por identificador | 0.059 | 1 | 0.4 | 0.102 | 1 | 0.4 | -73 % |
| DB-02 | Conjunto pequeño: primera pantalla de la tienda | 2.498 | 4800 | 1332.9 | 0.105 | 20 | 5.5 | 96 % |
| DB-03 | Conjunto grande: catálogo completo (4 800 beats) | 2.342 | 4800 | 1332.9 | 1.259 | 4800 | 1332.9 | 46 % |
| DB-04 | Consulta con filtros (género + BPM + precio) | 0.500 | 70 | 19.4 | 0.340 | 20 | 5.5 | 32 % |
| DB-05 | Consulta crítica: bandeja de tickets del administrador | 140.355 | 12000 | 11771.1 | 0.438 | 20 | 9.2 | 100 % |
| DB-06 | Tickets de un cliente | 2.578 | 6 | 5.9 | 0.354 | 6 | 2.8 | 86 % |
| DB-07 | Compras de un cliente (órdenes completadas con sus beats) | 0.376 | 18 | 3.2 | 0.360 | 18 | 3.2 | 4 % |

## Uso de índices

| Prueba | Antes | Después |
|---|---|---|
| DB-01 | índice beats_pkey | índice beats_pkey |
| DB-02 | sin índice · recorrido secuencial · ordena en memoria | índice idx_beats_activo_fecha |
| DB-03 | sin índice · recorrido secuencial · ordena en memoria | índice idx_beats_activo_fecha |
| DB-04 | índice idx_beats_genero · ordena en memoria | índice idx_beats_activo_fecha |
| DB-05 | índice users_pkey, idx_contact_replies_message · recorrido secuencial · ordena en memoria | índice idx_contact_messages_estado_fecha, users_pkey, idx_contact_replies_message |
| DB-06 | índice users_pkey, idx_contact_replies_message · recorrido secuencial · ordena en memoria | índice idx_contact_messages_user_fecha, users_pkey, idx_contact_replies_message · ordena en memoria |
| DB-07 | índice idx_orders_user, order_items_order_id_beat_id_key, beats_pkey · ordena en memoria | índice idx_orders_user, order_items_order_id_beat_id_key, beats_pkey · ordena en memoria |

- **DB-02**: Antes la tienda traía el catálogo completo para mostrar ~8 tarjetas; ahora pide una página de 20.
- **DB-03**: Misma consulta; se conserva para la web. Solo cambia el índice disponible.
- **DB-05**: Antes: los 12 000 tickets con el texto de todas sus respuestas. Ahora: 20 tickets abiertos y solo el número de respuestas.

## Concurrencia

| Prueba | Resultado |
|---|---|
| CON-01 · 20 clientes actualizan tickets distintos (2000 escrituras) | 25708 tps · latencia media 0.78 ms · 0 fallidas |
| CON-02 · 20 clientes escriben el mismo ticket (2000 escrituras) | 2244 tps · latencia media 8.91 ms (espera por bloqueo de fila) · 0 fallidas |
| CON-03 · 20 admins toman el mismo ticket a la vez | 1 lo obtiene, 19 reciben "el ticket cambió" (409) |
| CON-04 · mismo pago 20 veces con Idempotency-Key | 1 orden en la base (19 reintentos descartados por UNIQUE) |
| CON-05 · mismo pago 20 veces sin clave (original) | 20 órdenes duplicadas |

## Integridad después de las pruebas

- Renglones de orden sin orden: 0
- Respuestas sin ticket: 0
- Folios repetidos: 0
- Tickets: 12000 (sin pérdidas)
- Estado final del ticket #1: EN_PROCESO

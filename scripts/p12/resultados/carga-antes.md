# Práctica 12 · Prueba de estrés de la API (antes)

Servidor: http://127.0.0.1:3001 · 10 s por escalón · 2026-11-13T04:35:25.199Z

### Lectura · GET /api/beats

| Usuarios | Solicitudes | Exitosas | RPS | Prom. ms | P50 | P90 | P95 | Máx. ms | Errores % | Códigos HTTP | KB/resp. | /health máx. ms |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|
| 1 | 212 | 212 | 21 | 47.2 | 35.1 | 47.6 | 54.6 | 1911.2 | 0.00 | 200×212 | 1314.2 | 195.1 |
| 10 | 496 | 496 | 49 | 203.0 | 187.8 | 267.3 | 309.0 | 1432.7 | 0.00 | 200×496 | 1314.2 | 130.6 |
| 25 | 515 | 515 | 50 | 494.7 | 482.8 | 631.4 | 696.7 | 877.5 | 0.00 | 200×515 | 1314.2 | 319.9 |
| 50 | 548 | 548 | 51 | 944.8 | 936.2 | 1174.1 | 1212.8 | 1804.3 | 0.00 | 200×548 | 1314.2 | 553.3 |
| 100 | 577 | 577 | 50 | 1884.9 | 1965.2 | 2404.6 | 2634.3 | 2888.3 | 0.00 | 200×577 | 1314.2 | 914.9 |
| 200 | 663 | 663 | 51 | 3487.5 | 3707.6 | 4374.8 | 4641.9 | 5725.4 | 0.00 | 200×663 | 1314.2 | 2343.6 |

**Punto de saturación:** alrededor de 10 usuarios (49 RPS). A partir de ahí agregar usuarios ya no aumenta las solicitudes atendidas: se forman en cola y la latencia crece (de 47.2 ms con 1 usuario(s) a 3487.5 ms con 200).


# Práctica 12 · Prueba de estrés de la API (despues)

Servidor: http://127.0.0.1:3000 · 10 s por escalón · 2026-11-13T04:36:38.936Z

### Lectura · GET /api/beats?limit=20&page=1

| Usuarios | Solicitudes | Exitosas | RPS | Prom. ms | P50 | P90 | P95 | Máx. ms | Errores % | Códigos HTTP | KB/resp. | /health máx. ms |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|
| 1 | 3917 | 3917 | 389 | 2.5 | 2.4 | 3.1 | 3.4 | 12.5 | 0.00 | 200×3917 | 5.5 | 4.3 |
| 10 | 16982 | 16982 | 1681 | 5.9 | 5.5 | 7.7 | 8.7 | 21.3 | 0.00 | 200×16982 | 5.5 | 8.2 |
| 25 | 14075 | 14075 | 1393 | 17.7 | 16.9 | 22.0 | 24.7 | 47.3 | 0.00 | 200×14075 | 5.5 | 17.2 |
| 50 | 14487 | 14487 | 1426 | 34.5 | 33.2 | 40.7 | 47.9 | 78.8 | 0.00 | 200×14487 | 5.5 | 34.1 |
| 100 | 14712 | 14712 | 1440 | 68.1 | 66.5 | 75.4 | 79.6 | 126.3 | 0.00 | 200×14712 | 5.5 | 62.3 |
| 200 | 13036 | 13036 | 1270 | 153.9 | 143.3 | 206.9 | 215.2 | 311.6 | 0.00 | 200×13036 | 5.5 | 135.2 |

**Punto de saturación:** alrededor de 10 usuarios (1681 RPS). A partir de ahí agregar usuarios ya no aumenta las solicitudes atendidas: se forman en cola y la latencia crece (de 2.5 ms con 1 usuario(s) a 153.9 ms con 200).

### Escritura · POST /api/contact

| Usuarios | Solicitudes | Exitosas | RPS | Prom. ms | P50 | P90 | P95 | Máx. ms | Errores % | Códigos HTTP | KB/resp. | /health máx. ms |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|
| 1 | 186 | 186 | 19 | 53.8 | 13.5 | 143.7 | 232.8 | 1981.4 | 0.00 | 201×186 | 0.1 | 10.0 |
| 10 | 4500 | 4500 | 440 | 22.5 | 11.9 | 32.4 | 60.7 | 355.3 | 0.00 | 201×4500 | 0.1 | 9.0 |
| 25 | 5678 | 5678 | 563 | 44.1 | 23.6 | 80.8 | 191.4 | 555.9 | 0.00 | 201×5678 | 0.1 | 23.5 |
| 50 | 6448 | 6448 | 643 | 77.7 | 55.4 | 160.1 | 205.0 | 583.8 | 0.00 | 201×6448 | 0.1 | 34.1 |
| 100 | 7117 | 7117 | 666 | 145.7 | 92.3 | 293.8 | 455.8 | 1652.0 | 0.00 | 201×7117 | 0.1 | 119.1 |
| 200 | 6383 | 6383 | 600 | 322.1 | 193.7 | 727.4 | 1038.3 | 3170.7 | 0.00 | 201×6383 | 0.1 | 159.4 |

**Punto de saturación:** alrededor de 50 usuarios (643 RPS). A partir de ahí agregar usuarios ya no aumenta las solicitudes atendidas: se forman en cola y la latencia crece (de 53.8 ms con 1 usuario(s) a 322.1 ms con 200).


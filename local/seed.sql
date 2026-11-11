-- Datos de prueba para medir con volumen (Práctica 12). Deja la base siempre igual:
-- borra todo y vuelve a generar los mismos registros (setseed), para que las
-- mediciones sean reproducibles.
--   5 000 beats · 2 000 clientes · 20 000 órdenes · 12 000 tickets · 30 000 respuestas
-- Cuentas (contraseña de ambas: Prueba-12345!):
--   admin@local.test (ADMIN, entra sin OTP)   cliente@local.test (CLIENTE)

truncate contact_replies, contact_messages, pack_intercambios, order_items, orders,
         pack_beats, packs, otp_codes, bitacora, beats, users restart identity cascade;
alter sequence ticket_folio_seq restart with 1;
select setseed(0.42);

insert into users (id, email, username, password, nombre, rol) values
  ('00000000-0000-4000-8000-000000000001', 'admin@local.test',   'admin',   crypt('Prueba-12345!', gen_salt('bf', 10)), 'Admin Local',   'ADMIN'),
  ('00000000-0000-4000-8000-000000000002', 'admin2@local.test',  'admin2',  crypt('Prueba-12345!', gen_salt('bf', 10)), 'Segundo Admin', 'ADMIN'),
  ('00000000-0000-4000-8000-000000000003', 'cliente@local.test', 'cliente', crypt('Prueba-12345!', gen_salt('bf', 10)), 'Cliente Local', 'CLIENTE');

-- El hash es el mismo para todos: generar 2 000 bcrypt tardaría minutos y estas cuentas no inician sesión.
insert into users (email, username, password, nombre, rol, fecha_registro)
select 'cliente' || n || '@local.test', 'cliente' || n,
       '$2a$10$abcdefghijklmnopqrstuuJ8Cb6rYq6wJ8Y4mWqQyq1uQ0oG7yD2K',
       'Cliente ' || n, 'CLIENTE', now() - (n || ' hours')::interval
from generate_series(1, 2000) n;

insert into beats (nombre, genero, bpm, precio, descripcion, activo, created_at)
select 'Beat ' || n,
       (array['Trap', 'Rap', 'Drill', 'LoFi', 'Rock', 'Reggaeton', 'Boom Bap', 'R&B'])[1 + (n % 8)],
       60 + (random() * 140)::int,
       100 + (random() * 19)::int * 50,
       'Instrumental de prueba número ' || n || ' con 808s, hi-hats y melodía original.',
       n % 25 <> 0,                                   -- 4 % eliminados lógicamente
       now() - (n || ' minutes')::interval
from generate_series(1, 5000) n;

insert into packs (id, nombre, descripcion, precio)
select uuid_generate_v4(), 'Paquete ' || n, 'Cinco beats con descuento', 900 + n * 10
from generate_series(1, 20) n;

insert into pack_beats (pack_id, beat_id)
select p.id, b.id
from (select id, row_number() over (order by nombre) rn from packs) p
join (select id, row_number() over (order by created_at) rn from beats where activo) b
  on b.rn between (p.rn - 1) * 5 + 1 and p.rn * 5;

-- 20 000 órdenes repartidas entre los clientes, con 1 a 3 beats cada una.
with clientes as (select id, row_number() over (order by email) rn from users where rol = 'CLIENTE'),
     nuevas as (
       insert into orders (user_id, total, status, created_at)
       select c.id, 0, (case when n % 20 = 0 then 'CANCELADO' else 'COMPLETADO' end)::order_status,
              now() - (n || ' minutes')::interval
       from generate_series(1, 20000) n
       join clientes c on c.rn = 1 + (n % 2001)
       returning id
     ),
     numeradas as (select id, row_number() over () rn from nuevas),
     catalogo as (select id, precio, row_number() over (order by created_at) rn from beats)
insert into order_items (order_id, beat_id, precio_unitario)
select o.id, b.id, b.precio
from numeradas o
join generate_series(0, 2) k on k <= o.rn % 3
join catalogo b on b.rn = 1 + ((o.rn * 7 + k * 13) % 5000);

update orders o set total = t.total
from (select order_id, sum(precio_unitario) total from order_items group by order_id) t
where t.order_id = o.id;

insert into contact_messages (nombre, email, asunto, mensaje, tipo, estado, prioridad, user_id, asignado_a, created_at)
select u.nombre, u.email, 'Asunto del ticket ' || n,
       'Descripción del problema número ' || n || ': el beat no se reproduce después de comprarlo.',
       case when n % 3 = 0 then 'ERROR' else 'MENSAJE' end,
       (array['ABIERTO', 'ABIERTO', 'EN_PROCESO', 'RESPONDIDO', 'DEVUELTO', 'RESUELTO', 'CERRADO', 'CERRADO'])[1 + (n % 8)],
       (array['BAJA', 'MEDIA', 'MEDIA', 'ALTA'])[1 + (n % 4)],
       u.id,
       case when n % 2 = 0 then '00000000-0000-4000-8000-000000000001'::uuid end,
       now() - (n || ' minutes')::interval
from generate_series(1, 12000) n
join (select id, nombre, email, row_number() over (order by email) rn from users where rol = 'CLIENTE') u
  on u.rn = 1 + (n % 2001);

insert into contact_replies (message_id, autor_id, autor_nombre, es_admin, texto, created_at)
select m.id, '00000000-0000-4000-8000-000000000001', 'Admin Local', k % 2 = 0,
       'Respuesta ' || k || ' del ticket: revisa tu sección de compras e intenta de nuevo, por favor.',
       m.created_at + (k || ' minutes')::interval
from contact_messages m
join generate_series(1, 5) k on k <= m.folio % 6;

analyze;

select (select count(*) from beats) beats, (select count(*) from users) usuarios,
       (select count(*) from orders) ordenes, (select count(*) from order_items) renglones,
       (select count(*) from contact_messages) tickets, (select count(*) from contact_replies) respuestas;

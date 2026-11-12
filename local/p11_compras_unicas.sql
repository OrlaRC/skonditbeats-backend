-- Práctica 11 · DEF-08: un usuario no puede comprar dos veces el mismo beat, ni
-- con dos peticiones simultáneas.
--
-- La API revisa "¿ya lo compró?" y luego inserta la orden y sus renglones con
-- llamadas separadas a PostgREST. Dos compras al mismo tiempo (dos teléfonos con
-- la misma cuenta, claves de idempotencia distintas) pasaban las dos la revisión y
-- se cobraban dos veces. No se puede expresar con un UNIQUE porque el usuario está
-- en `orders` y el beat en `order_items`, así que se valida en un disparador:
--   1. Toma un candado de la transacción por usuario (pg_advisory_xact_lock): la
--      segunda compra espera a que la primera termine.
--   2. Ya con el candado, busca una compra COMPLETADA previa de ese beat. Como la
--      función es VOLATILE, esta consulta ve lo que la primera ya confirmó.
--   3. Si existe, falla con 23505 (unique_violation); la API responde 409 y borra
--      la orden que acababa de crear.
-- Se aplica después de seed.sql (ver preparar.ps1) y en Supabase con
-- supabase/compras_unicas.sql (mismo contenido).

create or replace function evitar_compra_repetida() returns trigger
language plpgsql volatile as $$
declare
  v_usuario uuid;
begin
  select user_id into v_usuario from orders where id = new.order_id;
  perform pg_advisory_xact_lock(hashtextextended('compra:' || v_usuario::text, 0));

  if exists (
    select 1
      from order_items i
      join orders o on o.id = i.order_id
     where o.user_id = v_usuario
       and o.status = 'COMPLETADO'
       and i.beat_id = new.beat_id
       and i.order_id <> new.order_id
  ) then
    raise exception 'El usuario ya compró el beat %', new.beat_id
      using errcode = '23505', hint = 'compra_repetida';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_compra_unica on order_items;
create trigger trg_compra_unica
  before insert on order_items
  for each row execute function evitar_compra_repetida();

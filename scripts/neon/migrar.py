"""Copia el esquema `public` y todos sus datos de Supabase a Neon.

Lee SUPABASE_DB_URL (origen) y DATABASE_URL (destino, Neon) de api/.env. Las
contraseñas viajan en PGPASSWORD y nunca se imprimen.

  python scripts/neon/migrar.py            # vuelca, adapta y verifica (no toca Neon)
  python scripts/neon/migrar.py --aplicar  # además BORRA el esquema public de Neon y lo carga

Adaptaciones para Neon (Postgres "puro", sin los esquemas de Supabase):
  - extensions.uuid_generate_v4()  →  gen_random_uuid()  (nativa desde PG 13)
  - sin CREATE SCHEMA public (ya existe) ni políticas RLS para los roles anon/authenticated
  - CREATE EXTENSION pgcrypto (crypt() en skondit_auth_user)

Requiere las herramientas cliente de PostgreSQL 18 (Supabase usa 17 y Neon 18):
PG_BIN=D:\\PostgreSQL\\18-cliente\\bin por omisión.
"""
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

API = Path(__file__).resolve().parents[2]
PG_BIN = Path(os.environ.get('PG_BIN', r'D:\PostgreSQL\18-cliente\bin'))
SALIDA = API / 'scripts/neon/salida'   # ignorada por git: contiene datos de usuarios


def leer_env():
    v = {}
    for linea in (API / '.env').read_text(encoding='utf-8').splitlines():
        if '=' in linea and not linea.lstrip().startswith('#'):
            k, x = linea.split('=', 1)
            v[k.strip()] = x.strip().strip('"').strip("'")
    return v


def entorno(url):
    u = urlparse(url)
    e = dict(os.environ, PGHOST=u.hostname, PGPORT=str(u.port or 5432), PGUSER=unquote(u.username or ''),
             PGPASSWORD=unquote(u.password or ''), PGDATABASE=u.path.lstrip('/') or 'postgres',
             PGSSLMODE='require', PGCONNECT_TIMEOUT='20', PGCLIENTENCODING='UTF8')
    cb = parse_qs(u.query).get('channel_binding')
    if cb:
        e['PGCHANNELBINDING'] = cb[0]
    return e


def correr(herramienta, args, env, entrada=None):
    r = subprocess.run([str(PG_BIN / herramienta), *args], env=env, capture_output=True, input=entrada)
    salida = (r.stdout + r.stderr).decode('utf-8', errors='replace').replace(env['PGPASSWORD'], '****')
    if r.returncode:
        sys.exit(f'{herramienta} falló:\n{salida}')
    return r.stdout.decode('utf-8', errors='replace')


def adaptar(sql):
    sql = sql.replace('\r\n', '\n')  # pg_dump en Windows escribe CRLF
    sql = re.sub(r'"?extensions"?\."?uuid_generate_v4"?\(\)', 'gen_random_uuid()', sql)
    sql = re.sub(r'^CREATE SCHEMA "?public"?;\n', '', sql, flags=re.M)
    # pg_dump 18 protege el volcado con \restrict; se conserva (psql 18 lo entiende).
    encabezado = ('-- Adaptado para Neon por scripts/neon/migrar.py\n'
                  'CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;\n')
    return encabezado + sql


CONTEO = """select string_agg(format('%s=%s', c.relname,
  (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', c.relname), false, true, '')))[1]), ' ' order by c.relname)
from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'"""


def main():
    sys.stdout.reconfigure(encoding='utf-8')  # la consola de Windows usa cp1252
    env = leer_env()
    origen, destino = entorno(env['SUPABASE_DB_URL']), entorno(env['DATABASE_URL'])
    SALIDA.mkdir(parents=True, exist_ok=True)
    marca = datetime.now().strftime('%Y%m%d-%H%M%S')

    print('1. Volcando Supabase (esquema public + datos)…')
    volcado = correr('pg_dump', ['--schema=public', '--no-owner', '--no-privileges', '--no-policies',
                                 '--no-comments', '--quote-all-identifiers'], origen)
    crudo = SALIDA / f'supabase-{marca}.sql'
    crudo.write_text(volcado, encoding='utf-8')
    adaptado = adaptar(volcado)
    final = SALIDA / f'neon-{marca}.sql'
    final.write_text(adaptado, encoding='utf-8')
    restos = sorted(set(re.findall(r'"?\b(extensions|auth|storage|vault|graphql)"?\."?\w+', adaptado)))
    print(f'   {len(volcado):,} bytes → {final.name}; referencias a esquemas de Supabase: {restos or "ninguna"}')
    conteo_origen = correr('psql', ['-X', '-At', '-c', CONTEO], origen).strip()
    print(f'   filas en Supabase: {conteo_origen}')

    if '--aplicar' not in sys.argv:
        print('\nSin --aplicar: Neon no se modificó.')
        return

    print('2. Neon: borrando el esquema public y cargando el volcado…')
    correr('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-q', '-c',
                    'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'], destino)
    correr('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-q', '-f', str(final)], destino)

    print('3. Verificando…')
    conteo_destino = correr('psql', ['-X', '-At', '-c', CONTEO], destino).strip()
    print(f'   filas en Neon:     {conteo_destino}')
    if conteo_origen != conteo_destino:
        sys.exit('   ✗ Los conteos NO coinciden')
    print('   ✓ Mismas tablas y mismo número de filas')


if __name__ == '__main__':
    main()

import postgres from 'postgres';

/**
 * Conexión a PostgreSQL (Neon en producción, el PostgreSQL de la PC en pruebas).
 *
 * Antes la API hablaba con el REST de Supabase (PostgREST) por medio de supabase-js;
 * ahora consulta la base con SQL parametrizado. Los valores viajan siempre como
 * parámetros ($1, $2…), nunca concatenados en el texto de la consulta.
 */
const url = process.env['DATABASE_URL'];

if (!url) {
  throw new Error('Falta variable de entorno: DATABASE_URL es obligatoria');
}

const local = /@(127\.0\.0\.1|localhost)[:/]/.test(url);

export const sql = postgres(url, {
  ssl: local ? false : 'require',
  // El pooler de Neon (PgBouncer en modo transacción) no admite sentencias preparadas
  // con nombre entre transacciones.
  prepare: false,
  // En Vercel cada instancia atiende pocas peticiones a la vez: pocas conexiones.
  max: Number(process.env['DB_MAX_CONEXIONES'] ?? 5),
  idle_timeout: 20,
  connect_timeout: 10,
  transform: { undefined: null },
  // PostgREST devolvía numeric y bigint como números JSON; postgres.js los devuelve
  // como texto para no perder precisión. Precios, folios y conteos caben en un double.
  types: {
    numeric: { to: 1700, from: [1700], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) },
    bigint:  { to: 20,   from: [20],   serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) },
    // timestamptz como texto ISO con microsegundos, igual que PostgREST
    // ("2026-11-11T20:12:00.664892+00:00"). Con Date de JS se perderían los µs.
    timestamptz: {
      to: 1184, from: [1184],
      serialize: (x: unknown) => (x instanceof Date ? x.toISOString() : String(x)),
      parse: (x: string) => x.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'),
    },
  },
  // Las fechas se leen en UTC, como las devolvía Supabase.
  connection: { TimeZone: 'UTC' },
  onnotice: () => {},
});

export type Sql = typeof sql;

/**
 * Quita las propiedades `undefined`. supabase-js no enviaba esos campos en un
 * update/insert (la columna quedaba igual); con SQL hay que omitirlos a mano o se
 * escribirían como NULL.
 */
export function definidos<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Error de PostgreSQL por un valor con formato inválido (p. ej. un id que no es UUID). */
export function esFormatoInvalido(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '22P02';
}

/**
 * Ejecuta una consulta y, si falla solo porque algún valor no tiene el formato de la
 * columna (22P02, p. ej. un id que no es UUID), devuelve [] como "no existe".
 */
export async function filasONada<T>(consulta: PromiseLike<T>): Promise<T | []> {
  try {
    return await consulta;
  } catch (error) {
    if (esFormatoInvalido(error)) return [];
    throw error;
  }
}

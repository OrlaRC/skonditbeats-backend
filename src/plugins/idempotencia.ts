import type { FastifyRequest } from 'fastify';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Clave de idempotencia que manda el cliente (cabecera Idempotency-Key).
 * Se guarda en la columna client_ref (UNIQUE) del registro creado: un reintento
 * con la misma clave choca con la restricción y se responde el registro original.
 */
export function claveIdempotencia(request: FastifyRequest): string | null {
  const valor = request.headers['idempotency-key'];
  const clave = Array.isArray(valor) ? valor[0] : valor;
  return clave && UUID.test(clave) ? clave.toLowerCase() : null;
}

/** Código de PostgreSQL para una violación de UNIQUE. */
export function esDuplicado(error: { code?: string } | null | undefined): boolean {
  return error?.code === '23505';
}

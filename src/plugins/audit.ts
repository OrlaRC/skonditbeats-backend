import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from '../db/sql';

export interface AuditEntry {
  user_id: string | null;
  email:   string | null;
  accion:  string;
  detalle: string;
  ip:      string | null;
}

export async function registrarAudit(
  app:     FastifyInstance,
  entry:   AuditEntry
): Promise<void> {
  try {
    await sql`
      insert into bitacora (user_id, email, accion, detalle, ip)
      values (${entry.user_id}, ${entry.email}, ${entry.accion}, ${entry.detalle}, ${entry.ip})`;
  } catch (error) {
    app.log.error(error, 'No se pudo registrar en bitácora');
  }
}

export function ipDeRequest(request: FastifyRequest): string | null {
  const ip = request.ip;
  return ip && ip !== '::1' ? ip : '127.0.0.1';
}

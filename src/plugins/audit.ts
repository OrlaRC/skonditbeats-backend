import type { FastifyInstance, FastifyRequest } from 'fastify';
import { supabase } from '../db/supabase';

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
  const { error } = await supabase
    .from('bitacora')
    .insert({
      user_id:    entry.user_id,
      email:      entry.email,
      accion:     entry.accion,
      detalle:    entry.detalle,
      ip:         entry.ip
    });

  if (error) {
    app.log.error(error, 'No se pudo registrar en bitácora');
  }
}

export function ipDeRequest(request: FastifyRequest): string | null {
  const ip = request.ip;
  return ip && ip !== '::1' ? ip : '127.0.0.1';
}

import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';

export async function registerMultipart(app: FastifyInstance): Promise<void> {
  await app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50 MB máximo por archivo
      files: 2                     // imagen + audio
    }
  });
}

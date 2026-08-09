import type { FastifyInstance } from 'fastify';
import { supabase } from '../../db/supabase';

const BUCKETS_VALIDOS = ['beats-images', 'beats-audio', 'avatars'] as const;
type Bucket = (typeof BUCKETS_VALIDOS)[number];

interface PresignBody {
  bucket:      string;
  contentType: string;
  fileName?:   string;
}

export async function uploadRoutes(app: FastifyInstance): Promise<void> {

  // ─── POST /api/uploads/presign ─────────────────────────────────────────────
  // Genera una URL firmada para que el FRONTEND suba el archivo directo a
  // Supabase Storage (evita pasar archivos grandes por Vercel).
  app.post<{ Body: PresignBody }>('/presign', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    const { bucket, contentType, fileName } = request.body;

    if (!BUCKETS_VALIDOS.includes(bucket as Bucket)) {
      return reply.code(400).send({ error: 'Bucket inválido' });
    }

    if (!contentType) {
      return reply.code(400).send({ error: 'contentType es obligatorio' });
    }

    const extension = contentType.split('/')[1] ?? 'bin';
    const name      = fileName
      ? `${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`
      : `${Date.now()}_${request.user.sub}.${extension}`;

    const { data, error } = await supabase.storage
      .from(bucket)
      .createSignedUploadUrl(name, { upsert: true });

    if (error || !data) {
      app.log.error(error);
      return reply.code(500).send({ error: 'Error al generar la URL firmada' });
    }

    const { data: publicUrlData } = supabase.storage
      .from(bucket)
      .getPublicUrl(name);

    return reply.send({
      signedUrl:  data.signedUrl,
      token:      data.token,
      path:       data.path,
      contentType,
      publicUrl:  publicUrlData.publicUrl
    });
  });
}

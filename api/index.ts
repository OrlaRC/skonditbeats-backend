import type { IncomingMessage, ServerResponse } from 'http';
import { buildApp } from '../src/app';

let appPromise: ReturnType<typeof buildApp> | null = null;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (!appPromise) {
      appPromise = buildApp();
    }
    const app = await appPromise;
    await app.ready();

    const rawBody = req.method !== 'GET' && req.method !== 'HEAD'
      ? await readBody(req)
      : '';

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      const lower = key.toLowerCase();
      if (lower === 'content-length' || lower === 'connection' || lower === 'host' || lower === 'accept-encoding') continue;
      headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
    }

    const options: any = {
      method: req.method ?? 'GET',
      url:    req.url ?? '/',
      headers
    };

    if (rawBody) {
      options.payload = rawBody;
    }

    const response = await app.inject(options);

    res.statusCode = response.statusCode;
    for (const [key, value] of Object.entries(response.headers)) {
      if (value !== undefined) res.setHeader(key, String(value));
    }
    res.end(response.body);
  } catch (err: any) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'handler', message: String(err?.message ?? err), stack: String(err?.stack ?? '') }));
  }
}

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildApp } from '../src/app';

let appPromise: ReturnType<typeof buildApp> | null = null;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    if (!appPromise) {
      appPromise = buildApp();
    }
    const app = await appPromise;
    await app.ready();

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      const lower = key.toLowerCase();
      if (lower === 'content-length' || lower === 'connection' || lower === 'host' || lower === 'accept-encoding') continue;
      headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
    }

    const hasBody =
      req.body !== undefined && req.body !== null && req.body !== ''
      && req.method !== 'GET' && req.method !== 'HEAD';

    const options: any = {
      method: req.method ?? 'GET',
      url:    req.url ?? '/',
      headers
    };

    if (hasBody) {
      options.payload = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
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

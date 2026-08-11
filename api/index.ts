import type { IncomingMessage, ServerResponse } from 'http';
import { buildApp } from '../src/app';

let appPromise: ReturnType<typeof buildApp> | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!appPromise) {
    appPromise = buildApp();
  }
  const app = await appPromise;

  await app.ready();

  app.server.emit('request', req, res);
}

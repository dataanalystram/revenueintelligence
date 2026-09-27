import type { IncomingMessage, ServerResponse } from 'node:http';

/** Largest webhook request body accepted (bytes). */
export const WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Express middleware for webhook routes: reads the request body into a Buffer
 * (`req.body`), exactly as received, up to `limitBytes`. Webhook signatures
 * are computed over these bytes, so no JSON parser may touch them first; the
 * stream is fully consumed here, so the global body parsers skip the request.
 * A larger body is refused with 413 before it is buffered.
 */
export function rawRequestBody(limitBytes: number = WEBHOOK_MAX_BODY_BYTES) {
  return (
    req: IncomingMessage & { body?: unknown },
    res: ServerResponse,
    next: (err?: unknown) => void,
  ): void => {
    const tooLarge = (): void => {
      if (!res.headersSent) {
        res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ status: 'error', reason: 'payload_too_large' }));
      }
      req.resume(); // discard the rest without buffering it
    };
    const declared = Number(req.headers['content-length'] ?? '0');
    if (Number.isFinite(declared) && declared > limitBytes) return tooLarge();

    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limitBytes) {
        refused = true;
        req.off('data', onData);
        chunks.length = 0;
        tooLarge();
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.once('end', () => {
      if (refused) return;
      req.body = Buffer.concat(chunks, size);
      next();
    });
    req.once('error', (err) => {
      if (!refused) next(err);
    });
  };
}

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rawRequestBody } from './raw-body';

describe('rawRequestBody (webhook routes)', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    const middleware = rawRequestBody(64);
    server = createServer((req, res) => {
      middleware(req, res, (err) => {
        if (err) {
          res.writeHead(500).end();
          return;
        }
        const body = (req as { body?: unknown }).body;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            isBuffer: Buffer.isBuffer(body),
            hex: Buffer.isBuffer(body) ? body.toString('hex') : null,
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('hands over the exact bytes received, whatever the content type', async () => {
    const bytes = Buffer.from('[ {"a": 1},\r\n\t"café"]', 'utf8');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: bytes,
    });
    expect(await res.json()).toEqual({ isBuffer: true, hex: bytes.toString('hex') });
  });

  it('an empty body is an empty buffer', async () => {
    const res = await fetch(url, { method: 'POST' });
    expect(await res.json()).toEqual({ isBuffer: true, hex: '' });
  });

  it('refuses a body over the limit with 413, by declared length or while streaming', async () => {
    const declared = await fetch(url, { method: 'POST', body: 'x'.repeat(65) });
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ status: 'error', reason: 'payload_too_large' });

    // Chunked (no content-length): the limit applies while reading.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 5; i += 1) controller.enqueue(new Uint8Array(20).fill(120));
        controller.close();
      },
    });
    const chunked = await fetch(url, { method: 'POST', body: stream, duplex: 'half' });
    expect(chunked.status).toBe(413);
  });

  it('accepts exactly the limit', async () => {
    const res = await fetch(url, { method: 'POST', body: 'y'.repeat(64) });
    expect(res.status).toBe(200);
  });
});

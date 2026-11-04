import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
export interface BulkHandlerOptions {
  origins: string[] | ((origin: string) => boolean);
  prefix?: string; maxBytes?: number; maxConcurrent?: number;
  /** Origin is not authorization. Validate account/resource access here for private worlds. */
  authorize?: (request: IncomingMessage, id: string) => boolean | Promise<boolean>;
  /** IDs are opaque, not filesystem paths. Respect cancellation while generating/loading a resource. */
  resolve: (id: string, signal: AbortSignal) => { bytes: Uint8Array; contentType?: string } | null |
    Promise<{ bytes: Uint8Array; contentType?: string } | null>;
  cacheControl?: string;
  onError?: (error: unknown) => void;
}
/** Attach to GameServer's HTTP hook or any Node HTTP server. Uses independent HTTP responses with backpressure. */
export function createBulkHandler(options: BulkHandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const prefix = options.prefix ?? '/resources/', maxBytes = options.maxBytes ?? 8 * 1024 * 1024, maxConcurrent = options.maxConcurrent ?? 4;
  if (!prefix.startsWith('/') || !prefix.endsWith('/') ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024 ||
      !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 64 ||
      typeof options.origins !== 'function' && (!Array.isArray(options.origins) || options.origins.some(o => typeof o !== 'string' || o === '*')))
    throw new RangeError('Invalid bulk host limits or origins');
  let active = 0;
  return async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://resource.invalid').pathname;
    if (!path.startsWith(prefix)) return false;
    const finish = (status: number) => { res.writeHead(status); res.end(); return true; };
    const origin = req.headers.origin;
    if (origin && !(typeof options.origins === 'function' ? options.origins(origin) : options.origins.includes(origin))) return finish(403);
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Expose-Headers', 'ETag, Content-Length'); }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, If-None-Match'); return finish(204);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); return finish(405); }
    let id: string;
    try { id = decodeURIComponent(path.slice(prefix.length)); } catch { return finish(400); }
    if (!/^[\w-]{1,128}$/.test(id)) return finish(400);
    if (active >= maxConcurrent) { res.setHeader('Retry-After', '1'); return finish(503); }
    active++;
    const controller = new AbortController();
    const closed = () => { if (!res.writableFinished) controller.abort(); };
    res.once('close', closed);
    try {
      if (options.authorize && !await options.authorize(req, id)) return finish(403);
      if (res.destroyed) return true;
      const resource = await options.resolve(id, controller.signal);
      if (res.destroyed) return true;
      if (!resource) return finish(404);
      const { bytes } = resource;
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxBytes) return finish(413);
      const etag = '"' + createHash('sha256').update(bytes).digest('hex') + '"';
      res.setHeader('ETag', etag); res.setHeader('Cache-Control', options.cacheControl ?? 'private, no-cache');
      if (req.headers['if-none-match'] === etag) return finish(304);
      res.setHeader('Content-Type', resource.contentType ?? 'application/octet-stream');
      res.setHeader('Content-Length', bytes.byteLength);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (req.method === 'HEAD') return finish(200);
      function* chunks() { for (let at = 0; at < bytes.length; at += 16 * 1024) yield bytes.subarray(at, at + 16 * 1024); }
      await pipeline(Readable.from(chunks()), res, { signal: controller.signal });
    } catch (error) {
      if (!controller.signal.aborted) { try { options.onError?.(error); } catch { /* observer only */ } }
      if (!res.destroyed) { if (res.headersSent) res.destroy(); else finish(500); }
    } finally { active--; res.off('close', closed); }
    return true;
  };
}

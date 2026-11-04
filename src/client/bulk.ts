export interface BulkClientOptions {
  concurrency?: number; maxQueued?: number;
  /** Per-transfer allocation limit (default 8 MiB, maximum 256 MiB). Returned data belongs to the caller. */
  maxBytes?: number;
  /** Total reserved transfer buffers (default concurrency * maxBytes). Assembly can briefly use twice this. */
  maxActiveBytes?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}
export interface BulkRequestOptions {
  signal?: AbortSignal; maxBytes?: number; sha256?: string; headers?: HeadersInit;
  credentials?: RequestCredentials;
  timeoutMs?: number;
}
export interface BulkTransfer { promise: Promise<Uint8Array>; cancel(): void }
interface Task {
  url: string; options: BulkRequestOptions; limit: number; controller: AbortController;
  resolve: (bytes: Uint8Array) => void; reject: (reason: unknown) => void; cleanup: () => void;
  timeoutMs: number; timedOut: boolean; timer?: ReturnType<typeof setTimeout>;
}
const bounded = (n: number, min: number, max: number) => Number.isSafeInteger(n) && n >= min && n <= max;
const abortError = () => new DOMException('Bulk transfer cancelled', 'AbortError');
const timeoutError = () => new DOMException('Bulk transfer timed out', 'TimeoutError');
const checkCancelled = (task: Task) => { if (task.controller.signal.aborted) throw task.timedOut ? timeoutError() : abortError(); };
/** Independent HTTP transfers: never put bulk bytes in the session's ordered event sequence. */
export class BulkClient {
  private tasks: Task[] = [];
  private running = new Set<Task>();
  private reserved = 0;
  private closed = false;
  readonly concurrency: number;
  readonly maxQueued: number;
  readonly maxBytes: number;
  readonly maxActiveBytes: number;
  readonly timeoutMs: number;
  constructor(private readonly options: BulkClientOptions = {}) {
    this.concurrency = options.concurrency ?? 2; this.maxQueued = options.maxQueued ?? 16;
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    this.maxActiveBytes = options.maxActiveBytes ?? this.concurrency * this.maxBytes;
    this.timeoutMs = options.timeoutMs ?? 30000;
    if (!bounded(this.concurrency, 1, 16) || !bounded(this.maxQueued, 0, 1024) ||
        !bounded(this.maxBytes, 1, 256 * 1024 * 1024) || !bounded(this.maxActiveBytes, this.maxBytes, 512 * 1024 * 1024) ||
        !bounded(this.timeoutMs, 1, 600000))
      throw new RangeError('Invalid bulk limits');
  }
  get active() { return this.running.size; }
  get queued() { return this.tasks.length; }
  request(url: string, options: BulkRequestOptions = {}): BulkTransfer {
    if (this.closed) throw new Error('Bulk client closed');
    const parsed = new URL(url, typeof location === 'undefined' ? undefined : location.href);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Invalid resource URL');
    const limit = options.maxBytes ?? this.maxBytes;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    if (!bounded(limit, 1, this.maxBytes) || !bounded(timeoutMs, 1, 600000) || options.sha256 !== undefined && !/^[a-fA-F0-9]{64}$/.test(options.sha256))
      throw new RangeError('Invalid resource limit or SHA-256');
    if ((this.running.size >= this.concurrency || this.reserved + limit > this.maxActiveBytes) && this.tasks.length >= this.maxQueued)
      throw new Error('Bulk queue full');
    const controller = new AbortController();
    let resolve!: Task['resolve'], reject!: Task['reject'];
    const promise = new Promise<Uint8Array>((ok, no) => { resolve = ok; reject = no; });
    const cancel = () => {
      clearTimeout(task.timer);
      controller.abort();
      const index = this.tasks.indexOf(task);
      if (index >= 0) { this.tasks.splice(index, 1); task.cleanup(); reject(abortError()); this.drain(); }
    };
    const external = options.signal;
    const task: Task = { url: parsed.href, options: { ...options, headers: options.headers ? new Headers(options.headers) : undefined }, limit, controller, resolve, reject,
      timeoutMs, timedOut: false, cleanup: () => { clearTimeout(task.timer); external?.removeEventListener('abort', cancel); } };
    if (external?.aborted) { controller.abort(); reject(abortError()); return { promise, cancel }; }
    external?.addEventListener('abort', cancel, { once: true });
    this.tasks.push(task); this.drain();
    return { promise, cancel };
  }
  private drain(): void {
    while (!this.closed && this.running.size < this.concurrency && this.tasks.length) {
      const task = this.tasks[0]!;
      if (this.reserved + task.limit > this.maxActiveBytes) return;
      this.tasks.shift(); this.running.add(task); this.reserved += task.limit;
      task.timer = setTimeout(() => { task.timedOut = true; task.controller.abort(); }, task.timeoutMs);
      const release = () => {
        this.running.delete(task); this.reserved -= task.limit; task.cleanup(); this.drain();
      };
      void this.download(task).then(bytes => { release(); task.resolve(bytes); }, error => {
        release(); task.reject(task.controller.signal.aborted ? task.timedOut ? timeoutError() : abortError() : error);
      });
    }
  }
  private async download(task: Task): Promise<Uint8Array> {
    const { signal } = task.controller;
    const response = await (this.options.fetch ?? fetch)(task.url, { signal, credentials: task.options.credentials ?? 'same-origin',
      headers: task.options.headers });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Resource HTTP ${response.status}`); }
    const length = response.headers.get('content-length');
    if (length && /^\d+$/.test(length) && Number(length) > task.limit) {
      await response.body?.cancel(); throw new RangeError('Resource size limit exceeded');
    }
    if (!response.body) throw new Error('Resource has no response body');
    const reader = response.body.getReader(), buffer = new Uint8Array(task.limit);
    let used = 0;
    try {
      for (;;) {
        checkCancelled(task);
        const { done, value } = await reader.read(); if (done) break;
        if (value.byteLength > task.limit - used) throw new RangeError('Resource size limit exceeded');
        buffer.set(value, used); used += value.byteLength;
      }
    } catch (error) { try { await reader.cancel(error); } catch { /* already aborted */ } throw error; }
    finally { reader.releaseLock(); }
    checkCancelled(task);
    const result = used === buffer.length ? buffer : buffer.slice(0, used);
    if (task.options.sha256) {
      if (!globalThis.crypto?.subtle) throw new Error('Resource integrity requires a secure context');
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', result));
      const hex = Array.from(digest, n => n.toString(16).padStart(2, '0')).join('');
      if (hex !== task.options.sha256.toLowerCase()) throw new Error('Resource integrity mismatch');
    }
    checkCancelled(task); return result;
  }
  close(): void {
    if (this.closed) return; this.closed = true;
    for (const task of this.tasks.splice(0)) { task.controller.abort(); task.cleanup(); task.reject(abortError()); }
    for (const task of this.running) { clearTimeout(task.timer); task.controller.abort(); }
  }
}

export interface Timed<T> { time: number; seq: number; value: T; discontinuity?: boolean }
export interface SampleResult<T> { value: T; mode: 'hold' | 'interpolate' | 'extrapolate'; sourceTime: number }
/** Per-entity history. Discontinuities take effect at their timestamp; they are never blended across. */
export class Timeline<T> {
  private samples: Timed<T>[] = [];
  constructor(readonly capacity = 64, readonly clone: (value: T) => T = (v: any) => structuredClone(v)) {
    if (!Number.isInteger(capacity) || capacity < 2 || capacity > 4096) throw new RangeError('Invalid history capacity');
  }
  get size() { return this.samples.length; }
  clear() { this.samples = []; }
  insert(sample: Timed<T>): boolean {
    if (!Number.isFinite(sample.time) || !Number.isSafeInteger(sample.seq) || sample.seq < 0) throw new RangeError('Invalid snapshot');
    if (this.samples.some(s => s.seq === sample.seq)) return false;
    const same = this.samples.findIndex(s => s.time === sample.time);
    if (same >= 0) {
      if (this.samples[same]!.seq > sample.seq) return false;
      this.samples.splice(same, 1);
    }
    const copy = { ...sample, value: this.clone(sample.value) };
    const i = this.samples.findIndex(s => s.time > sample.time);
    if (i < 0) this.samples.push(copy); else this.samples.splice(i, 0, copy);
    while (this.samples.length > this.capacity) this.samples.shift(); return true;
  }
  sample(at: number, interpolate: (a: T, b: T, fraction: number) => T,
    extrapolate?: (last: T, previous: T, aheadMs: number, sampleIntervalMs: number) => T,
    maxExtrapolationMs = 100): SampleResult<T> | null {
    if (!Number.isFinite(at) || !Number.isFinite(maxExtrapolationMs) || maxExtrapolationMs < 0) throw new RangeError('Invalid sample time');
    const s = this.samples;
    if (!s.length || s[0]!.time > at) return null;
    let i = s.length - 1; while (i > 0 && s[i]!.time > at) i--;
    const a = s[i]!, b = s[i + 1];
    if (b && !b.discontinuity) return { value: interpolate(this.clone(a.value), this.clone(b.value), (at - a.time) / (b.time - a.time)), mode: 'interpolate', sourceTime: a.time };
    if (!b && extrapolate && i > 0 && at > a.time && !a.discontinuity) {
      const p = s[i - 1]!;
      return { value: extrapolate(this.clone(a.value), this.clone(p.value), Math.min(at - a.time, maxExtrapolationMs), a.time - p.time), mode: 'extrapolate', sourceTime: a.time };
    }
    return { value: this.clone(a.value), mode: 'hold', sourceTime: a.time };
  }
}
export interface PlaybackOptions {
  /** How fast old lateness is forgotten: an observation's weight halves every halfLifeMs (default 2000). */
  halfLifeMs?: number;
  /** Which lateness to cover (default 0.95). */
  percentile?: number;
}
/** Chooses how far behind the server clock to render: the lateness percentile of recent snapshots plus one interval.
 * Lateness is kept as a time-decayed histogram (2 ms buckets), so its memory is a span of time whatever the rate of
 * observations; it grows quickly when the network gets worse and shrinks slowly, so it doesn't oscillate. */
export class AdaptivePlayback {
  private static readonly BUCKET_MS = 2;
  private buckets: Float64Array;
  private total = 0;
  private origin = NaN;
  private cursor = -Infinity;
  readonly halfLifeMs: number;
  readonly percentile: number;
  delayMs: number;
  /** The covered lateness percentile (p95 by default), in ms. */
  latenessMs = 0;
  constructor(readonly intervalMs: number, readonly minMs = intervalMs, readonly maxMs = 400, o: PlaybackOptions = {}) {
    this.halfLifeMs = o.halfLifeMs ?? 2000; this.percentile = o.percentile ?? 0.95;
    if (!(intervalMs > 0) || minMs < 0 || maxMs < minMs || !(this.halfLifeMs > 0) || !(this.percentile > 0 && this.percentile <= 1))
      throw new RangeError('Invalid playback policy');
    this.buckets = new Float64Array(Math.ceil((maxMs + 1000) / AdaptivePlayback.BUCKET_MS) + 1);
    this.delayMs = minMs;
  }
  observe(arrivalOnServerClock: number, sampleTime: number) {
    const late = arrivalOnServerClock - sampleTime;
    if (!Number.isFinite(late) || late < -1000 || late > 30000) return;
    if (Number.isNaN(this.origin)) this.origin = arrivalOnServerClock;
    // newer observations weigh more (rather than older ones decaying), rescaled before the numbers get large
    let w = 2 ** ((arrivalOnServerClock - this.origin) / this.halfLifeMs);
    if (w > 1e9) { const k = 1 / w; for (let i = 0; i < this.buckets.length; i++) this.buckets[i]! *= k; this.total *= k; this.origin = arrivalOnServerClock; w = 1; }
    const i = Math.min(this.buckets.length - 1, Math.floor(Math.max(0, late) / AdaptivePlayback.BUCKET_MS));
    this.buckets[i]! += w; this.total += w;
  }
  advance(serverNow: number, dtMs: number): number {
    if (!Number.isFinite(serverNow) || !Number.isFinite(dtMs) || dtMs < 0) throw new RangeError('Invalid clock');
    if (this.total > 0) {
      const goal = this.total * this.percentile; let sum = 0, i = 0;
      for (; i < this.buckets.length - 1; i++) { sum += this.buckets[i]!; if (sum >= goal) break; }
      this.latenessMs = (i + 1) * AdaptivePlayback.BUCKET_MS;
      const target = Math.max(this.minMs, Math.min(this.maxMs, this.latenessMs + this.intervalMs));
      const rate = target > this.delayMs ? 8 : 0.5;
      this.delayMs += (target - this.delayMs) * (1 - Math.exp(-rate * dtMs / 1000));
    }
    // never backwards (a growing delay holds instead), unless the clock itself jumped far back (a new server, a reset
    // clock): then start over from there rather than freeze until the new clock passes the old one
    const want = serverNow - this.delayMs;
    this.cursor = want < this.cursor - Math.max(1000, 2 * this.maxMs) ? want : Math.max(this.cursor, want); return this.cursor;
  }
  reset() { this.buckets.fill(0); this.total = 0; this.origin = NaN; this.latenessMs = 0; this.cursor = -Infinity; this.delayMs = this.minMs; }
}
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const lerpAngle = (a: number, b: number, t: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
export interface Vec3 { x: number; y: number; z: number }
export const lerpVec3 = (a: Vec3, b: Vec3, t: number): Vec3 => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) });
/** Validate rewind requests against a server-owned time window. This does not itself validate hits or authority. */
export function rewindTime(requested: number, now: number, maxRewindMs: number): number {
  if (![requested, now, maxRewindMs].every(Number.isFinite) || maxRewindMs < 0) throw new RangeError('Invalid rewind');
  return Math.max(now - maxRewindMs, Math.min(now, requested));
}

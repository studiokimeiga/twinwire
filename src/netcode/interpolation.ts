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
export class AdaptivePlayback {
  private lateness: number[] = [];
  private cursor = -Infinity;
  delayMs: number;
  constructor(readonly intervalMs: number, readonly minMs = intervalMs, readonly maxMs = 400) {
    if (!(intervalMs > 0) || minMs < 0 || maxMs < minMs) throw new RangeError('Invalid playback policy');
    this.delayMs = minMs;
  }
  observe(arrivalOnServerClock: number, sampleTime: number) {
    const late = arrivalOnServerClock - sampleTime;
    if (!Number.isFinite(late) || late < -1000 || late > 30000) return;
    this.lateness.push(Math.max(0, late)); if (this.lateness.length > 128) this.lateness.shift();
  }
  advance(serverNow: number, dtMs: number): number {
    if (!Number.isFinite(serverNow) || !Number.isFinite(dtMs) || dtMs < 0) throw new RangeError('Invalid clock');
    if (this.lateness.length) {
      const sorted = [...this.lateness].sort((a, b) => a - b);
      const p95 = sorted[Math.floor((sorted.length - 1) * 0.95)]!;
      const target = Math.max(this.minMs, Math.min(this.maxMs, p95 + this.intervalMs));
      const rate = target > this.delayMs ? 8 : 0.5;
      this.delayMs += (target - this.delayMs) * (1 - Math.exp(-rate * dtMs / 1000));
    }
    this.cursor = Math.max(this.cursor, serverNow - this.delayMs); return this.cursor;
  }
  reset() { this.lateness = []; this.cursor = -Infinity; this.delayMs = this.minMs; }
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

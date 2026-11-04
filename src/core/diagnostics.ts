/** Metadata only: diagnostics never retain application payloads, authentication or resume tokens. */
export interface StateTrace {
  stage: 'queued' | 'sent' | 'received' | 'applied' | 'playback' | 'rendered' | 'discarded';
  epoch: number; stream: number; seq: number;
  localTimeMs: number; sourceTimeMs: number; bytes: number;
  via?: 'ws' | 'rtc' | 'wt';
  queueMs?: number;
  /** Age on the synchronized server clock, including generation/queue/network/browser scheduling. Not one-way RTT. */
  snapshotAgeMs?: number;
  clockUncertaintyMs?: number;
  playbackTimeMs?: number;
  playbackDelayMs?: number;
  reason?: 'coalesced' | 'expired';
}
export type TraceSink = (event: Readonly<StateTrace>) => void;
export interface TraceMetric { count: number; min: number; p50: number; p95: number; p99: number; max: number }
const metric = (values: number[]): TraceMetric | null => {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const at = (p: number) => values[Math.max(0, Math.ceil(values.length * p) - 1)]!;
  return { count: values.length, min: values[0]!, p50: at(.5), p95: at(.95), p99: at(.99), max: at(1) };
};
/** Opt-in bounded flight recorder. No timers; overwrites oldest metadata and returns independent snapshots. */
export class StateTraceBuffer {
  private entries: StateTrace[] = [];
  private cursor = 0;
  overwritten = 0;
  constructor(readonly capacity = 512) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 65536) throw new RangeError('Invalid trace capacity');
  }
  record(event: Readonly<StateTrace>): void {
    // Copy only the documented metadata, even when a JavaScript caller supplies extra private fields.
    const { stage, epoch, stream, seq, localTimeMs, sourceTimeMs, bytes, via, queueMs, snapshotAgeMs,
      clockUncertaintyMs, playbackTimeMs, playbackDelayMs, reason } = event;
    const copy = { stage, epoch, stream, seq, localTimeMs, sourceTimeMs, bytes, via, queueMs, snapshotAgeMs,
      clockUncertaintyMs, playbackTimeMs, playbackDelayMs, reason };
    if (this.entries.length < this.capacity) this.entries.push(copy);
    else { this.entries[this.cursor] = copy; this.cursor = (this.cursor + 1) % this.capacity; this.overwritten++; }
  }
  snapshot(): StateTrace[] {
    const ordered = this.entries.length < this.capacity ? this.entries : [...this.entries.slice(this.cursor), ...this.entries.slice(0, this.cursor)];
    return ordered.map(e => ({ ...e }));
  }
  summary() {
    const events = this.snapshot();
    const values = (key: 'queueMs' | 'snapshotAgeMs' | 'playbackDelayMs', stage: StateTrace['stage']) =>
      events.filter(e => e.stage === stage).map(e => e[key]).filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
    return { retained: events.length, overwritten: this.overwritten, queueMs: metric(values('queueMs', 'sent')),
      receiveAgeMs: metric(values('snapshotAgeMs', 'received')), applyAgeMs: metric(values('snapshotAgeMs', 'applied')),
      playbackDelayMs: metric(values('playbackDelayMs', 'playback')), renderAgeMs: metric(values('snapshotAgeMs', 'rendered')) };
  }
  clear(): void { this.entries = []; this.cursor = 0; this.overwritten = 0; }
}

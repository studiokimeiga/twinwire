/** Input transitions carry a fraction of one simulation tick, independent of the network clock. */
export interface SubtickTransition<T> { fraction: number; value: T }

/**
 * Collect locally timestamped button/analog state changes into fixed-duration input commands.
 * Times must share one monotonic clock, e.g. DOM event.timeStamp and performance.now().
 * Call take() for consecutive tick windows; events exactly on an end boundary belong to the next tick.
 * An overflow or skipped interval is explicit, never silently clamped or dropped.
 */
export class SubtickInputBuffer<T> {
  private queued: { atMs: number; value: T }[] = [];
  private lastEventMs = -Infinity;
  private consumedThroughMs = -Infinity;
  private cloning = false;
  constructor(readonly capacity = 128, readonly clone: (value: T) => T = (v: T) => structuredClone(v)) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4096) throw new RangeError('Invalid subtick capacity');
  }
  get pending() { return this.queued.length; }
  push(atMs: number, value: T): void {
    if (this.cloning) throw new Error('Reentrant subtick clone');
    if (!Number.isFinite(atMs) || atMs < this.lastEventMs || atMs < this.consumedThroughMs)
      throw new RangeError('Nonmonotonic or already-consumed input time');
    if (this.queued.length >= this.capacity) throw new Error('Subtick input buffer full: resync required');
    // Snapshot input values so later mutations cannot change an already recorded command.
    let copy: T;
    this.cloning = true;
    try { copy = this.clone(value); } finally { this.cloning = false; }
    this.queued.push({ atMs, value: copy });
    this.lastEventMs = atMs;
  }
  take(startMs: number, endMs: number, maxPerTick = Math.min(32, this.capacity)): SubtickTransition<T>[] {
    if (this.cloning) throw new Error('Reentrant subtick clone');
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs ||
        !Number.isFinite(endMs - startMs) || startMs < this.consumedThroughMs || !Number.isSafeInteger(maxPerTick) || maxPerTick < 1 || maxPerTick > this.capacity)
      throw new RangeError('Invalid subtick window');
    if (this.queued.length && this.queued[0]!.atMs < startMs)
      throw new Error('Skipped subtick input: resync required');
    let n = 0;
    while (n < this.queued.length && this.queued[n]!.atMs < endMs) n++;
    if (n > maxPerTick) throw new Error('Subtick events exceed per-tick limit: resync required');
    const span = endMs - startMs;
    const out = this.queued.slice(0, n).map(e => ({ fraction: Math.min(1 - Number.EPSILON, (e.atMs - startMs) / span), value: e.value }));
    this.queued.splice(0, n);
    this.consumedThroughMs = endMs;
    return out;
  }
  reset(): void {
    if (this.cloning) throw new Error('Reentrant subtick clone');
    this.queued = [];
    this.lastEventMs = this.consumedThroughMs = -Infinity;
  }
}

/**
 * Replay one tick in chronological segments. Games supply their own deterministic movement,
 * hit/weapon, and collision logic. All events are validated before any callback is invoked.
 * Time within a tick is fractional, not a trusted proof of when a network message was sent.
 */
export function replaySubtick<T>(
  initial: T,
  transitions: readonly SubtickTransition<T>[],
  tickMs: number,
  step: (held: T, dtMs: number, fromFraction: number, toFraction: number) => void,
  change: (before: T, after: T, fraction: number) => void = () => {},
): T {
  if (!Number.isFinite(tickMs) || tickMs <= 0) throw new RangeError('Invalid tick duration');
  let previous = 0;
  // Snapshot the schedule once. A game callback may mutate the original array,
  // but must never change already-validated intervals during this replay.
  const ordered: SubtickTransition<T>[] = [];
  for (const e of transitions) {
    if (!e) throw new RangeError('Invalid or unordered subtick transition');
    const fraction = e.fraction;
    if (!Number.isFinite(fraction) || fraction < previous || fraction >= 1)
      throw new RangeError('Invalid or unordered subtick transition');
    ordered.push({ fraction, value: e.value });
    previous = fraction;
  }
  let held = initial;
  let from = 0;
  for (const e of ordered) {
    if (e.fraction > from) step(held, (e.fraction - from) * tickMs, from, e.fraction);
    change(held, e.value, e.fraction);
    held = e.value;
    from = e.fraction;
  }
  if (from < 1) step(held, (1 - from) * tickMs, from, 1);
  return held;
}

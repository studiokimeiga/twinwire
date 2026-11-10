import { cloneNetcodeValue } from '../core/clone.js';
/** Input transitions carry a fraction of one simulation tick, independent of the network clock. */
export interface SubtickTransition<T> { fraction: number; value: T }

/**
 * Collect locally timestamped button/analog state changes into fixed-duration input commands.
 * Times must share one monotonic clock, e.g. DOM event.timeStamp and performance.now().
 * Call take() for consecutive tick windows; events exactly on an end boundary belong to the next tick.
 *
 * Each value is the whole input state, so timing trouble never throws and never loses the newest state:
 * - Events pushed out of order are sorted into place (equal times keep push order).
 * - An event whose tick was already taken, or whose window was skipped, is applied at the start of the next window
 *   (`late` counts these). Losing it instead could leave a released key held.
 * - An event older than one already taken is out of date, since a newer state was applied, and is dropped.
 * - Overflow, or more events in one tick than `maxPerTick`, drops the earliest transitions.
 * `dropped` counts the last three.
 */
export class SubtickInputBuffer<T> {
  private queued: { atMs: number; value: T }[] = [];
  private lastTakenMs = -Infinity;
  private consumedThroughMs = -Infinity;
  private cloning = false;
  /** Events applied at the start of a later window than their timestamp. */
  late = 0;
  /** Events dropped because a newer state replaced them, or because of overflow. */
  dropped = 0;
  constructor(readonly capacity = 128, readonly clone: (value: T) => T = cloneNetcodeValue) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4096) throw new RangeError('Invalid subtick capacity');
  }
  get pending() { return this.queued.length; }
  push(atMs: number, value: T): void {
    if (this.cloning) throw new Error('Reentrant subtick clone');
    if (!Number.isFinite(atMs)) throw new RangeError('Invalid input time');
    if (atMs < this.lastTakenMs) { this.dropped++; return; }
    // Snapshot input values so later mutations cannot change an already recorded command.
    let copy: T;
    this.cloning = true;
    try { copy = this.clone(value); } finally { this.cloning = false; }
    let at = this.queued.length;
    while (at > 0 && this.queued[at - 1]!.atMs > atMs) at--;
    this.queued.splice(at, 0, { atMs, value: copy });
    if (this.queued.length > this.capacity) { this.queued.shift(); this.dropped++; }
  }
  take(startMs: number, endMs: number, maxPerTick = Math.min(32, this.capacity)): SubtickTransition<T>[] {
    if (this.cloning) throw new Error('Reentrant subtick clone');
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs ||
        !Number.isFinite(endMs - startMs) || startMs < this.consumedThroughMs || !Number.isSafeInteger(maxPerTick) || maxPerTick < 1 || maxPerTick > this.capacity)
      throw new RangeError('Invalid subtick window');
    let n = 0;
    while (n < this.queued.length && this.queued[n]!.atMs < endMs) n++;
    const due = this.queued.splice(0, n);
    if (due.length > maxPerTick) this.dropped += due.splice(0, due.length - maxPerTick).length;
    const span = endMs - startMs;
    const out = due.map(e => {
      if (e.atMs < startMs) this.late++;
      return { fraction: Math.min(1 - Number.EPSILON, Math.max(0, (e.atMs - startMs) / span)), value: e.value };
    });
    if (due.length) this.lastTakenMs = due[due.length - 1]!.atMs;
    this.consumedThroughMs = endMs;
    return out;
  }
  reset(): void {
    if (this.cloning) throw new Error('Reentrant subtick clone');
    this.queued = [];
    this.lastTakenMs = this.consumedThroughMs = -Infinity;
  }
}

/**
 * Replay one tick in chronological segments. Games supply their own deterministic movement,
 * hit/weapon, and collision logic. All events are validated before any callback is invoked.
 * Time within a tick is fractional, not a trusted proof of when a network message was sent.
 * Input values are snapshotted before callbacks (structuredClone by default).
 * To use non-cloneable values, pass a clone function that returns independent copies.
 */
export function replaySubtick<T>(
  initial: T,
  transitions: readonly SubtickTransition<T>[],
  tickMs: number,
  step: (held: T, dtMs: number, fromFraction: number, toFraction: number) => void,
  change: (before: T, after: T, fraction: number) => void = () => {},
  clone: (value: T) => T = cloneNetcodeValue,
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
  // Clone every input before starting simulation. Mutating an original value
  // (or one returned by an earlier callback) must not change a future event.
  // Custom clone implementations must return independent copies to retain this guarantee.
  const snapshot = ordered.map(e => ({ fraction: e.fraction, value: clone(e.value) }));
  let held = clone(initial);
  let from = 0;
  for (const e of snapshot) {
    if (e.fraction > from) step(held, (e.fraction - from) * tickMs, from, e.fraction);
    change(held, e.value, e.fraction);
    held = e.value;
    from = e.fraction;
  }
  if (from < 1) step(held, (1 - from) * tickMs, from, 1);
  return held;
}

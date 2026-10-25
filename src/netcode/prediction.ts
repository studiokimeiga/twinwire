export interface Input<I> { seq: number; value: I }
/** Game-owned step/clone functions keep physics, collision and authority policy outside the transport. */
export class Predictor<S, I> {
  state: S;
  private pending: Input<I>[] = [];
  private seq = 0;
  private ack = 0;
  private serverTick = -1;
  constructor(initial: S, readonly step: (state: S, input: I, dtSeconds: number) => S,
    readonly dtSeconds = 1 / 60, readonly maxPending = 256,
    readonly cloneState: (s: S) => S = (v: any) => structuredClone(v), readonly cloneInput: (i: I) => I = (v: any) => structuredClone(v)) {
    if (!(dtSeconds > 0) || !Number.isFinite(dtSeconds) || !Number.isInteger(maxPending) || maxPending < 1) throw new RangeError('Invalid prediction options');
    this.state = cloneState(initial);
  }
  get lastInput() { return this.seq; }
  get pendingCount() { return this.pending.length; }
  push(value: I): Input<I> {
    if (this.pending.length >= this.maxPending) throw new Error('Prediction history full: resync required');
    if (this.seq >= 0xffffffff) throw new Error('Input sequence exhausted: resync required');
    const frame = { seq: ++this.seq, value: this.cloneInput(value) };
    this.pending.push(frame);
    this.state = this.step(this.cloneState(this.state), this.cloneInput(value), this.dtSeconds);
    return { seq: frame.seq, value: this.cloneInput(frame.value) };
  }
  reconcile(snapshot: { ack: number; tick: number; state: S }): boolean {
    const { ack, tick } = snapshot;
    if (!Number.isSafeInteger(ack) || ack < 0 || ack > this.seq || !Number.isSafeInteger(tick) || tick < 0) throw new Error('Invalid authoritative snapshot');
    if (tick <= this.serverTick) return false;
    if (ack < this.ack) throw new Error('Authoritative acknowledgement regressed');
    this.serverTick = tick; this.ack = ack;
    this.pending = this.pending.filter(i => i.seq > ack);
    let state = this.cloneState(snapshot.state);
    for (const i of this.pending) state = this.step(state, this.cloneInput(i.value), this.dtSeconds);
    this.state = state; return true;
  }
  recent(count = 3): Input<I>[] { return (count <= 0 ? [] : this.pending.slice(-Math.floor(count))).map(i => ({ seq: i.seq, value: this.cloneInput(i.value) })); }
  resync(state: S, tick: number, ack = 0): void {
    if (!Number.isSafeInteger(tick) || tick < 0 || !Number.isSafeInteger(ack) || ack < 0 || ack > 0xffffffff) throw new RangeError('Invalid resync');
    this.state = this.cloneState(state); this.pending = []; this.serverTick = tick; this.ack = this.seq = ack;
  }
}
/** Receiver for redundant input bundles. ACK only the last input actually taken by the simulation. */
export class InputInbox<I> {
  applied = 0;
  private queued = new Map<number, I>();
  constructor(readonly capacity = 256, readonly clone: (i: I) => I = (v: any) => structuredClone(v)) {}
  add(input: Input<I>): boolean {
    if (!Number.isSafeInteger(input.seq) || input.seq <= this.applied || input.seq > this.applied + this.capacity || this.queued.has(input.seq)) return false;
    this.queued.set(input.seq, this.clone(input.value)); return true;
  }
  next(): Input<I> | null {
    const seq = this.applied + 1; if (!this.queued.has(seq)) return null;
    const value = this.queued.get(seq)!; this.queued.delete(seq); this.applied = seq; return { seq, value };
  }
  /** Explicit game policy after an expired input gap. Never called automatically. */
  skipThrough(seq: number) {
    if (!Number.isSafeInteger(seq) || seq < this.applied || seq > this.applied + this.capacity) throw new RangeError('Invalid input skip');
    for (const n of this.queued.keys()) if (n <= seq) this.queued.delete(n); this.applied = seq;
  }
}

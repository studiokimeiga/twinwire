export class TokenBucket {
  private tokens: number;
  private at: number;
  constructor(readonly rate: number, readonly capacity: number, now: number) {
    if (!(rate > 0) || !Number.isFinite(rate) || !(capacity > 0) || !Number.isFinite(capacity)) throw new RangeError('Invalid budget');
    this.tokens = capacity; this.at = now;
  }
  available(now: number): number {
    this.tokens = Math.min(this.capacity, this.tokens + Math.max(0, now - this.at) * this.rate / 1000);
    this.at = Math.max(this.at, now); return this.tokens;
  }
  /** A message larger than the burst may go once the bucket is full; the debt then delays what follows. */
  take(bytes: number, now: number): boolean {
    if (!Number.isFinite(bytes) || bytes < 0) throw new RangeError('Invalid byte count');
    if (this.available(now) < Math.min(bytes, this.capacity)) return false;
    this.tokens -= bytes; return true;
  }
}
/** Two delivery classes share a rate, borrowing only idle positive credit. Oversized event debt cannot eat state's share. */
export class TrafficBudget {
  private credit: [number, number];
  private capacity: [number, number];
  private rates: [number, number];
  private at: number;
  constructor(rate: number, burst: number, stateShare: number, now: number) {
    if (![rate, burst, stateShare, now].every(Number.isFinite) || rate <= 0 || burst <= 0 || stateShare <= 0 || stateShare >= 1)
      throw new RangeError('Invalid traffic budget');
    this.capacity = [burst * stateShare, burst * (1 - stateShare)];
    this.rates = [rate * stateShare, rate * (1 - stateShare)];
    this.credit = [...this.capacity]; this.at = now;
  }
  /** Returns a one-use refund when reserved, or null. A rejected transport write must refund its exact debits. */
  reserve(kind: 'state' | 'event', bytes: number, now: number, protectedOtherBytes: number): (() => void) | null {
    if (!Number.isFinite(bytes) || bytes < 0 || !Number.isFinite(now)) throw new RangeError('Invalid traffic reservation');
    const dt = Math.max(0, now - this.at) / 1000; this.at = Math.max(this.at, now);
    this.credit[0] = Math.min(this.capacity[0], this.credit[0] + dt * this.rates[0]);
    this.credit[1] = Math.min(this.capacity[1], this.credit[1] + dt * this.rates[1]);
    const own = kind === 'state' ? 0 : 1, other = own === 0 ? 1 : 0;
    // Repay this class's debt from surplus positive credit, even while it cannot yet fund its next large packet.
    // Otherwise a quiet state stream leaves its share permanently stranded beside an event's negative balance.
    const surplus = Math.max(0, this.credit[other] - Math.min(this.capacity[other], protectedOtherBytes));
    const loan = Math.min(surplus, this.capacity[own] - this.credit[own]);
    this.credit[own] += loan; this.credit[other] -= loan;
    if (this.credit[own] < Math.min(bytes, this.capacity[own])) return null;
    this.credit[own] -= bytes;
    let refunded = false;
    return () => {
      if (refunded) return; refunded = true;
      this.credit[own] = Math.min(this.capacity[own], this.credit[own] + bytes);
    };
  }
}
export interface EgressEstimate { payloadGB: number; plannedGB: number; bill: number; withinBudget: boolean }
/** Planning estimate, not a bill or a hard cap. Provider prices/allowances are supplied by the caller. */
export function estimateEgress(o: {
  bytesPerSecondPerPlayer: number; averagePlayers: number; activeHours: number;
  baseMonthlyUSD: number; includedGB: number; overageUSDPerGB: number; budgetUSD?: number; overheadFraction?: number;
}): EgressEstimate {
  for (const v of Object.values(o)) if (!Number.isFinite(v) || v < 0) throw new RangeError('Invalid cost input');
  const payloadGB = o.bytesPerSecondPerPlayer * o.averagePlayers * o.activeHours * 3600 / 1e9;
  const plannedGB = payloadGB * (1 + (o.overheadFraction ?? 0.2));
  const bill = o.baseMonthlyUSD + Math.max(0, plannedGB - o.includedGB) * o.overageUSDPerGB;
  return { payloadGB, plannedGB, bill, withinBudget: bill <= (o.budgetUSD ?? 5) };
}

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

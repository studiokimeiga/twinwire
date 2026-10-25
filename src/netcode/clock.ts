/** Offset estimator using low-RTT exchanges. RTT/2 is NOT a measured one-way latency. */
export class NetworkClock {
  private samples: { rtt: number; offset: number }[] = [];
  private offset = 0;
  private target = 0;
  private initialized = false;
  private last = -Infinity;
  get synced() { return this.initialized; }
  rttMs = 0;
  uncertaintyMs = Infinity;
  reset() { this.samples = []; this.offset = this.target = 0; this.initialized = false; this.last = -Infinity; this.uncertaintyMs = Infinity; }
  observe(sent: number, received: number, remoteTime: number): boolean {
    const rtt = received - sent;
    if (![sent, received, remoteTime].every(Number.isFinite) || rtt < 0 || rtt > 15000) return false;
    this.samples.push({ rtt, offset: remoteTime - (sent + received) / 2 });
    if (this.samples.length > 16) this.samples.shift();
    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, 3);
    this.target = best.reduce((sum, s) => sum + s.offset, 0) / best.length;
    this.rttMs = best[0]!.rtt;
    this.uncertaintyMs = Math.max(...best.map(s => Math.abs(s.offset - this.target) + s.rtt / 2));
    if (!this.initialized) { this.offset = this.target; this.initialized = true; }
    return true;
  }
  advance(dtMs: number) {
    if (!Number.isFinite(dtMs) || dtMs < 0) throw new RangeError('Invalid time step');
    const max = dtMs * 0.05; this.offset += Math.max(-max, Math.min(max, this.target - this.offset));
  }
  serverTime(localTime: number): number { this.last = Math.max(this.last, localTime + this.offset); return this.last; }
}

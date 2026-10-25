export class FixedStepper {
  tick = 0; overruns = 0; droppedMs = 0;
  private accumulator = 0;
  readonly dtMs: number;
  constructor(hz = 30, readonly maxCatchUp = 4) {
    if (!(hz > 0) || !Number.isFinite(hz) || !Number.isInteger(maxCatchUp) || maxCatchUp < 1) throw new RangeError('Invalid tick policy');
    this.dtMs = 1000 / hz;
  }
  advance(elapsedMs: number, step: (dtSeconds: number, tick: number) => void): number {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new RangeError('Invalid elapsed time');
    this.accumulator += elapsedMs;
    let n = 0;
    while (this.accumulator + 1e-8 >= this.dtMs && n < this.maxCatchUp) {
      this.accumulator -= this.dtMs; this.tick++; n++; step(this.dtMs / 1000, this.tick);
    }
    if (this.accumulator >= this.dtMs) {
      const discard = Math.floor(this.accumulator / this.dtMs) * this.dtMs;
      this.accumulator -= discard; this.droppedMs += discard; this.overruns++;
    }
    return n;
  }
  get alpha() { return Math.max(0, this.accumulator / this.dtMs); }
}
export const PROFILES = Object.freeze({
  social: { simulationHz: 20, sendHz: 20, bytesPerSecond: 12 * 1024, interpolationMinMs: 50 },
  action: { simulationHz: 60, sendHz: 30, bytesPerSecond: 24 * 1024, interpolationMinMs: 35 },
  strategy: { simulationHz: 10, sendHz: 10, bytesPerSecond: 12 * 1024, interpolationMinMs: 100 },
  turnBased: { simulationHz: 0, sendHz: 0, bytesPerSecond: 8 * 1024, interpolationMinMs: 0 },
});

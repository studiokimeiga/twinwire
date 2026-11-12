import type { StateMessage } from '../core/endpoint.js';
import type { AdaptivePlayback } from '../netcode/interpolation.js';
import type { StateTrace } from '../core/diagnostics.js';

export interface StateReceiverOptions {
  /** The authoritative snapshot stream. Omit for grouped snapshot streams: apply must reject unrelated payloads. */
  stream?: number;
  /** Decode and apply a snapshot synchronously. Return true only when it is usable (including its delta base).
   * False, undefined, or a thrown error cannot release recovery. */
  apply: (state: StateMessage) => boolean;
  /** Clear application-owned snapshot/delta histories. Called before onSession on a new session, and by default on resume. */
  reset?: () => void;
  /** 'reset' (default) clears histories on resume. 'retain' preserves same-session history, but still waits for fresh data. */
  resume?: 'reset' | 'retain';
  /** An optional playback clock: reset automatically with the histories; advance() holds it until recovery is ready. */
  playback?: AdaptivePlayback;
  /** Allowed age beyond the playback delay, including after recovery (default 100 ms). Match the game's prediction cap. */
  maxExtrapolationMs?: number;
}
/** @internal The client supplies lifecycle/clock state; no sockets or timers are owned by a receiver. */
interface ReceiverContext {
  connected: () => boolean;
  generation: () => number;
  now: () => number | null;
  tolerance: () => number;
  remove: () => void;
  trace?: (stage: StateTrace['stage'], state: Pick<StateMessage, 'stream' | 'seq' | 'time' | 'via'> & { data?: Uint8Array },
    details?: Pick<StateTrace, 'playbackTimeMs' | 'playbackDelayMs'>) => void;
}

/** A session-aware state stream. Create with GameClient.receiveState(), rather than wiring reconnect flags yourself. */
export class StateReceiver {
  private newest = -Infinity;
  private waiting = true;
  private resetOK = true;
  private disposed = false;
  private last?: Pick<StateMessage, 'stream' | 'seq' | 'time' | 'via'>;
  private readonly maxExtrapolation: number;
  private readonly options: StateReceiverOptions;
  constructor(private readonly context: ReceiverContext, options: StateReceiverOptions) {
    const { stream, resume = 'reset', maxExtrapolationMs = 100, apply, reset, playback } = options;
    if (stream !== undefined && (!Number.isInteger(stream) || stream < 0 || stream > 65535)) throw new RangeError('Invalid snapshot stream');
    if (resume !== 'reset' && resume !== 'retain') throw new RangeError('Invalid resume policy');
    if (!Number.isFinite(maxExtrapolationMs) || maxExtrapolationMs < 0 || maxExtrapolationMs > 30000)
      throw new RangeError('Invalid extrapolation limit');
    if (typeof apply !== 'function' || (reset !== undefined && typeof reset !== 'function')) throw new TypeError('Invalid state callbacks');
    if (playback && (typeof playback.advance !== 'function' || typeof playback.reset !== 'function' ||
        typeof playback.updateDelay !== 'function')) throw new TypeError('Invalid playback');
    this.maxExtrapolation = maxExtrapolationMs; this.options = { ...options };
  }
  /** The session is online, its clock synced, and this connection has supplied a usable snapshot recent enough for
   * the playback delay/prediction cap. A retained clock, events, or unrelated state cannot satisfy this.
   * Freshness is checked continuously: online traffic with stale generation times holds playback too. */
  get ready(): boolean {
    if (this.disposed || !this.resetOK || !this.context.connected()) return false;
    const now = this.context.now();
    if (now === null) return false;
    if (this.newest > now + this.context.tolerance() ||
        this.newest + this.maxExtrapolation < now - (this.options.playback?.delayMs ?? 0)) {
      this.waiting = true; return false;
    }
    this.waiting = false; return true;
  }
  /** Return a safe render time, or null to keep the last rendered view while recovering. Outbound input and reliable
   * events are independent. Use this instead of calling the supplied playback.advance() directly. */
  advance(dtMs: number): number | null {
    if (!this.options.playback) throw new Error('State receiver needs a playback to advance');
    if (!Number.isFinite(dtMs) || dtMs < 0) throw new RangeError('Invalid frame duration');
    if (this.disposed || !this.resetOK || !this.context.connected() || this.context.now() === null) return null;
    // The new route may be slower: learn its delay while holding the old cursor, otherwise the fresh-data gate
    // could wait forever for data to fit the previous route's smaller buffer. Adapt exactly once per frame.
    this.options.playback.updateDelay(dtMs);
    if (!this.ready) return null;
    const now = this.context.now()!, at = this.options.playback.advance(now, 0);
    if (this.last) this.context.trace?.('playback', this.last, { playbackTimeMs: at, playbackDelayMs: now - at });
    return at;
  }
  /** Mark when the game submits a frame, optionally with the actual sampled snapshot time. This is not GPU presentation. */
  markRendered(sourceTimeMs = this.last?.time): void {
    if (!this.ready || !this.last || sourceTimeMs === undefined) return;
    if (!Number.isFinite(sourceTimeMs)) throw new RangeError('Invalid render source time');
    this.context.trace?.('rendered', { ...this.last, time: sourceTimeMs });
  }
  /** Remove the receiver without closing the session. A disposed receiver never becomes ready again. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.disconnect(); this.context.remove();
  }
  /** @internal */
  disconnect(): void { this.waiting = true; this.newest = -Infinity; this.last = undefined; }
  /** @internal Called before application session callbacks, even if disconnect/reconnect happened between render frames. */
  session(resumed: boolean): void {
    this.disconnect();
    if (!resumed || this.options.resume !== 'retain') {
      this.resetOK = false;
      this.options.playback?.reset(); this.options.reset?.();
      this.resetOK = true; // a failed reset remains blocked and is reported by the client
    }
  }
  /** @internal Only the client's epoch-checked incoming path calls this, synchronously. True when `apply` took the
   * state, which is what lets the client acknowledge it. */
  receive(state: StateMessage): boolean {
    if (this.disposed || !this.resetOK || !this.context.connected() ||
        (this.options.stream !== undefined && state.stream !== this.options.stream)) return false;
    const arrival = this.context.now();
    if (!Number.isFinite(state.time) || (arrival !== null && state.time > arrival + this.context.tolerance())) return false;
    const generation = this.context.generation();
    if (this.options.apply(state) !== true) return false;
    if (generation !== this.context.generation()) return false;   // a new session reset the histories during apply
    if (!this.context.connected()) return true;
    const now = this.context.now(), tolerance = this.context.tolerance();
    if (!Number.isFinite(state.time) || (now !== null && state.time > now + tolerance)) return true;
    // A sample received before clock sync must not poison subsequent freshness if its time proves implausible.
    if (now !== null && this.newest > now + tolerance) this.newest = -Infinity;
    this.newest = Math.max(this.newest, state.time);
    if (this.context.trace && (!this.last || state.time >= this.last.time))
      this.last = { stream: state.stream, seq: state.seq, time: state.time, via: state.via };
    this.context.trace?.('applied', state);
    const playback = this.options.playback;
    if (this.waiting && playback && now !== null && now - state.time <= playback.maxMs + this.maxExtrapolation)
      playback.observe(now, state.time); // valid current headers teach recovery, including unchanged idle entities
    return true;
  }
}

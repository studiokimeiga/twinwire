import { SubtickInputBuffer, replaySubtick, selectRewindTime } from '../dist/netcode/index.js';

// Deterministic application/network model, not a measurement of internet latency.
// World and times use server-owned virtual milliseconds. Only snapshots can be lost;
// shot commands use Twinwire's reliable event path in the separate transport test.
export const TICK_MS = 1000 / 64;
export const SNAPSHOT_MS = TICK_MS;
export const INTERPOLATION_MS = 32;
export const REACTION_MS = 100;
export const MAX_REWIND_MS = 250;
export const TOLERANCE_MS = 45;

export const PROFILES = Object.freeze([
  { name: 'rtt-0', upMs: 0, downMs: 0, jitterMs: 0, snapshotLoss: 0 },
  { name: 'rtt-50', upMs: 25, downMs: 25, jitterMs: 0, snapshotLoss: 0 },
  { name: 'rtt-100', upMs: 50, downMs: 50, jitterMs: 0, snapshotLoss: 0 },
  { name: 'rtt-200', upMs: 100, downMs: 100, jitterMs: 0, snapshotLoss: 0 },
  { name: 'downlink-heavy', upMs: 20, downMs: 80, jitterMs: 20, snapshotLoss: 0.1 },
  { name: 'uplink-heavy', upMs: 80, downMs: 20, jitterMs: 20, snapshotLoss: 0.1 },
]);

function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}
function validateProfile(p) {
  if (!p || ![p.upMs, p.downMs, p.jitterMs, p.snapshotLoss].every(Number.isFinite) ||
      p.upMs < 0 || p.downMs < 0 || p.jitterMs < 0 ||
      p.snapshotLoss < 0 || p.snapshotLoss > 1) throw new RangeError('Invalid network profile');
}
const jittered = (base, jitterMs, random) => Math.max(0, base + (random() * 2 - 1) * jitterMs);

// A peeker leaves cover at t=450 ms and returns behind cover at t=750 ms.
// The holder remains at x=5. A vertical wall at x=0 blocks shots across it.
export function peekerX(t) {
  if (t < 400) return -1;
  if (t < 500) return -1 + (t - 400) / 50;
  if (t < 700) return 1;
  if (t < 800) return 1 - (t - 700) / 50;
  return -1;
}

export function makeHistory(endMs = 1250) {
  const frames = [];
  for (let i = 0; i <= Math.ceil(endMs / TICK_MS); i++) {
    frames.push({ atMs: i * TICK_MS, peekerX: peekerX(i * TICK_MS), holderX: 5 });
  }
  return frames;
}
export function sampleHistory(history, player, t) {
  if (!Number.isFinite(t) || t < 0 || t > history.at(-1).atMs) return null;
  const i = Math.floor(t / TICK_MS);
  const a = history[i], b = history[Math.min(i + 1, history.length - 1)];
  if (!a || !b) return null;
  const fraction = b.atMs === a.atMs ? 0 : (t - a.atMs) / (b.atMs - a.atMs);
  const key = player === 'peeker' ? 'peekerX' : 'holderX';
  return { x: a[key] + (b[key] - a[key]) * fraction, y: 0 };
}

export function makeFireTransitions(fireAtMs) {
  const queue = new SubtickInputBuffer(4);
  const start = Math.floor(fireAtMs / TICK_MS) * TICK_MS;
  queue.push(fireAtMs, { fire: true });
  return queue.take(start, start + TICK_MS);
}

// firedAtServerMs and expectedViewTimeMs must be server-owned estimates. Neither
// client input fractions nor a client-reported snapshot ACK authenticate shot time.
export function adjudicateShot({
  role, arrivalMs, firedAtServerMs, requestedViewTimeMs, expectedViewTimeMs,
  transitions, history, aimY = 0, maxRewindMs = MAX_REWIND_MS,
  toleranceMs = TOLERANCE_MS, maxInputAgeMs = 250,
}) {
  const reject = reason => ({ result: 'rejected', reason, source: 'none', timeMs: null });
  if ((role !== 'peeker' && role !== 'holder') || !Number.isFinite(arrivalMs) ||
      !Number.isFinite(firedAtServerMs) || !Number.isFinite(aimY) ||
      !Number.isFinite(maxInputAgeMs) || maxInputAgeMs < 0 ||
      !Array.isArray(transitions) || !transitions.length || transitions.length > 32)
    return reject('invalid-command');
  const age = arrivalMs - firedAtServerMs;
  if (age < 0 || age > maxInputAgeMs) return reject('input-outside-window');

  let presses = 0;
  try {
    replaySubtick({ fire: false }, transitions, TICK_MS, () => {},
      (before, after) => {
        if (!before.fire && after.fire) presses++;
      });
  } catch {
    return reject('invalid-subtick');
  }
  if (presses !== 1) return reject('invalid-fire-edges');

  let chosen;
  try {
    chosen = selectRewindTime(requestedViewTimeMs, arrivalMs,
      expectedViewTimeMs, maxRewindMs, toleranceMs);
  } catch {
    return reject('invalid-rewind-policy');
  }
  if (chosen.timeMs === null) return reject(chosen.reason);

  const shooter = sampleHistory(history, role, firedAtServerMs);
  const targetRole = role === 'peeker' ? 'holder' : 'peeker';
  const target = sampleHistory(history, targetRole, chosen.timeMs);
  if (!shooter || !target) return reject('history-not-retained');

  // Simplified 2D horizontal ray against a radius-0.3 player hitbox. The wall
  // is between x<=0 and x>0, checked at the authoritative shooter and target times.
  const exposed = role === 'peeker' ? shooter.x > 0 : target.x > 0;
  const direction = role === 'peeker' ? 1 : -1;
  const ahead = (target.x - shooter.x) * direction;
  const hit = exposed && ahead > 0 && Math.abs(aimY - target.y) <= 0.3;
  return {
    result: hit ? 'hit' : 'miss', reason: hit ? 'confirmed' : 'cover-or-aim',
    source: chosen.source, timeMs: chosen.timeMs, rewindReason: chosen.reason,
  };
}

export function runTrial(profile, seed = 1) {
  validateProfile(profile);
  const random = rng(seed), history = makeHistory();
  const snapshots = [];
  for (let at = 0; at <= 1100; at += SNAPSHOT_MS) {
    if (random() < profile.snapshotLoss) continue;
    snapshots.push({
      atMs: at,
      viewTimeMs: Math.max(0, at - INTERPOLATION_MS),
      deliveredMs: at + jittered(profile.downMs, profile.jitterMs, random),
    });
  }
  snapshots.sort((a, b) => a.deliveredMs - b.deliveredMs || a.atMs - b.atMs);

  // Newer snapshots supersede delayed/out-of-order older ones.
  let newest = -1, firstVisible = null;
  for (const packet of snapshots) {
    if (packet.atMs <= newest) continue;
    newest = packet.atMs;
    if ((sampleHistory(history, 'peeker', packet.viewTimeMs)?.x ?? -1) > 0) {
      firstVisible = packet;
      break;
    }
  }
  function shoot(role, fireMs) {
    if (fireMs === null) return null;
    const latest = snapshots
      .filter(p => p.deliveredMs <= fireMs)
      .reduce((a, b) => (!a || b.atMs > a.atMs ? b : a), null);
    if (!latest) return null;
    const arrivalMs = fireMs + jittered(profile.upMs, profile.jitterMs, random);
    // Impairment oracle: known mean one-way delays + interpolation + half a
    // snapshot interval. Production servers need measured server-owned data.
    const expectedViewTimeMs = arrivalMs - profile.upMs - profile.downMs -
      INTERPOLATION_MS - SNAPSHOT_MS / 2;
    return {
      clientFireMs: fireMs,
      ...adjudicateShot({
        role, arrivalMs, firedAtServerMs: fireMs,
        requestedViewTimeMs: latest.viewTimeMs,
        expectedViewTimeMs, transitions: makeFireTransitions(fireMs), history,
      }),
    };
  }
  const peeker = shoot('peeker', 450 + REACTION_MS);
  const holder = shoot('holder', firstVisible ? firstVisible.deliveredMs + REACTION_MS : null);
  return {
    peeker, holder,
    advantageMs: peeker && holder ? holder.clientFireMs - peeker.clientFireMs : null,
    deliveredSnapshots: snapshots.length,
  };
}
function rounded(value) { return value === null ? null : Math.round(value * 100) / 100; }
function median(values) {
  if (!values.length) return null;
  const a = values.toSorted((x, y) => x - y), i = Math.floor(a.length / 2);
  return rounded(a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2);
}
export function runMatrix({ profiles = PROFILES, trials = 128, seed = 0x1a21f005 } = {}) {
  if (!Number.isSafeInteger(trials) || trials < 1 || trials > 10000)
    throw new RangeError('Invalid trial count');
  return profiles.map((profile, p) => {
    validateProfile(profile);
    const runs = Array.from({ length: trials }, (_, i) =>
      runTrial(profile, (seed + Math.imul(p + 1, 0x9e3779b1) + i) >>> 0));
    const shots = runs.flatMap(r => [r.peeker, r.holder].filter(Boolean));
    const advantages = runs.map(r => r.advantageMs).filter(v => v !== null);
    const total = shots.length;
    return {
      name: profile.name, rttMs: profile.upMs + profile.downMs,
      upMs: profile.upMs, downMs: profile.downMs,
      jitterMs: profile.jitterMs, snapshotLoss: profile.snapshotLoss,
      trials, shots: total,
      hitRate: total ? rounded(shots.filter(s => s.result === 'hit').length / total) : null,
      rejectRate: total ? rounded(shots.filter(s => s.result === 'rejected').length / total) : null,
      fallbackRate: total ? rounded(shots.filter(s => s.source === 'server').length / total) : null,
      peekerAdvantageMedianMs: median(advantages),
      peekerFiredFirstRate: advantages.length ?
        rounded(advantages.filter(v => v > 0).length / advantages.length) : null,
      observationPairs: advantages.length,
    };
  });
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const results = runMatrix();
  console.log(JSON.stringify({
    model: 'synthetic virtual-time FPS peek/hold; not measured real-world fairness',
    tickHz: 64, snapshotHz: 64, interpolationMs: INTERPOLATION_MS,
    reactionMs: REACTION_MS, maxRewindMs: MAX_REWIND_MS,
    toleranceMs: TOLERANCE_MS, shotDelivery: 'reliable (no modeled shot loss)',
    snapshotDelivery: 'lossy, delayed, jittered',
    results,
  }, null, 2));
}

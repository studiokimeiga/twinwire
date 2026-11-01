/**
 * Rewind time selection does not authenticate input, delivery or visibility.
 * Games must derive expectedViewTimeMs from independent server observations,
 * validate the shot, and choose their own history and tolerance policy.
 */
export type ValidatedRewind =
  | { timeMs: number; source: 'client'; reason: 'accepted' }
  | { timeMs: number; source: 'server'; reason: 'missing' | 'invalid' | 'outside-window' | 'outside-tolerance' }
  | { timeMs: null; source: 'none'; reason: 'expected-outside-window' };

/**
 * Use the client's requested historical viewing time only when it is plausible
 * against the independently server-derived estimate, within retained history.
 * If that estimate itself falls outside history (or into the future), no
 * defensible rewind is available. Do not silently clamp and call it validated.
 */
export function selectRewindTime(
  requestedViewTimeMs: number | undefined,
  nowMs: number,
  expectedViewTimeMs: number,
  maxRewindMs: number,
  toleranceMs: number,
): ValidatedRewind {
  if (![nowMs, expectedViewTimeMs, maxRewindMs, toleranceMs].every(Number.isFinite) ||
      maxRewindMs < 0 || toleranceMs < 0) throw new RangeError('Invalid rewind policy');
  const earliest = nowMs - maxRewindMs;
  if (!Number.isFinite(earliest)) throw new RangeError('Invalid rewind interval');
  if (expectedViewTimeMs < earliest || expectedViewTimeMs > nowMs)
    return { timeMs: null, source: 'none', reason: 'expected-outside-window' };

  const fallback = (reason: 'missing' | 'invalid' | 'outside-window' | 'outside-tolerance'): ValidatedRewind =>
    ({ timeMs: expectedViewTimeMs, source: 'server', reason });
  if (requestedViewTimeMs === undefined) return fallback('missing');
  if (typeof requestedViewTimeMs !== 'number' || !Number.isFinite(requestedViewTimeMs)) return fallback('invalid');
  if (requestedViewTimeMs < earliest || requestedViewTimeMs > nowMs) return fallback('outside-window');
  if (Math.abs(requestedViewTimeMs - expectedViewTimeMs) > toleranceMs) return fallback('outside-tolerance');
  return { timeMs: requestedViewTimeMs, source: 'client', reason: 'accepted' };
}

/** Selection only: the game must compute expectedViewTimeMs from server-observed data,
 * validate the shot, and check the hitboxes. Neither a client ACK nor a requested
 * timestamp is proof of delivery, visibility or legitimate timing. */
export type ValidatedRewind = {
  timeMs: number;
  source: 'client' | 'server';
  reason: 'accepted' | 'missing' | 'invalid' | 'outside-window' | 'outside-tolerance';
};

/**
 * Use a client-requested historical time only when it is consistent with the server's
 * independently estimated view time and the hard history window. Otherwise fall back
 * to the bounded server estimate, as in Source-style lag compensation.
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
  const expected = Math.min(nowMs, Math.max(earliest, expectedViewTimeMs));
  const fallback = (reason: ValidatedRewind['reason']): ValidatedRewind => ({ timeMs: expected, source: 'server', reason });
  if (requestedViewTimeMs === undefined) return fallback('missing');
  if (typeof requestedViewTimeMs !== 'number' || !Number.isFinite(requestedViewTimeMs)) return fallback('invalid');
  if (requestedViewTimeMs < earliest || requestedViewTimeMs > nowMs) return fallback('outside-window');
  if (Math.abs(requestedViewTimeMs - expected) > toleranceMs) return fallback('outside-tolerance');
  return { timeMs: requestedViewTimeMs, source: 'client', reason: 'accepted' };
}

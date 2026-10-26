import type { Json, JsonInput } from './protocol.js';
/** Named streams are a convenience for existing games. Both peers use the same mapping.
 * Unmapped names are reliable events; mapped names are independent latest-wins JSON states. */
export type LatestChannels = Readonly<Record<string, number>>;
export type ChannelHandler = (data: Json) => unknown;
export const channelName = (name: unknown): name is string =>
  typeof name === 'string' && /^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,63}$/.test(name);
export function channelSchema(latest: LatestChannels = {}): Map<string, number> {
  const entries = Object.entries(latest);
  if (entries.length > 1024) throw new RangeError('Too many named state channels');
  const streams = new Set<number>();
  for (const [name, stream] of entries) {
    if (!channelName(name) || !Number.isInteger(stream) || stream < 1 || stream > 65535 || streams.has(stream))
      throw new TypeError('Named states need valid names and unique streams from 1 to 65535');
    streams.add(stream);
  }
  return new Map(entries);
}
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
export function encodeChannel(data: JsonInput): Uint8Array {
  return encoder.encode(JSON.stringify(data ?? null));
}
export function decodeChannel(data: Uint8Array): Json | undefined {
  try { return JSON.parse(decoder.decode(data)) as Json; } catch { return undefined; }
}
export function namedEvent(data: Json): { name: string; data: Json } | null {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !channelName(data.name) || !('data' in data)) return null;
  return { name: data.name, data: data.data };
}

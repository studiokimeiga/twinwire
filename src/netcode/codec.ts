export type Scalar = 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'f32' | 'f64';
export interface Field { type: Scalar; scale?: number }
const sizes: Record<Scalar, number> = { u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, f32: 4, f64: 8 };
const bounds: Record<Scalar, [number, number]> = {
  u8: [0, 255], i8: [-128, 127], u16: [0, 65535], i16: [-32768, 32767], u32: [0, 4294967295],
  f32: [-3.4028234663852886e38, 3.4028234663852886e38], f64: [-Number.MAX_VALUE, Number.MAX_VALUE],
};
export function defineSchema<F extends Record<string, Field>>(schema: F) {
  type State = { [K in keyof F]: number };
  const fields = Object.entries(schema).map(([key, f]) => ({ key, type: f.type, scale: f.scale ?? 1 }));
  for (const f of fields) if (!Object.hasOwn(sizes, f.type) || !(f.scale > 0) || !Number.isFinite(f.scale) || ['__proto__', 'prototype', 'constructor'].includes(f.key)) throw new RangeError('Invalid field');
  const byteLength = fields.reduce((n, f) => n + sizes[f.type], 0);
  if (!byteLength || byteLength > 1078) throw new RangeError('Schema must fit one state payload');
  return {
    byteLength,
    encode(value: State): Uint8Array {
      const b = new Uint8Array(byteLength), v = new DataView(b.buffer); let at = 0;
      for (const f of fields) {
        const source = value[f.key as keyof F];
        if (!Number.isFinite(source)) throw new RangeError(`Invalid ${f.key}`);
        let n = source * f.scale;
        if (!f.type.startsWith('f')) n = Math.round(n);
        const [min, max] = bounds[f.type]; if (!Number.isFinite(n) || n < min || n > max) throw new RangeError(`Out of range: ${f.key}`);
        switch (f.type) {
          case 'u8': v.setUint8(at, n); break; case 'i8': v.setInt8(at, n); break;
          case 'u16': v.setUint16(at, n, true); break; case 'i16': v.setInt16(at, n, true); break;
          case 'u32': v.setUint32(at, n, true); break; case 'f32': v.setFloat32(at, n, true); break; case 'f64': v.setFloat64(at, n, true); break;
        }
        at += sizes[f.type];
      }
      return b;
    },
    decode(b: Uint8Array): State | null {
      if (b.length !== byteLength) return null;
      const v = new DataView(b.buffer, b.byteOffset, b.byteLength), out = Object.create(null) as State; let at = 0;
      for (const f of fields) {
        let n: number;
        switch (f.type) {
          case 'u8': n = v.getUint8(at); break; case 'i8': n = v.getInt8(at); break;
          case 'u16': n = v.getUint16(at, true); break; case 'i16': n = v.getInt16(at, true); break;
          case 'u32': n = v.getUint32(at, true); break; case 'f32': n = v.getFloat32(at, true); break; case 'f64': n = v.getFloat64(at, true); break;
        }
        if (!Number.isFinite(n) || !Number.isFinite(n / f.scale)) return null; out[f.key as keyof F] = n / f.scale; at += sizes[f.type];
      }
      return out;
    },
  };
}

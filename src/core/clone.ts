/**
 * Clone netcode inputs on Safari 15.0-15.3, which do not expose structuredClone.
 * The fallback supports plain state data and common built-in collections; unsupported
 * platform objects fail explicitly rather than silently changing the input.
 * Applications with specialized input types can still supply their own clone callback.
 */
type TypedArrayConstructor = {
  new (buffer: ArrayBuffer, byteOffset?: number, length?: number): ArrayBufferView;
  readonly BYTES_PER_ELEMENT: number;
};
const typedArrays: Record<string, TypedArrayConstructor> = {
  '[object Int8Array]': Int8Array,
  '[object Uint8Array]': Uint8Array,
  '[object Uint8ClampedArray]': Uint8ClampedArray,
  '[object Int16Array]': Int16Array,
  '[object Uint16Array]': Uint16Array,
  '[object Int32Array]': Int32Array,
  '[object Uint32Array]': Uint32Array,
  '[object Float32Array]': Float32Array,
  '[object Float64Array]': Float64Array,
  '[object BigInt64Array]': BigInt64Array,
  '[object BigUint64Array]': BigUint64Array,
};

export function cloneNetcodeValue<T>(value: T): T {
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
  const seen = new Map<object, unknown>();
  const clone = (source: unknown): unknown => {
    if (source === null || typeof source !== 'object') {
      if (typeof source === 'function' || typeof source === 'symbol') throw new TypeError('Input value is not cloneable');
      return source;
    }
    if (seen.has(source)) return seen.get(source);
    if (source instanceof Date) {
      const result = new Date(source.getTime()); seen.set(source, result); return result;
    }
    if (source instanceof RegExp) {
      const result = new RegExp(source.source, source.flags); seen.set(source, result); return result;
    }
    if (source instanceof ArrayBuffer) {
      const result = source.slice(0); seen.set(source, result); return result;
    }
    if (ArrayBuffer.isView(source)) {
      const buffer = clone(source.buffer) as ArrayBuffer;
      let result: ArrayBufferView;
      if (source instanceof DataView) result = new DataView(buffer, source.byteOffset, source.byteLength);
      else {
        const Ctor = typedArrays[Object.prototype.toString.call(source)];
        if (!Ctor) throw new TypeError('Unsupported input view; provide a custom clone function');
        result = new Ctor(buffer, source.byteOffset, source.byteLength / Ctor.BYTES_PER_ELEMENT);
      }
      seen.set(source, result); return result;
    }
    if (source instanceof Map) {
      const result = new Map(); seen.set(source, result);
      for (const [key, item] of source) result.set(clone(key), clone(item));
      return result;
    }
    if (source instanceof Set) {
      const result = new Set(); seen.set(source, result);
      for (const item of source) result.add(clone(item));
      return result;
    }
    const array = Array.isArray(source);
    if (!array) {
      const prototype = Object.getPrototypeOf(source);
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError('Unsupported input object; provide a custom clone function');
    }
    const result = array ? new Array(source.length) : {};
    seen.set(source, result);
    for (const key of Object.keys(source)) {
      Object.defineProperty(result, key, {
        value: clone((source as Record<string, unknown>)[key]), enumerable: true,
        writable: true, configurable: true,
      });
    }
    return result;
  };
  return clone(value) as T;
}

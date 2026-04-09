const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export const fnvInit = (): number => FNV_OFFSET;

export const fnvFeedString = (hash: number, value: string): number => {
  let next = hash;
  for (let i = 0; i < value.length; i++) {
    next ^= value.charCodeAt(i);
    next = Math.imul(next, FNV_PRIME);
  }
  return next >>> 0;
};

export const fnvFeedU32 = (hash: number, value: number): number => {
  let next = hash >>> 0;
  next ^= value & 0xff;
  next = Math.imul(next, FNV_PRIME);
  next ^= (value >>> 8) & 0xff;
  next = Math.imul(next, FNV_PRIME);
  next ^= (value >>> 16) & 0xff;
  next = Math.imul(next, FNV_PRIME);
  next ^= (value >>> 24) & 0xff;
  next = Math.imul(next, FNV_PRIME);
  return next >>> 0;
};

export const fnv1a = (input: string): number => fnvFeedString(fnvInit(), input);

// Feed at most the first `headLen` and last `tailLen` characters of `value`.
// Produces an O(1)-bounded hash that still catches most real-world content
// differences (same-length strings differing only in the middle are the
// theoretical blind-spot, acceptable for seam-probe use).
const BOUNDED_HEAD = 32;
const BOUNDED_TAIL = 32;
export const fnvFeedStringBounded = (hash: number, value: string): number => {
  const len = value.length;
  if (len <= BOUNDED_HEAD + BOUNDED_TAIL) return fnvFeedString(hash, value);
  let h = hash;
  for (let i = 0; i < BOUNDED_HEAD; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  for (let i = len - BOUNDED_TAIL; i < len; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
};

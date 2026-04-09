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

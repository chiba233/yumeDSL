const warned = new Set<string>();

const shouldWarn = (): boolean => {
  try {
    if (typeof process !== "undefined" && process.env?.NODE_ENV === "production") {
      return false;
    }
  } catch {}
  return true;
};

/** Emit a deprecation warning once per key. Suppressed when `NODE_ENV=production`. */
export const warnDeprecated = (key: string, message: string) => {
  if (warned.has(key)) return;
  warned.add(key);
  if (!shouldWarn()) return;
  console.warn(`[yume-dsl-rich-text] Deprecated: ${message}`);
};

/**
 * Internal-use flag. When true, ambient state functions skip deprecation warnings.
 * Set by parseRichText during its internal withSyntax/withCreateId wrapping.
 */
let internalCaller = false;

export const isInternalCaller = () => internalCaller;

export const withInternalCaller = <T>(fn: () => T): T => {
  const prev = internalCaller;
  internalCaller = true;
  try {
    return fn();
  } finally {
    internalCaller = prev;
  }
};

const warned = new Set<string>();

/** Emit a deprecation warning once per key. */
export const warnDeprecated = (key: string, message: string) => {
  if (warned.has(key)) return;
  warned.add(key);
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

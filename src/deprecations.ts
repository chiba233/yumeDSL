const warned = new Set<string>();

interface DeprecationOptions {
  suppress?: boolean;
}

const shouldWarn = (): boolean => {
  try {
    if (typeof process !== "undefined" && process.env?.NODE_ENV === "production") {
      return false;
    }
  } catch {}
  return true;
};

/** Emit a deprecation warning once per key. Suppressed when `NODE_ENV=production`. */
export const warnDeprecated = (
  key: string,
  message: string,
  options?: DeprecationOptions,
) => {
  if (options?.suppress) return;
  if (warned.has(key)) return;
  warned.add(key);
  if (!shouldWarn()) return;
  const line = `[yume-dsl-rich-text] Deprecated: ${message}`;
  try {
    if (typeof process !== "undefined" && typeof process.stderr?.write === "function") {
      process.stderr.write(`${line}\n`);
      return;
    }
  } catch {}
  console.warn(line);
};

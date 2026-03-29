import type { CreateId, TokenDraft } from "./types.js";

export interface EasyStableIdOptions {
  /** Prefix prepended to every generated ID. Default: `"s"`. */
  prefix?: string;
  /**
   * Custom fingerprint function.
   *
   * Receives the {@link TokenDraft} and returns a string used as hash
   * input.  The return value can be arbitrarily long — it will be
   * hashed (FNV-1a 32-bit) to produce the final ID.
   *
   * Default: `type` + `value` (recursive for nested tokens).
   *
   * Because `TokenDraft` has an index signature (`[key: string]: unknown`),
   * handler-attached fields are accessible but typed as `unknown` — narrow
   * before use.
   *
   * @example
   * ```ts
   * // Include a handler-attached field (narrow from unknown)
   * createEasyStableId({
   *   fingerprint: (t) => {
   *     const lang = typeof t.lang === "string" ? t.lang : "";
   *     return `${t.type}:${lang}:${typeof t.value === "string" ? t.value : ""}`;
   *   },
   * });
   * ```
   */
  fingerprint?: (token: TokenDraft) => string;
}

// ── FNV-1a 32-bit ──

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a 32-bit hash from a complete string. */
const fnv1a = (input: string): number => {
  let h = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
};

/** Feed a string segment into a running FNV-1a state, return updated state. */
const feed = (h: number, s: string): number => {
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h;
};

/**
 * Serialize a TokenDraft's `type` + `value` structure into a running
 * FNV-1a hash state and return the updated state.
 *
 * Produces the same hash as `fnv1a(defaultFingerprint(draft))` — the
 * character sequence fed into the hash is identical, just without
 * building the intermediate fingerprint string.
 */
const hashDraftInto = (h: number, draft: TokenDraft): number => {
  h = feed(h, draft.type);
  if (typeof draft.value === "string") {
    h = feed(h, ":");
    h = feed(h, draft.value);
    return h;
  }
  h = feed(h, ":[");
  for (let i = 0; i < draft.value.length; i++) {
    if (i > 0) h = feed(h, ",");
    h = hashDraftInto(h, draft.value[i]);
  }
  h = feed(h, "]");
  return h;
};

/**
 * Create a **parse-session scoped, stateful** {@link CreateId} generator
 * that produces content-based stable IDs.
 *
 * Each call returns a fresh closure with its own disambiguation counter.
 * The counter tracks how many times each fingerprint hash has been seen
 * *within this generator's lifetime*, so the scope of uniqueness is
 * determined by how you wire it:
 *
 * - **One generator per parse** → IDs are independent across documents.
 * - **One generator shared across parses** → IDs are unique across all
 *   documents that share the generator, but the counter carries over.
 *
 * Unlike the default sequential counter (`rt-0`, `rt-1`, …), stable IDs
 * are derived from the token's fingerprint rather than stream position.
 *
 * **Stability guarantees:**
 * - Edits with a different fingerprint: stable (no effect on other IDs).
 * - Duplicate fingerprints: disambiguated by occurrence order
 *   (`s-abc`, `s-abc-1`, …).  Inserting a new duplicate before an
 *   existing one will shift the suffix of subsequent duplicates.
 *
 * The underlying hash is FNV-1a 32-bit.  Different fingerprints can
 * theoretically collide to the same hash — the disambiguation counter
 * still produces unique IDs, but unrelated tokens may share a base key.
 * This is acceptable for UI keying; do not use these IDs as database
 * primary keys.
 *
 * @example
 * ```ts
 * // Per-parse scope (recommended for most cases)
 * parseRichText(text, { createId: createEasyStableId() });
 *
 * // Shared scope across multiple parses
 * const stableId = createEasyStableId();
 * const dsl = createParser({ handlers, createId: stableId });
 * dsl.parse(text1); // counter starts at 0
 * dsl.parse(text2); // counter continues
 * ```
 */
export const createEasyStableId = (options?: EasyStableIdOptions): CreateId => {
  const prefix = options?.prefix ?? "s";
  const fingerprint = options?.fingerprint;
  const seen = new Map<string, number>();

  return (token: TokenDraft): string => {
    const h = fingerprint ? fnv1a(fingerprint(token)) : (hashDraftInto(FNV_OFFSET, token) >>> 0);
    const key = `${prefix}-${h.toString(36)}`;

    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);

    return count === 0 ? key : `${key}-${count}`;
  };
};

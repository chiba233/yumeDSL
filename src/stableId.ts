import type { CreateId, TextToken, TokenDraft } from "./types.js";
import { fnv1a, fnvFeedString, fnvFeedU32, fnvInit } from "./hash.js";

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

/**
 * Compute a standalone FNV-1a hash for a TokenDraft.
 *
 * Uses `arrayCache` to avoid re-hashing subtrees whose `value` arrays
 * have already been processed.  In the normal bottom-up flow (leaves
 * created before parents), every child array is already cached, making
 * each call O(type.length) instead of O(subtree_size).
 *
 * For manually constructed deep trees (no prior caching), the function
 * collects all uncached arrays via an iterative DFS and hashes them
 * bottom-up — no recursion, fully stack-safe.
 */
const hashDraft = (root: TokenDraft, arrayCache: WeakMap<TextToken[], number>): number => {
  let h = fnvInit();
  h = fnvFeedString(h, root.type);

  if (typeof root.value === "string") {
    h = fnvFeedString(h, ":");
    return fnvFeedString(h, root.value) >>> 0;
  }

  const rootArr = root.value;
  const cachedRoot = arrayCache.get(rootArr);
  if (cachedRoot !== undefined) {
    return fnvFeedU32(fnvFeedString(h, ":"), cachedRoot) >>> 0;
  }

  // ── 迭代收集 + 自底向上哈希 ──
  // 注意：正常 createToken 流程是自底向上调用 createId 的，
  // 所以子数组一定已被缓存，这里的收集循环通常只包含 rootArr 自身。
  // 手动构造的深层 TokenDraft（如测试用例）才会真正触发多层收集。
  const uncached: TextToken[][] = [];
  const visiting = new Set<TextToken[]>();
  const collectStack: TextToken[][] = [rootArr];

  while (collectStack.length > 0) {
    const arr = collectStack.pop()!;
    if (arrayCache.has(arr) || visiting.has(arr)) continue;
    visiting.add(arr);
    uncached.push(arr);
    for (let i = arr.length - 1; i >= 0; i--) {
      const child = arr[i];
      if (typeof child.value !== "string") {
        collectStack.push(child.value);
      }
    }
  }

  // 逆序处理：叶子数组先算，父数组后算，保证子数组哈希在需要时已就绪
  for (let i = uncached.length - 1; i >= 0; i--) {
    const arr = uncached[i];
    let ah = fnvInit();
    for (let j = 0; j < arr.length; j++) {
      if (j > 0) ah = fnvFeedString(ah, ",");
      const child = arr[j];
      ah = fnvFeedString(ah, child.type);
      ah = fnvFeedString(ah, ":");
      if (typeof child.value === "string") {
        ah = fnvFeedString(ah, child.value);
      } else {
        ah = fnvFeedU32(ah, arrayCache.get(child.value)!);
      }
    }
    arrayCache.set(arr, ah >>> 0);
  }

  return fnvFeedU32(fnvFeedString(h, ":"), arrayCache.get(rootArr)!) >>> 0;
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
  // 子数组哈希缓存：createToken 自底向上调用 createId，
  // 子 token 的 value 数组引用被 `{ ...draft, id }` 共享，
  // 所以父 token 处理时子数组一定已缓存，hashDraft 降为 O(1)。
  const arrayCache = new WeakMap<TextToken[], number>();

  return (token: TokenDraft): string => {
    const h = fingerprint ? fnv1a(fingerprint(token)) : hashDraft(token, arrayCache);
    const key = `${prefix}-${h.toString(36)}`;

    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);

    return count === 0 ? key : `${key}-${count}`;
  };
};

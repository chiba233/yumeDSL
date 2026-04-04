import type { TextToken } from "./types.js";

export interface TokenVisitContext {
  parent: TextToken | null;
  depth: number;
  index: number;
}

export type WalkVisitor =
  | ((token: TextToken, ctx: TokenVisitContext) => void)
  | Record<string, (token: TextToken, ctx: TokenVisitContext) => void>;

export type MapVisitor = (
  token: TextToken,
  ctx: TokenVisitContext,
) => TextToken | TextToken[] | null;

/**
 * Depth-first **pre-order** traversal. Pure side-effect visitor.
 *
 * - Pass a function to visit every token.
 * - Pass a `Record<type, fn>` to visit only tokens whose `type` matches a key.
 */
export const walkTokens = (tokens: TextToken[], visitor: WalkVisitor): void => {
  const visit =
    typeof visitor === "function"
      ? visitor
      : (token: TextToken, ctx: TokenVisitContext) => {
          const fn = visitor[token.type];
          if (fn) fn(token, ctx);
        };

  const walk = (list: TextToken[], parent: TextToken | null, depth: number): void => {
    for (let i = 0; i < list.length; i++) {
      const token = list[i];
      visit(token, { parent, depth, index: i });
      if (typeof token.value !== "string") {
        walk(token.value, token, depth + 1);
      }
    }
  };

  walk(tokens, null, 0);
};

/**
 * Depth-first **post-order** transform. Returns a new tree without mutating the original.
 *
 * - Return the token (or a new object) to keep it.
 * - Return an array to expand one token into multiple siblings.
 * - Return `null` to remove it.
 *
 * Children are recursed **before** the visitor is called, so the callback
 * receives tokens whose children have already been mapped.
 *
 * **Note:** `ctx.parent` always refers to the **original input token**, not the
 * post-mapped version. This is inherent to single-pass post-order traversal —
 * the mapped parent cannot exist until all children have been visited.
 * Use `ctx.parent` for type/attribute checks, not for inspecting mapped children.
 */
export const mapTokens = (tokens: TextToken[], visitor: MapVisitor): TextToken[] => {
  const map = (list: TextToken[], parent: TextToken | null, depth: number): TextToken[] => {
    const result: TextToken[] = [];
    for (let i = 0; i < list.length; i++) {
      const token = list[i];
      const mapped: TextToken =
        typeof token.value === "string"
          ? token
          : { ...token, value: map(token.value, token, depth + 1) };

      const replacement = visitor(mapped, { parent, depth, index: i });
      if (replacement === null) continue;
      if (Array.isArray(replacement)) {
        result.push(...replacement);
      } else {
        result.push(replacement);
      }
    }
    return result;
  };

  return map(tokens, null, 0);
};

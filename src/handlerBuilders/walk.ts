import type { TextToken } from "../types";

/**
 * Traversal context passed to walk/map visitors.
 *
 * @example
 * ```ts
 * const show = (ctx: TokenVisitContext) => `${ctx.depth}:${ctx.index}`;
 * ```
 */
export interface TokenVisitContext {
  parent: TextToken | null;
  depth: number;
  index: number;
}

/**
 * Visitor type for `walkTokens`.
 *
 * @example
 * ```ts
 * const byType: WalkVisitor = {
 *   link: (token, ctx) => console.log(token.type, ctx.depth),
 * };
 * ```
 */
export type WalkVisitor =
  | ((token: TextToken, ctx: TokenVisitContext) => void)
  | Record<string, (token: TextToken, ctx: TokenVisitContext) => void>;

/**
 * Mapper callback type for `mapTokens`.
 *
 * @example
 * ```ts
 * const mapper: MapVisitor = (token) =>
 *   token.type === "text" && typeof token.value === "string"
 *     ? { ...token, value: token.value.toUpperCase() }
 *     : token;
 * ```
 */
export type MapVisitor = (
  token: TextToken,
  ctx: TokenVisitContext,
) => TextToken | TextToken[] | null;

/**
 * Depth-first **pre-order** traversal. Pure side-effect visitor.
 *
 * - Pass a function to visit every token.
 * - Pass a `Record<type, fn>` to visit only tokens whose `type` matches a key.
 *
 * Implemented with an explicit stack (no recursion) while preserving pre-order
 * traversal semantics.
 *
 * The visitor is invoked before descending into child tokens. `ctx.parent`,
 * `ctx.depth`, and `ctx.index` describe the token's position in the original tree.
 */
export const walkTokens = (tokens: TextToken[], visitor: WalkVisitor): void => {
  const visit =
    typeof visitor === "function"
      ? visitor
      : (token: TextToken, ctx: TokenVisitContext) => {
          const fn = visitor[token.type];
          if (fn) fn(token, ctx);
        };

  interface WalkFrame {
    list: TextToken[];
    index: number;
    parent: TextToken | null;
    depth: number;
  }

  const stack: WalkFrame[] = [{ list: tokens, index: 0, parent: null, depth: 0 }];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.index >= frame.list.length) {
      stack.pop();
      continue;
    }
    const token = frame.list[frame.index]!;
    visit(token, { parent: frame.parent, depth: frame.depth, index: frame.index });
    frame.index++;
    if (typeof token.value !== "string") {
      stack.push({ list: token.value, index: 0, parent: token, depth: frame.depth + 1 });
    }
  }
};

/**
 * Depth-first **post-order** transform. Returns a new tree without mutating the original.
 *
 * - Return the token (or a new object) to keep it.
 * - Return an array to expand one token into multiple siblings.
 * - Return `null` to remove it.
 *
 * Children are processed **before** the visitor is called, so the callback
 * receives tokens whose children have already been mapped.
 *
 * This function uses an explicit stack (non-recursive) implementation, but
 * preserves the same post-order semantics as the recursive version.
 *
 * **Note:** `ctx.parent` always refers to the **original input token**, not the
 * post-mapped version. The mapped parent cannot exist until all children have
 * been processed. Use `ctx.parent` for type/attribute checks, not for inspecting
 * mapped children.
 */
export const mapTokens = (tokens: TextToken[], visitor: MapVisitor): TextToken[] => {
  interface MapFrame {
    list: TextToken[];
    index: number;
    parent: TextToken | null;
    depth: number;
    result: TextToken[];
    owner: {
      token: TextToken;
      parent: TextToken | null;
      depth: number;
      index: number;
      target: TextToken[];
    } | null;
  }

  const root: MapFrame = {
    list: tokens,
    index: 0,
    parent: null,
    depth: 0,
    result: [],
    owner: null,
  };

  const pushReplacement = (
    target: TextToken[],
    replacement: TextToken | TextToken[] | null,
  ): void => {
    if (Array.isArray(replacement)) {
      target.push(...replacement);
    } else if (replacement !== null) {
      target.push(replacement);
    }
  };

  const stack: MapFrame[] = [root];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.index >= frame.list.length) {
      stack.pop();
      if (frame.owner) {
        const mapped: TextToken = { ...frame.owner.token, value: frame.result };
        const replacement = visitor(mapped, {
          parent: frame.owner.parent,
          depth: frame.owner.depth,
          index: frame.owner.index,
        });
        pushReplacement(frame.owner.target, replacement);
      }
      continue;
    }

    const i = frame.index;
    const token = frame.list[i]!;
    frame.index++;
    if (typeof token.value === "string") {
      const replacement = visitor(token, { parent: frame.parent, depth: frame.depth, index: i });
      pushReplacement(frame.result, replacement);
    } else {
      stack.push({
        list: token.value,
        index: 0,
        parent: token,
        depth: frame.depth + 1,
        result: [],
        owner: {
          token,
          parent: frame.parent,
          depth: frame.depth,
          index: i,
          target: frame.result,
        },
      });
    }
  }

  return root.result;
};

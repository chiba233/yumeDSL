import type { CreateId, DslContext, SourceSpan, TextToken, TokenDraft } from "../types";
import { warnDeprecated } from "../internal/deprecations.js";

let tokenIdSeed = 0;
let activeCreateId: CreateId | null = null;

/** @internal Resolve createId from DslContext, bare CreateId, or module default. */
const resolveCreateId = (ctx?: DslContext | CreateId): CreateId | null => {
  if (!ctx) return activeCreateId;
  return typeof ctx === "function" ? ctx : (ctx.createId ?? activeCreateId);
};

/**
 * Build a runtime token and assign an id via `ctx.createId` (or legacy ambient fallback).
 *
 * @example
 * ```ts
 * const ctx = { syntax: createSyntax(), createId: () => "tok-1" };
 * const token = createToken({ type: "text", value: "hello" }, undefined, ctx);
 * // => { type: "text", value: "hello", id: "tok-1" }
 * ```
 */
export const createToken = (
  token: TokenDraft,
  position?: SourceSpan,
  ctx?: DslContext | CreateId,
): TextToken => {
  const idFn = resolveCreateId(ctx);
  const id = idFn ? idFn(token) : `rt-${tokenIdSeed++}`;
  const result: TextToken = { ...token, id };
  if (position) result.position = position;
  return result;
};

/**
 * Reset the legacy module-level incremental id seed (`rt-0`, `rt-1`, ...).
 *
 * @example
 * ```ts
 * resetTokenIdSeed();
 * const a = createToken({ type: "text", value: "x" }); // id: rt-0
 * ```
 */
export const resetTokenIdSeed = () => {
  warnDeprecated(
    "resetTokenIdSeed",
    "resetTokenIdSeed() is deprecated. Use DslContext.createId instead.",
  );
  tokenIdSeed = 0;
};

/**
 * Temporarily install a legacy ambient `createId` for compatibility wrappers.
 *
 * @example
 * ```ts
 * const out = withCreateId((t) => `id:${t.type}`, () =>
 *   createToken(
 *     { type: "text", value: "ok" },
 *     undefined,
 *     { syntax: createSyntax() },
 *   ),
 * );
 * // out.id === "id:text"
 * ```
 */
export const withCreateId = <T>(
  createId: CreateId,
  fn: () => T,
  options?: { suppressDeprecation?: boolean },
): T => {
  warnDeprecated(
    "withCreateId",
    "withCreateId() is deprecated. Pass createId via DslContext instead.",
    { suppress: options?.suppressDeprecation },
  );
  const prev = activeCreateId;
  activeCreateId = createId;
  try {
    return fn();
  } finally {
    activeCreateId = prev;
  }
};

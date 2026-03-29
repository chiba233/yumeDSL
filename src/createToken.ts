import type { CreateId, DslContext, SourceSpan, TextToken, TokenDraft } from "./types.js";
import { warnDeprecated } from "./deprecations.js";

let tokenIdSeed = 0;
let activeCreateId: CreateId | null = null;

/** @internal Resolve createId from DslContext, bare CreateId, or module default. */
const resolveCreateId = (ctx?: DslContext | CreateId): CreateId | null => {
  if (!ctx) return activeCreateId;
  return typeof ctx === "function" ? ctx : ctx.createId ?? activeCreateId;
};

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

export const resetTokenIdSeed = () => {
  warnDeprecated("resetTokenIdSeed", "resetTokenIdSeed() is deprecated. Use DslContext.createId instead.");
  tokenIdSeed = 0;
};

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

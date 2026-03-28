import type { CreateId, DslContext, SourceSpan, SyntaxConfig, TextToken, TokenDraft } from "./types.js";

let tokenIdSeed = 0;
let activeCreateId: CreateId | null = null;

export const createToken = (
  token: TokenDraft,
  position?: SourceSpan,
  ctx?: DslContext | SyntaxConfig | CreateId,
): TextToken => {
  const explicitId = ctx
    ? typeof ctx === "function"
      ? ctx
      : "createId" in ctx
        ? ctx.createId
        : undefined
    : undefined;
  const idFn = explicitId ?? activeCreateId;
  const id = idFn ? idFn(token) : `rt-${tokenIdSeed++}`;
  const result: TextToken = { ...token, id };
  if (position) result.position = position;
  return result;
};

export const resetTokenIdSeed = () => {
  tokenIdSeed = 0;
};

export const withCreateId = <T>(createId: CreateId, fn: () => T): T => {
  const prev = activeCreateId;
  activeCreateId = createId;
  try {
    return fn();
  } finally {
    activeCreateId = prev;
  }
};

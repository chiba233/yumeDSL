import type { CreateId, TextToken, TokenDraft } from "./types.js";

let tokenIdSeed = 0;
let activeCreateId: CreateId | null = null;

export const createToken = (token: TokenDraft): TextToken => {
  const id = activeCreateId ? activeCreateId(token) : `rt-${tokenIdSeed++}`;
  return { ...token, id };
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

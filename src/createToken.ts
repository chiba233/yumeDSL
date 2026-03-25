import type { TextToken, TokenDraft } from "./types.js";

let tokenIdSeed = 0;

export const createToken = (token: TokenDraft): TextToken => {
  return { ...token, id: `rt-${tokenIdSeed++}` };
};

export const resetTokenIdSeed = () => {
  tokenIdSeed = 0;
};

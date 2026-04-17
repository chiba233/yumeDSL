/** Full syntax token set accepted by `createSyntax`. */
export interface SyntaxInput {
  tagPrefix: string;
  tagOpen: string;
  tagClose: string;
  tagDivider: string;
  endTag: string;
  rawOpen: string;
  blockOpen: string;
  blockClose: string;
  rawClose: string;
  escapeChar: string;
}

export interface SyntaxConfig extends SyntaxInput {
  /** Precomputed, sorted descending by length. */
  escapableTokens: string[];
}

export interface TagNameConfig {
  /** Decide whether a character may start a tag name. */
  isTagStartChar: (char: string) => boolean;
  /** Decide whether a character may appear after the first tag-name character. */
  isTagChar: (char: string) => boolean;
}

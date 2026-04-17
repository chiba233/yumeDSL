/**
 * Full syntax token set accepted by `createSyntax`.
 *
 * This is the human-authored input shape used to describe a DSL dialect before
 * runtime normalization. Each field is a literal marker consumed by scanners,
 * parsers, escaping utilities, and helper builders.
 */
export interface SyntaxInput {
  /** Prefix that introduces every tag family before form-specific open markers. */
  tagPrefix: string;
  /** Full inline open token, e.g. `$$`. */
  tagOpen: string;
  /** Full inline close token, e.g. `$$`. */
  tagClose: string;
  /** Divider used inside inline/raw arg lists. */
  tagDivider: string;
  /** Explicit end-tag prefix used by structural closing forms. */
  endTag: string;
  /** Raw-form body opener, e.g. `%`. */
  rawOpen: string;
  /** Block-form body opener, e.g. `*`. */
  blockOpen: string;
  /** Block-form closing line prefix, e.g. `*end$$`. */
  blockClose: string;
  /** Raw-form closing line prefix, e.g. `%end$$`. */
  rawClose: string;
  /** Single-character escape prefix used to quote syntax literally. */
  escapeChar: string;
}

/**
 * Normalized runtime syntax object.
 *
 * Extends {@link SyntaxInput} with parser-ready derived fields so scanners do
 * not need to recompute token ordering on every parse.
 */
export interface SyntaxConfig extends SyntaxInput {
  /**
   * Escapable syntax literals sorted by descending length.
   *
   * Longer tokens must be checked first so compound markers like `%end$$`
   * win before shorter prefixes such as `%` or `$$`.
   */
  escapableTokens: string[];
}

/**
 * Character-class configuration for tag-name parsing.
 *
 * These callbacks control lexical recognition only; they do not register tags
 * or decide which forms a tag supports.
 */
export interface TagNameConfig {
  /** Decide whether a character may start a tag name. */
  isTagStartChar: (char: string) => boolean;
  /** Decide whether a character may appear after the first tag-name character. */
  isTagChar: (char: string) => boolean;
}

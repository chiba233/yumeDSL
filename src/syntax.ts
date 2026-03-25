import type { SyntaxConfig, SyntaxInput } from "./types.js";

export const DEFAULT_SYNTAX: SyntaxInput = {
  tagPrefix: "$$",
  tagOpen: "(",
  tagClose: ")",
  tagDivider: "|",
  endTag: ")$$",
  rawOpen: ")%",
  blockOpen: ")*",
  blockClose: "*end$$",
  rawClose: "%end$$",
  escapeChar: "\\",
};

export const createSyntax = (overrides?: Partial<SyntaxInput>): SyntaxConfig => {
  const s: SyntaxInput = overrides ? { ...DEFAULT_SYNTAX, ...overrides } : DEFAULT_SYNTAX;
  return {
    ...s,
    escapableTokens: [
      s.rawClose,
      s.blockClose,
      s.tagOpen,
      s.tagClose,
      s.tagDivider,
      s.escapeChar,
    ].sort((a, b) => b.length - a.length),
  };
};

// ── Module-level active syntax (set during parse, safe for synchronous use) ──

let activeSyntax: SyntaxConfig = createSyntax();

export const getSyntax = (): SyntaxConfig => activeSyntax;

export const withSyntax = <T>(syntax: SyntaxConfig, fn: () => T): T => {
  const prev = activeSyntax;
  activeSyntax = syntax;
  try {
    return fn();
  } finally {
    activeSyntax = prev;
  }
};

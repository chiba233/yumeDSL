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

// Markers extracted from DEFAULT_SYNTAX for derivation in createEasySyntax.
// rawMarker/blockMarker appear after tagClose to switch form; "end" keyword closes multiline forms.
const RAW_MARKER = DEFAULT_SYNTAX.rawOpen.slice(DEFAULT_SYNTAX.tagClose.length);      // "%"
const BLOCK_MARKER = DEFAULT_SYNTAX.blockOpen.slice(DEFAULT_SYNTAX.tagClose.length);   // "*"
const MULTILINE_CLOSE_MIDDLE = DEFAULT_SYNTAX.rawClose.slice(
  RAW_MARKER.length,
  DEFAULT_SYNTAX.rawClose.length - DEFAULT_SYNTAX.tagPrefix.length,
);

type EasySyntaxOverrides = Partial<SyntaxInput>;

interface EasySyntaxBase {
  tagPrefix: string;
  tagOpen: string;
  tagClose: string;
  tagDivider: string;
  escapeChar: string;
}

type EasySyntaxDerivedKey = Exclude<keyof SyntaxInput, keyof EasySyntaxBase>;
type EasySyntaxCompoundDerive = (base: EasySyntaxBase) => string;

interface EasySyntaxCompoundRule {
  key: EasySyntaxDerivedKey;
  derive: EasySyntaxCompoundDerive;
}

const resolveEasySyntaxBase = (overrides?: EasySyntaxOverrides): EasySyntaxBase => ({
  tagPrefix: overrides?.tagPrefix ?? DEFAULT_SYNTAX.tagPrefix,
  tagOpen: overrides?.tagOpen ?? DEFAULT_SYNTAX.tagOpen,
  tagClose: overrides?.tagClose ?? DEFAULT_SYNTAX.tagClose,
  tagDivider: overrides?.tagDivider ?? DEFAULT_SYNTAX.tagDivider,
  escapeChar: overrides?.escapeChar ?? DEFAULT_SYNTAX.escapeChar,
});

const EASY_SYNTAX_COMPOUND_RULES: readonly EasySyntaxCompoundRule[] = [
  { key: "endTag", derive: (base) => base.tagClose + base.tagPrefix },
  { key: "rawOpen", derive: (base) => base.tagClose + RAW_MARKER },
  { key: "blockOpen", derive: (base) => base.tagClose + BLOCK_MARKER },
  { key: "rawClose", derive: (base) => RAW_MARKER + MULTILINE_CLOSE_MIDDLE + base.tagPrefix },
  { key: "blockClose", derive: (base) => BLOCK_MARKER + MULTILINE_CLOSE_MIDDLE + base.tagPrefix },
];

const deriveEasySyntaxCompounds = (
  base: EasySyntaxBase,
  overrides?: EasySyntaxOverrides,
): Omit<SyntaxInput, keyof EasySyntaxBase> => {
  const compounds = {} as Omit<SyntaxInput, keyof EasySyntaxBase>;

  for (const rule of EASY_SYNTAX_COMPOUND_RULES) {
    compounds[rule.key] = overrides?.[rule.key] ?? rule.derive(base);
  }

  return compounds;
};

/**
 * Build a `SyntaxConfig` with automatic derivation of compound tokens.
 *
 * Only the base tokens (`tagPrefix`, `tagOpen`, `tagClose`, `tagDivider`,
 * `escapeChar`) need to be provided — compound tokens (`endTag`, `rawOpen`,
 * `blockOpen`, `rawClose`, `blockClose`) are derived automatically:
 *
 * ```
 * endTag     = tagClose + tagPrefix
 * rawOpen    = tagClose + RAW_MARKER
 * blockOpen  = tagClose + BLOCK_MARKER
 * rawClose   = RAW_MARKER + closeMiddle + tagPrefix
 * blockClose = BLOCK_MARKER + closeMiddle + tagPrefix
 * ```
 *
 * Explicit compound overrides still take precedence over derivation.
 */
export const createEasySyntax = (overrides?: Partial<SyntaxInput>): SyntaxConfig => {
  const base = resolveEasySyntaxBase(overrides);

  return createSyntax({
    ...base,
    ...deriveEasySyntaxCompounds(base, overrides),
  });
};

/** Build a `SyntaxConfig` from explicit overrides (plain shallow merge, no derivation). */
export const createSyntax = (overrides?: Partial<SyntaxInput>): SyntaxConfig => {
  const s: SyntaxInput = overrides ? { ...DEFAULT_SYNTAX, ...overrides } : DEFAULT_SYNTAX;
  return {
    ...s,
    escapableTokens: [
      ...new Set([
        s.endTag,
        s.rawOpen,
        s.blockOpen,
        s.rawClose,
        s.blockClose,
        s.tagOpen,
        s.tagClose,
        s.tagDivider,
        s.escapeChar,
      ]),
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

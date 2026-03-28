import type { SyntaxConfig, SyntaxInput } from "./types.js";
import { isInternalCaller, warnDeprecated } from "./deprecations.js";

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

// Default protocol fragments used by easy syntax derivation.
// raw/block markers follow tagClose; closeMiddle sits between the form marker and tagPrefix.
const DEFAULT_DERIVATION_PARTS = {
  rawMarker: DEFAULT_SYNTAX.rawOpen.slice(DEFAULT_SYNTAX.tagClose.length),
  blockMarker: DEFAULT_SYNTAX.blockOpen.slice(DEFAULT_SYNTAX.tagClose.length),
  closeMiddle: DEFAULT_SYNTAX.rawClose.slice(
    DEFAULT_SYNTAX.rawOpen.slice(DEFAULT_SYNTAX.tagClose.length).length,
    DEFAULT_SYNTAX.rawClose.length - DEFAULT_SYNTAX.tagPrefix.length,
  ),
} as const;

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

const EASY_SYNTAX_BASE_KEYS = [
  "tagPrefix",
  "tagOpen",
  "tagClose",
  "tagDivider",
  "escapeChar",
] as const satisfies readonly (keyof EasySyntaxBase)[];

const resolveSyntaxFields = <K extends keyof SyntaxInput>(
  keys: readonly K[],
  overrides?: EasySyntaxOverrides,
): Pick<SyntaxInput, K> => {
  const resolved = {} as Pick<SyntaxInput, K>;

  for (const key of keys) {
    resolved[key] = overrides?.[key] ?? DEFAULT_SYNTAX[key];
  }

  return resolved;
};

const resolveEasySyntaxBase = (overrides?: EasySyntaxOverrides): EasySyntaxBase =>
  resolveSyntaxFields(EASY_SYNTAX_BASE_KEYS, overrides);

// Derivation contract for the convenience syntax builder:
// given the base tokens, these rules define the implied compound tokens.
const EASY_SYNTAX_DERIVATION_RULES: readonly EasySyntaxCompoundRule[] = [
  { key: "endTag", derive: (base) => base.tagClose + base.tagPrefix },
  { key: "rawOpen", derive: (base) => base.tagClose + DEFAULT_DERIVATION_PARTS.rawMarker },
  { key: "blockOpen", derive: (base) => base.tagClose + DEFAULT_DERIVATION_PARTS.blockMarker },
  {
    key: "rawClose",
    derive: (base) =>
      DEFAULT_DERIVATION_PARTS.rawMarker + DEFAULT_DERIVATION_PARTS.closeMiddle + base.tagPrefix,
  },
  {
    key: "blockClose",
    derive: (base) =>
      DEFAULT_DERIVATION_PARTS.blockMarker + DEFAULT_DERIVATION_PARTS.closeMiddle + base.tagPrefix,
  },
];

const deriveEasySyntaxCompounds = (
  base: EasySyntaxBase,
  overrides?: EasySyntaxOverrides,
): Omit<SyntaxInput, keyof EasySyntaxBase> => {
  const compounds = {} as Omit<SyntaxInput, keyof EasySyntaxBase>;

  for (const rule of EASY_SYNTAX_DERIVATION_RULES) {
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
 * rawOpen    = tagClose + rawMarker
 * blockOpen  = tagClose + blockMarker
 * rawClose   = rawMarker + closeMiddle + tagPrefix
 * blockClose = blockMarker + closeMiddle + tagPrefix
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

const defaultSyntaxInstance: SyntaxConfig = createSyntax();

let activeSyntax: SyntaxConfig = defaultSyntaxInstance;

export const getSyntax = (): SyntaxConfig => {
  if (!isInternalCaller()) {
    warnDeprecated("getSyntax", "getSyntax() is deprecated. Use DslContext.syntax instead.");
  }
  return activeSyntax;
};

/** @internal The default SyntaxConfig instance for ambient-change detection. */
export const getDefaultSyntaxInstance = (): SyntaxConfig => defaultSyntaxInstance;

export const withSyntax = <T>(syntax: SyntaxConfig, fn: () => T): T => {
  if (!isInternalCaller()) {
    warnDeprecated("withSyntax", "withSyntax() is deprecated. Pass syntax via ParseOptions or DslContext instead.");
  }
  const prev = activeSyntax;
  activeSyntax = syntax;
  try {
    return fn();
  } finally {
    activeSyntax = prev;
  }
};

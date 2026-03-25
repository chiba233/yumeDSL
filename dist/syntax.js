export const DEFAULT_SYNTAX = {
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
export const createSyntax = (overrides) => {
    const s = overrides ? { ...DEFAULT_SYNTAX, ...overrides } : DEFAULT_SYNTAX;
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
let activeSyntax = createSyntax();
export const getSyntax = () => activeSyntax;
export const withSyntax = (syntax, fn) => {
    const prev = activeSyntax;
    activeSyntax = syntax;
    try {
        return fn();
    }
    finally {
        activeSyntax = prev;
    }
};
//# sourceMappingURL=syntax.js.map
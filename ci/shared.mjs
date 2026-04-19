export const CORE_CASES = [
  { name: "plain text", input: "hello world" },
  { name: "empty", input: "" },
  { name: "simple inline", input: "$$bold(hello)$$" },
  { name: "nested inline", input: "$$bold($$thin($$underline(deep)$$)$$)$$" },
  { name: "inline with text", input: "before $$bold(middle)$$ after" },
  { name: "inline with pipe", input: "$$link(https://example.com|click here)$$" },
  { name: "raw code", input: "$$raw-code(typescript)%\nconst x = 1;\n%end$$" },
  { name: "block basic", input: "$$info(Notice)*\nblock content\n*end$$" },
  {
    name: "mixed all forms",
    input: "text $$bold(inline)$$\n$$info()*\nblock $$code(x)$$\n*end$$\n$$raw-code(js)%\nraw\n%end$$",
  },
  { name: "unclosed inline", input: "$$bold(hello" },
  { name: "unclosed block", input: "$$info()*\nhello" },
  { name: "unknown tag", input: "$$unknown(content)$$" },
  { name: "unknown block", input: "$$unknown()*\ncontent\n*end$$" },
  { name: "depth limit hit", input: "$$bold($$bold($$bold(deep)$$)$$)$$", opts: { depthLimit: 2 } },
  { name: "trailing newline after block", input: "$$info()*\ncontent\n*end$$\nnext line" },
  { name: "crlf", input: "$$bold(hello)$$\r\nworld" },
  { name: "block with crlf", input: "$$info()*\r\ncontent\r\n*end$$" },
  {
    name: "40-level nesting",
    input: (() => {
      let text = "x";
      for (let i = 0; i < 40; i += 1) text = `$$bold(${text})$$`;
      return text;
    })(),
  },
];

export const CUSTOM_SYNTAX_CASES = [
  { name: "custom: simple inline", input: "##bold(hello)##" },
  { name: "custom: nested", input: "##bold(##thin(x)##)##" },
  { name: "custom: raw", input: "##raw-code(js)%\ncode\n%end##" },
  { name: "custom: block", input: "##info()*\ncontent\n*end##" },
  { name: "custom: mixed", input: "text ##bold(a)## mid ##info()*\n##code(x)##\n*end##" },
];

export const SHORTHAND_CASES = [
  { name: "simple shorthand", input: "$$bold(hello)" },
  { name: "nested shorthand", input: "$$bold($$thin(x))" },
  { name: "shorthand with trailing text", input: "before $$bold(hello) after" },
  { name: "unclosed shorthand", input: "$$bold(hello" },
  { name: "shorthand depth limit", input: "$$bold($$bold($$bold(x)))", opts: { depthLimit: 2 } },
];

export const ERROR_CASES = CORE_CASES.filter((testCase) =>
  ["unclosed inline", "unclosed block", "unknown tag", "unknown block", "depth limit hit"].includes(testCase.name),
);

export const COMPAT_CASES = [
  {
    name: "blockTags:inline-string",
    input: "$$bold(hello)$$\nnext",
    opts: { blockTags: ["bold"] },
  },
  {
    name: "blockTags:inline-forms",
    input: "$$bold(hello)$$\nnext",
    opts: { blockTags: [{ tag: "bold", forms: ["inline"] }] },
  },
  {
    name: "allowForms:inline-only",
    input: "$$info(T)$$ $$raw-code(ts)%\nconst x = 1\n%end$$",
    opts: { allowForms: ["inline"] },
  },
  {
    name: "allowForms:no-inline",
    input: "$$unknown(hello)$$ $$bold(x)$$",
    opts: { allowForms: ["raw", "block"] },
  },
  {
    name: "custom-tagName",
    input: "$$ui:button(hello)$$",
    opts: {
      tagName: {
        isTagChar: (char) => /[A-Za-z0-9:-]/.test(char),
        isTagStartChar: (char) => /[A-Za-z]/.test(char),
      },
    },
  },
  {
    name: "consecutive-raw",
    input: "$$raw-code(ts)%\nconst a = 1\n%end$$\n$$raw-code(ts)%\nconst b = 2\n%end$$",
  },
  {
    name: "consecutive-block",
    input: "$$info(A)*\none\n*end$$\n$$info(B)*\ntwo\n*end$$",
  },
];

export const expectedOnErrorByApi = {
  parseRichText: {
    "unclosed inline": ["INLINE_NOT_CLOSED"],
    "unclosed block": ["BLOCK_NOT_CLOSED"],
    "unknown tag": [],
    "unknown block": [],
    "depth limit hit": ["DEPTH_LIMIT"],
  },
  stripRichText: {
    "unclosed inline": ["INLINE_NOT_CLOSED"],
    "unclosed block": ["BLOCK_NOT_CLOSED"],
    "unknown tag": [],
    "unknown block": [],
    "depth limit hit": ["DEPTH_LIMIT"],
  },
  parseStructural: {
    "unclosed inline": [],
    "unclosed block": [],
    "unknown tag": [],
    "unknown block": [],
    "depth limit hit": [],
  },
};

export const makeHandlers = (mod) => ({
  ...mod.createSimpleInlineHandlers(["bold", "thin", "underline", "strike", "code", "center"]),
  link: {
    inline: (tokens) => {
      const args = mod.parsePipeArgs(tokens);
      const url = args.text(0);
      const value = args.parts.length > 1 ? args.materializedTailTokens(1) : args.materializedTokens(0);
      return { type: "link", url, value };
    },
  },
  info: {
    inline: (tokens) => {
      const args = mod.parsePipeArgs(tokens);
      if (args.parts.length <= 1) {
        return { type: "info", title: "Info", value: args.materializedTokens(0) };
      }
      return { type: "info", title: args.text(0), value: args.materializedTailTokens(1) };
    },
    block: (arg, tokens) => ({ type: "info", title: arg || "Info", value: tokens }),
    raw: (arg, content) => ({ type: "info", title: arg || "Info", value: [{ type: "text", value: content }] }),
  },
  "raw-code": {
    raw: (arg, content) => {
      const lang = (arg ?? "").split("|")[0]?.trim() || "";
      return { type: "raw-code", lang, value: content };
    },
  },
});

export const createCustomSyntax = (mod) =>
  mod.createSyntax({
    tagPrefix: "##",
    endTag: ")##",
    rawClose: "%end##",
    blockClose: "*end##",
  });

export const stripMeta = (value, options = {}) => {
  const keepPosition = options.keepPosition ?? false;
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => stripMeta(item, options));

  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "id" || key === "_meta") continue;
    if (!keepPosition && key === "position") continue;
    out[key] = stripMeta(entry, options);
  }
  return out;
};

export const normalizeDoc = (doc) => ({
  source: doc.source,
  tree: stripMeta(doc.tree),
  zones: doc.zones.map((zone) => ({
    startOffset: zone.startOffset,
    endOffset: zone.endOffset,
    nodes: stripMeta(zone.nodes),
  })),
});

export const normalizeDiff = (diff) => ({
  isNoop: diff.isNoop,
  dirtySpanOld: diff.dirtySpanOld,
  dirtySpanNew: diff.dirtySpanNew,
  unchangedRanges: diff.unchangedRanges,
  patches: diff.patches,
  ops: diff.ops.map((op) =>
    op.kind === "splice"
      ? {
          kind: op.kind,
          path: op.path,
          field: op.field,
          oldRange: op.oldRange,
          newRange: op.newRange,
          oldNodes: stripMeta(op.oldNodes),
          newNodes: stripMeta(op.newNodes),
        }
      : op,
  ),
});

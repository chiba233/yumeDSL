import type {
  CreateId,
  DslContext,
  Parser,
  ParseOptions,
  PipeHandlerDefinition,
  StructuralNode,
  SyntaxConfig,
  TagHandler,
  TagNameConfig,
  TextToken,
  Zone,
} from "../src/index.ts";
import {
  buildZones,
  createEasySyntax,
  filterTokens,
  createParser,
  createSyntax,
  createPassthroughTags,
  createPipeHandlers,
  createPipeBlockHandlers,
  createPipeRawHandlers,
  createSimpleBlockHandlers,
  createSimpleInlineHandlers,
  createSimpleRawHandlers,
  createTagNameConfig,
  createTextToken,
  createToken,
  getSyntax,
  parsePipeArgs,
  parsePipeTextArgs,
  parsePipeTextList,
  parseStructural,
  extractText,
  readEscapedSequence,
  unescapeInline,
  withSyntax,
  withTagNameConfig,
} from "../src/index.ts";

const inlineHandlers = createSimpleInlineHandlers(["bold", "italic"] as const);
const blockHandlers = createSimpleBlockHandlers(["info", "warning"] as const);
const rawHandlers = createSimpleRawHandlers(["code", "math"] as const);
const passthroughHandlers = createPassthroughTags(["thin", "center"] as const);
const pipeBlockHandlers = createPipeBlockHandlers(["panel"] as const);
const pipeRawHandlers = createPipeRawHandlers(["code"] as const);
const pipeHandlers = createPipeHandlers({
  link: {
    inline: (args) => ({ type: "link", value: args.materializedTailTokens(1) }),
  },
  code: {
    raw: (args, content, _ctx, rawArg) => ({
      type: "code",
      arg: rawArg,
      args: args.parts.map((_, i) => args.text(i)),
      value: content,
    }),
  },
  panel: {
    block: (args, content, _ctx, rawArg) => ({
      type: "panel",
      arg: rawArg,
      args: args.parts.map((_, i) => args.text(i)),
      value: content,
    }),
  },
});

void pipeHandlers;

const pipeDefinition: PipeHandlerDefinition = {
  inline: (args, ctx) => ({ type: "demo", value: args.materializedTokens(0, [createTextToken("x", ctx)]) }),
};
void pipeDefinition;

const handlers: Record<string, TagHandler> = {
  ...inlineHandlers,
  ...blockHandlers,
  ...rawHandlers,
  ...passthroughHandlers,
  ...pipeBlockHandlers,
  ...pipeRawHandlers,
};

const validOptions: ParseOptions = {
  handlers,
  allowForms: ["inline", "raw", "block"],
};

void validOptions;

const createId: CreateId = () => "fixed";
const validOptionsWithCreateId: ParseOptions = {
  handlers,
  createId,
};

void validOptionsWithCreateId;

const tagName: TagNameConfig = createTagNameConfig({
  isTagChar: (char) => /[A-Za-z0-9_:-]/.test(char),
});

const validOptionsWithTagName: ParseOptions = {
  handlers,
  tagName,
};

void validOptionsWithTagName;

const syntax: SyntaxConfig = createSyntax({
  tagPrefix: "@@",
  tagOpen: "<<",
  tagClose: ">>",
  tagDivider: "||",
  endTag: ">>@@",
  rawOpen: ">>%",
  blockOpen: ">>*",
  rawClose: "%end@@",
  blockClose: "*end@@",
  escapeChar: "~",
});

const easySyntaxWithCloseMiddle: SyntaxConfig = createEasySyntax({
  tagPrefix: "@@",
  tagOpen: "<<",
  tagClose: ">>",
  closeMiddle: "fin",
});
void easySyntaxWithCloseMiddle;

const dslContext: DslContext = {
  syntax,
  createId,
};

const inlineTokens: TextToken[] = [{ type: "text", value: "a || b", id: "rt-0" }];
const pipeArgsFromCtx = parsePipeArgs(inlineTokens, dslContext);
void pipeArgsFromCtx;

const pipeArgsFromText = parsePipeTextArgs("a || b", dslContext);
void pipeArgsFromText;

const pipeTextList = parsePipeTextList("a || b", dslContext);
void pipeTextList;

const unescaped = unescapeInline(String.raw`a ~|| b`, dslContext);
void unescaped;

const escaped = readEscapedSequence(String.raw`~>>@@`, 0, dslContext);
void escaped;

const manualToken = createToken({ type: "text", value: "hello" }, undefined, dslContext);
void manualToken;

const manualTextToken = createTextToken("hello", dslContext);
void manualTextToken;

const manualText = extractText(manualTextToken);
void manualText;
const filteredTokens = filterTokens([manualTextToken], (token) => token.type === "text");
void filteredTokens;

const ambientSyntax: SyntaxConfig = getSyntax();
void ambientSyntax;

withSyntax(syntax, () => {
  const ambientUnescaped = unescapeInline(String.raw`a ~|| b`);
  const ambientPipeArgs = parsePipeTextArgs("a || b");
  const ambientToken = createToken({ type: "text", value: "ok" });
  void ambientUnescaped;
  void ambientPipeArgs;
  void ambientToken;
});

withTagNameConfig(createTagNameConfig({ isTagChar: (char) => /[A-Za-z0-9_:-]/.test(char) }), () => {
  const inheritedSyntax = getSyntax();
  void inheritedSyntax;
});

const explicitCtxHandler: TagHandler = {
  inline: (tokens, ctx) => {
    const args = parsePipeArgs(tokens, ctx);
    const hasTitle: boolean = args.has(0);
    const title: string = args.text(0, "fallback");
    const tokensOrFallback: TextToken[] = args.materializedTokens(1, [createTextToken("fallback", ctx)]);
    void hasTitle;
    void title;
    void tokensOrFallback;
    return { type: "link", value: args.materializedTailTokens(0, [createTextToken("empty", ctx)]) };
  },
};
void explicitCtxHandler;

const legacyCompatHandler: TagHandler = {
  inline: (tokens) => {
    const args = parsePipeArgs(tokens);
    return { type: "link", value: args.materializedTailTokens(0) };
  },
};
void legacyCompatHandler;

const legacyRawCompatHandler: TagHandler = {
  raw: (arg, content) => ({
    type: "code",
    arg,
    value: content,
  }),
  block: (arg, content) => ({
    type: "panel",
    arg,
    value: content,
  }),
};
void legacyRawCompatHandler;

const parser: Parser = createParser({
  handlers: {
    legacy: legacyCompatHandler,
  },
});
const printedWithOverride: string = parser.print(
  [{ type: "inline", tag: "legacy", children: [{ type: "text", value: "ok" }] }],
  { syntax: { tagPrefix: "@@", tagOpen: "[", tagClose: "]", endTag: "]@@" } },
);
void printedWithOverride;

const structuralNodes: StructuralNode[] = parseStructural("$$bold(hi)$$", {
  handlers: inlineHandlers,
  trackPositions: true,
});
const zones: Zone[] = buildZones(structuralNodes);
const zone: Zone = zones[0];
const _startOffset: number = zone.startOffset;
const _endOffset: number = zone.endOffset;
const _zoneNodes: StructuralNode[] = zone.nodes;
void _startOffset;
void _endOffset;
void _zoneNodes;

parseStructural("$$bold(hi)$$", {
  // @ts-expect-error parseStructural 的公开 options 故意不暴露 onError
  onError: (error: unknown) => {
    void error;
  },
});

// @ts-expect-error invalid form should be rejected
const invalidOptions: ParseOptions = { allowForms: ["inline", "weird"] };
void invalidOptions;

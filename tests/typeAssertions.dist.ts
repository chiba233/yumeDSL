import type {
  DslContext,
  NarrowDraft,
  NarrowToken,
  NarrowTokenUnion,
  ParseOptions,
  PipeHandlerDefinition,
  StructuralNode,
  SyntaxConfig,
  TagHandler,
  TextToken,
  Zone,
} from "../src/index.ts";
import {
  buildPositionTracker,
  buildZones,
  createTokenGuard,
  createEasySyntax,
  filterTokens,
  createParser,
  createPipeHandlers,
  createSyntax,
  createTagNameConfig,
  createTextToken,
  createToken,
  extractText,
  parsePipeArgs,
  parsePipeTextArgs,
  parseRichText,
  parseStructural,
  readEscapedSequence,
  unescapeInline,
} from "../src/index.ts";

const distTokenMap = {
  link: { url: "" },
  bold: {},
} satisfies Record<string, Record<string, unknown>>;

type DistTokenMap = typeof distTokenMap;

const syntax: SyntaxConfig = createEasySyntax({
  tagPrefix: "@@",
  tagOpen: "<<",
  tagClose: ">>",
  tagDivider: "||",
  escapeChar: "~",
});

const syntaxWithCloseMiddle: SyntaxConfig = createEasySyntax({
  tagPrefix: "@@",
  tagOpen: "<<",
  tagClose: ">>",
  closeMiddle: "fin",
});
void syntaxWithCloseMiddle;

const explicitSyntax = createSyntax({
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

const ctx: DslContext = {
  syntax,
  createId: (draft) => `dist-${draft.type}`,
};

const pipeDefinition: PipeHandlerDefinition = {
  inline: (args, innerCtx) => ({
    type: "link",
    value: args.materializedTailTokens(1, [createTextToken("fallback", innerCtx)]),
  }),
};
void pipeDefinition;

const handlers = createPipeHandlers({
  link: {
    inline: (args, innerCtx) => ({
      type: "link",
      url: args.text(0),
      value: args.materializedTailTokens(1, [createTextToken("fallback", innerCtx)]),
    }),
  },
});

type DistLinkDraft = NarrowDraft<"link", { url: string }>;

const typedHandler: TagHandler = {
  inline: (tokens, innerCtx): DistLinkDraft => {
    const args = parsePipeArgs(tokens, innerCtx);
    return {
      type: "link",
      url: args.text(0),
      value: args.materializedTailTokens(1, [createTextToken("fallback", innerCtx)]),
    };
  },
};
void typedHandler;

const legacyHandlers: ParseOptions["handlers"] = {
  link: {
    inline: (tokens) => {
      const args = parsePipeArgs(tokens);
      return {
        type: "link",
        value: args.materializedTailTokens(0),
      };
    },
  },
  code: {
    raw: (arg, content) => ({
      type: "code",
      arg,
      value: content,
    }),
  },
};
void legacyHandlers;

const options: ParseOptions = {
  handlers,
  syntax: explicitSyntax,
  tagName: createTagNameConfig({
    isTagChar: (char) => /[A-Za-z0-9_:-]/.test(char),
  }),
  trackPositions: true,
};
void options;

const richTokens: TextToken[] = parseRichText("@@link<<https://a.com || hi>>@@", options);
void richTokens;

const isDistToken = createTokenGuard<DistTokenMap>();
const firstToken: TextToken | undefined = richTokens[0];

if (firstToken && isDistToken(firstToken, "link")) {
  const url: string = firstToken.url;
  void url;
}

type DistToken = NarrowTokenUnion<DistTokenMap>;

const renderDistToken = (token: DistToken): string => {
  switch (token.type) {
    case "link":
      return token.url;
    case "bold":
      return Array.isArray(token.value) ? "bold" : token.value;
  }
};

const acceptLinkToken = (token: NarrowToken<"link", { url: string }>): string => token.url;
void renderDistToken;
void acceptLinkToken;

const structuralNodes: StructuralNode[] = parseStructural("@@link<<a || b>>@@", {
  syntax,
  trackPositions: true,
});
void structuralNodes;

const parsedArgs = parsePipeArgs(
  [
    createToken({ type: "text", value: "a || " }, undefined, ctx),
    { type: "bold", value: [createTextToken("x", ctx)], id: "bold-1" },
    createToken({ type: "text", value: "b" }, undefined, ctx),
  ],
  ctx,
);
void parsedArgs;

const parsedTextArgs = parsePipeTextArgs("a || b", ctx);
void parsedTextArgs;

const unescaped = unescapeInline(String.raw`a ~|| b`, ctx);
void unescaped;

const escaped = readEscapedSequence(String.raw`~>>@@`, 0, ctx);
void escaped;

const tracker = buildPositionTracker("head\r\n@@link<<a || b>>@@");
const parser = createParser({
  handlers,
  syntax,
  trackPositions: true,
});

const parserTokens = parser.parse("@@link<<https://a.com || hi>>@@");
void parserTokens;

const singleLeafText = extractText(createTextToken("single", ctx));
void singleLeafText;

const filteredParserTokens = filterTokens(parserTokens, (token) => token.type !== "link");
void filteredParserTokens;

const parserNodes = parser.structural("@@link<<a || b>>@@", {
  tracker,
  baseOffset: 6,
});
void parserNodes;

const parserPrinted = parser.print(
  [{ type: "inline", tag: "link", children: [{ type: "text", value: "hi" }] }],
  { syntax: { tagPrefix: "%%", tagOpen: "<<", tagClose: ">>", endTag: ">>%%" } },
);
void parserPrinted;

const distZones: Zone[] = buildZones(structuralNodes);
const distZone: Zone = distZones[0];
const _distStart: number = distZone.startOffset;
const _distEnd: number = distZone.endOffset;
const _distNodes: StructuralNode[] = distZone.nodes;
void _distStart;
void _distEnd;
void _distNodes;

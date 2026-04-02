import type {
  DslContext,
  ParseOptions,
  PipeHandlerDefinition,
  StructuralNode,
  SyntaxConfig,
  TextToken,
  Zone,
} from "yume-dsl-rich-text";
import {
  buildPositionTracker,
  buildZones,
  createEasySyntax,
  createParser,
  createPipeHandlers,
  createSyntax,
  createTagNameConfig,
  createTextToken,
  createToken,
  parsePipeArgs,
  parsePipeTextArgs,
  parseRichText,
  parseStructural,
  readEscapedSequence,
  unescapeInline,
} from "yume-dsl-rich-text";

const syntax: SyntaxConfig = createEasySyntax({
  tagPrefix: "@@",
  tagOpen: "<<",
  tagClose: ">>",
  tagDivider: "||",
  escapeChar: "~",
});

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

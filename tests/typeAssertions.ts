import type {
  CreateId,
  DslContext,
  ParseOptions,
  SyntaxConfig,
  TagForm,
  TagHandler,
  TagNameConfig,
  TextToken,
} from "../src/index.ts";
import {
  createSyntax,
  createPassthroughTags,
  createPipeBlockHandlers,
  createPipeRawHandlers,
  createSimpleBlockHandlers,
  createSimpleInlineHandlers,
  createSimpleRawHandlers,
  createTagNameConfig,
  createToken,
  getSyntax,
  parsePipeArgs,
  parsePipeTextArgs,
  parsePipeTextList,
  readEscapedSequence,
  unescapeInline,
  withSyntax,
  withTagNameConfig,
} from "../src/index.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type Expect<T extends true> = T;

const inlineHandlers = createSimpleInlineHandlers(["bold", "italic"] as const);
const blockHandlers = createSimpleBlockHandlers(["info", "warning"] as const);
const rawHandlers = createSimpleRawHandlers(["code", "math"] as const);
const passthroughHandlers = createPassthroughTags(["thin", "center"] as const);
const pipeBlockHandlers = createPipeBlockHandlers(["panel"] as const);
const pipeRawHandlers = createPipeRawHandlers(["code"] as const);

type _InlineKeys = Expect<Equal<keyof typeof inlineHandlers, "bold" | "italic">>;
type _BlockKeys = Expect<Equal<keyof typeof blockHandlers, "info" | "warning">>;
type _RawKeys = Expect<Equal<keyof typeof rawHandlers, "code" | "math">>;
type _PassKeys = Expect<Equal<keyof typeof passthroughHandlers, "thin" | "center">>;
type _PipeBlockKeys = Expect<Equal<keyof typeof pipeBlockHandlers, "panel">>;
type _PipeRawKeys = Expect<Equal<keyof typeof pipeRawHandlers, "code">>;
type _TagFormShape = Expect<Equal<TagForm, "inline" | "raw" | "block">>;

type InlineCtx = Parameters<NonNullable<NonNullable<TagHandler["inline"]>>>[1];
type RawCtx = Parameters<NonNullable<NonNullable<TagHandler["raw"]>>>[2];
type BlockCtx = Parameters<NonNullable<NonNullable<TagHandler["block"]>>>[2];

type _InlineCtxShape = Expect<Equal<InlineCtx, DslContext | undefined>>;
type _RawCtxShape = Expect<Equal<RawCtx, DslContext | undefined>>;
type _BlockCtxShape = Expect<Equal<BlockCtx, DslContext | undefined>>;

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
    return { type: "link", value: args.materializedTailTokens(0) };
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

// @ts-expect-error invalid form should be rejected
const invalidOptions: ParseOptions = { allowForms: ["inline", "weird"] };
void invalidOptions;

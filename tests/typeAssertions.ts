import type { ParseOptions, TagForm, TagHandler } from "../src/index.ts";
import {
  createPassthroughTags,
  createSimpleBlockHandlers,
  createSimpleInlineHandlers,
  createSimpleRawHandlers,
} from "../src/index.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type Expect<T extends true> = T;

const inlineHandlers = createSimpleInlineHandlers(["bold", "italic"] as const);
const blockHandlers = createSimpleBlockHandlers(["info", "warning"] as const);
const rawHandlers = createSimpleRawHandlers(["code", "math"] as const);
const passthroughHandlers = createPassthroughTags(["thin", "center"] as const);

type _InlineKeys = Expect<Equal<keyof typeof inlineHandlers, "bold" | "italic">>;
type _BlockKeys = Expect<Equal<keyof typeof blockHandlers, "info" | "warning">>;
type _RawKeys = Expect<Equal<keyof typeof rawHandlers, "code" | "math">>;
type _PassKeys = Expect<Equal<keyof typeof passthroughHandlers, "thin" | "center">>;
type _TagFormShape = Expect<Equal<TagForm, "inline" | "raw" | "block">>;

const handlers: Record<string, TagHandler> = {
  ...inlineHandlers,
  ...blockHandlers,
  ...rawHandlers,
  ...passthroughHandlers,
};

const validOptions: ParseOptions = {
  handlers,
  allowForms: ["inline", "raw", "block"],
};

void validOptions;

// @ts-expect-error invalid form should be rejected
const invalidOptions: ParseOptions = { allowForms: ["inline", "weird"] };
void invalidOptions;

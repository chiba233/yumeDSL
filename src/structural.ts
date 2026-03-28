import type {
  BufferState,
  StructuralNode,
  StructuralParseOptions,
  SyntaxConfig,
  TagHandler,
  TagNameConfig,
} from "./types.js";
import { createSyntax, getDefaultSyntaxInstance, getSyntax } from "./syntax.js";
import { createTagNameConfig, DEFAULT_TAG_NAME, getTagNameConfig } from "./chars.js";
import { warnDeprecated, withInternalCaller } from "./deprecations.js";
import { readEscapedSequence } from "./escape.js";
import { supportsInlineForm } from "./consumers.js";
import { emptyBuffer } from "./context.js";
import { filterHandlersByForms } from "./parse.js";
import {
  readTagStartInfo,
  getTagCloserType,
  findInlineClose,
  findBlockClose,
  findRawClose,
  skipTagBoundary,
} from "./scanner.js";
import { buildPositionTracker, makePosition, type PositionTracker } from "./positions.js";

// ── Form gating context ──

interface GatingContext {
  handlers: Record<string, TagHandler>;
  registeredTags: ReadonlySet<string>;
  allowInline: boolean;
}

// ── Structural parser ──

/**
 * Try to degrade a tag through the inline fallback path.
 */
const tryInlineFallback = (
  text: string,
  i: number,
  info: NonNullable<ReturnType<typeof readTagStartInfo>>,
  depth: number,
  depthLimit: number,
  gating: GatingContext,
  baseOffset: number,
  tracker: PositionTracker | null,
  syntax: SyntaxConfig,
  tagName: TagNameConfig,
): { nodes: StructuralNode[] | null; nextI: number; bufferAppend: string } => {
  const { endTag } = syntax;
  const handler = gating.handlers[info.tag];
  const isRegistered = gating.registeredTags.has(info.tag);

  if (!supportsInlineForm(handler, gating.allowInline, isRegistered)) {
    return { nodes: null, nextI: i + 1, bufferAppend: text[i] };
  }

  const closeStart = findInlineClose(text, info.inlineContentStart, syntax, tagName);
  if (closeStart === -1) {
    return {
      nodes: null,
      nextI: info.inlineContentStart,
      bufferAppend: text.slice(i, info.inlineContentStart),
    };
  }

  const children = parseNodes(
    text.slice(info.inlineContentStart, closeStart),
    depth + 1,
    depthLimit,
    gating,
    true,
    baseOffset + info.inlineContentStart,
    tracker,
    syntax,
    tagName,
  );
  const nextI = closeStart + endTag.length;
  const position = makePosition(tracker, baseOffset + i, baseOffset + nextI);
  return {
    nodes: [
      position
        ? { type: "inline" as const, tag: info.tag, children, position }
        : { type: "inline" as const, tag: info.tag, children },
    ],
    nextI,
    bufferAppend: "",
  };
};

const parseNodes = (
  text: string,
  depth: number,
  depthLimit: number,
  gating: GatingContext | null,
  insideArgs: boolean,
  baseOffset: number,
  tracker: PositionTracker | null,
  syntax: SyntaxConfig,
  tagName: TagNameConfig,
): StructuralNode[] => {
  const { tagDivider, tagOpen, endTag, rawOpen, rawClose, blockOpen, blockClose } = syntax;

  const nodes: StructuralNode[] = [];
  let i = 0;
  const buf: BufferState = emptyBuffer();

  const flush = () => {
    if (!buf.content) return;
    const position =
      buf.start >= 0 ? makePosition(tracker, baseOffset + buf.start, baseOffset + i) : undefined;
    const node: StructuralNode = { type: "text", value: buf.content };
    if (position) node.position = position;
    nodes.push(node);
    const reset = emptyBuffer();
    buf.content = reset.content;
    buf.start = reset.start;
    buf.sourceEnd = reset.sourceEnd;
  };

  while (i < text.length) {
    // ── Escape sequence ──
    const [escaped, next] = readEscapedSequence(text, i, syntax);
    if (escaped !== null) {
      flush();
      const position = makePosition(tracker, baseOffset + i, baseOffset + next);
      const node: StructuralNode = { type: "escape", raw: text.slice(i, next) };
      if (position) node.position = position;
      nodes.push(node);
      i = next;
      continue;
    }

    // ── Pipe separator (only inside tag argument sections) ──
    if (insideArgs && text.startsWith(tagDivider, i)) {
      flush();
      const position = makePosition(tracker, baseOffset + i, baseOffset + i + tagDivider.length);
      const node: StructuralNode = { type: "separator" };
      if (position) node.position = position;
      nodes.push(node);
      i += tagDivider.length;
      continue;
    }

    // ── Tag start ──
    const info = readTagStartInfo(text, i, syntax, tagName);
    if (!info) {
      if (buf.start === -1) buf.start = i;
      buf.content += text[i];
      i++;
      continue;
    }

    // ── Depth limit → skip entire tag ──
    if (depth >= depthLimit) {
      const degradedEnd = skipTagBoundary(text, info, syntax, tagName);
      if (buf.start === -1) buf.start = i;
      buf.content += text.slice(i, degradedEnd);
      i = degradedEnd;
      continue;
    }

    const closerInfo = getTagCloserType(text, info.tagNameEnd + tagOpen.length, syntax);
    if (!closerInfo) {
      if (buf.start === -1) buf.start = i;
      buf.content += text.slice(i, info.inlineContentStart);
      i = info.inlineContentStart;
      continue;
    }

    // ── Inline: $$tag(…)$$ ──
    if (closerInfo.closer === endTag) {
      // Form gating: check inline support
      if (
        gating &&
        !supportsInlineForm(
          gating.handlers[info.tag],
          gating.allowInline,
          gating.registeredTags.has(info.tag),
        )
      ) {
        if (buf.start === -1) buf.start = i;
        buf.content += text[i];
        i++;
        continue;
      }

      const closeStart = findInlineClose(text, info.inlineContentStart, syntax, tagName);
      if (closeStart === -1) {
        if (buf.start === -1) buf.start = i;
        buf.content += text.slice(i, info.inlineContentStart);
        i = info.inlineContentStart;
        continue;
      }
      flush();
      const nextI = closeStart + endTag.length;
      const position = makePosition(tracker, baseOffset + i, baseOffset + nextI);
      const node: StructuralNode = {
        type: "inline",
        tag: info.tag,
        children: parseNodes(
          text.slice(info.inlineContentStart, closeStart),
          depth + 1,
          depthLimit,
          gating,
          true,
          baseOffset + info.inlineContentStart,
          tracker,
          syntax,
          tagName,
        ),
      };
      if (position) node.position = position;
      nodes.push(node);
      i = nextI;
      continue;
    }

    // ── Complex form (raw or block syntax) ──

    if (gating) {
      const handler = gating.handlers[info.tag];
      const hasComplexSupport = !!handler?.raw || !!handler?.block;

      if (!hasComplexSupport) {
        const fb = tryInlineFallback(
          text,
          i,
          info,
          depth,
          depthLimit,
          gating,
          baseOffset,
          tracker,
          syntax,
          tagName,
        );
        if (fb.nodes) {
          flush();
          fb.nodes.forEach((n) => nodes.push(n));
        } else {
          if (buf.start === -1) buf.start = i;
          buf.content += fb.bufferAppend;
        }
        i = fb.nextI;
        continue;
      }
    }

    // ── Raw: $$tag(args)% content %end$$ ──
    if (closerInfo.closer === rawClose) {
      const contentStart = closerInfo.argClose + rawOpen.length;
      const closeStart = findRawClose(text, contentStart, syntax);
      if (closeStart === -1) {
        if (buf.start === -1) buf.start = i;
        buf.content += text.slice(i, contentStart);
        i = contentStart;
        continue;
      }

      if (gating && !gating.handlers[info.tag]?.raw) {
        if (buf.start === -1) buf.start = i;
        buf.content += text.slice(i, closeStart + rawClose.length);
        i = closeStart + rawClose.length;
        continue;
      }

      flush();
      const nextI = closeStart + rawClose.length;
      const position = makePosition(tracker, baseOffset + i, baseOffset + nextI);
      const node: StructuralNode = {
        type: "raw",
        tag: info.tag,
        args: parseNodes(
          text.slice(info.inlineContentStart, closerInfo.argClose),
          depth + 1,
          depthLimit,
          gating,
          true,
          baseOffset + info.inlineContentStart,
          tracker,
          syntax,
          tagName,
        ),
        content: text.slice(contentStart, closeStart),
      };
      if (position) node.position = position;
      nodes.push(node);
      i = nextI;
      continue;
    }

    // ── Block: $$tag(args)* content *end$$ ──
    const contentStart = closerInfo.argClose + blockOpen.length;
    const closeStart = findBlockClose(text, contentStart, syntax, tagName);
    if (closeStart === -1) {
      if (buf.start === -1) buf.start = i;
      buf.content += text.slice(i, contentStart);
      i = contentStart;
      continue;
    }

    if (gating && !gating.handlers[info.tag]?.block) {
      if (buf.start === -1) buf.start = i;
      buf.content += text.slice(i, closeStart + blockClose.length);
      i = closeStart + blockClose.length;
      continue;
    }

    flush();
    const nextI = closeStart + blockClose.length;
    const position = makePosition(tracker, baseOffset + i, baseOffset + nextI);
    const node: StructuralNode = {
      type: "block",
      tag: info.tag,
      args: parseNodes(
        text.slice(info.inlineContentStart, closerInfo.argClose),
        depth + 1,
        depthLimit,
        gating,
        true,
        baseOffset + info.inlineContentStart,
        tracker,
        syntax,
        tagName,
      ),
      children: parseNodes(
        text.slice(contentStart, closeStart),
        depth + 1,
        depthLimit,
        gating,
        false,
        baseOffset + contentStart,
        tracker,
        syntax,
        tagName,
      ),
    };
    if (position) node.position = position;
    nodes.push(node);
    i = nextI;
  }

  flush();
  return nodes;
};

/**
 * Parse rich-text DSL into a structural tree that preserves tag forms.
 *
 * When `handlers` is provided, tag recognition and form gating follow the
 * exact same rules as {@link parseRichText}:
 *
 * - Only registered tags are recognized; unknown tags pass through as inline.
 * - `allowForms` restricts which syntactic forms are accepted.
 * - Handler method presence (`inline` / `raw` / `block`) determines per-tag form support.
 *
 * When `handlers` is omitted, **all** tags in **all** forms are accepted.
 *
 * When `syntax` / `tagName` are omitted, defaults to {@link DEFAULT_SYNTAX} /
 * {@link DEFAULT_TAG_NAME}. Legacy `withSyntax` / `withTagNameConfig` ambient
 * wrapping is detected and used as a fallback with a deprecation warning.
 */
export const parseStructural = (
  text: string,
  options?: StructuralParseOptions,
): StructuralNode[] => {
  if (!text) return [];

  const depthLimit = options?.depthLimit ?? 50;

  let syntax: SyntaxConfig;
  if (options?.syntax) {
    syntax = createSyntax(options.syntax);
  } else {
    syntax = withInternalCaller(() => getSyntax());
    if (syntax !== getDefaultSyntaxInstance()) {
      warnDeprecated(
        "parseStructural.syntax",
        "parseStructural() is reading ambient withSyntax(). Pass syntax explicitly via options.syntax instead.",
      );
    }
  }

  let tagName: TagNameConfig;
  if (options?.tagName) {
    tagName = createTagNameConfig(options.tagName);
  } else {
    tagName = getTagNameConfig();
    if (tagName !== DEFAULT_TAG_NAME) {
      warnDeprecated(
        "parseStructural.tagName",
        "parseStructural() is reading ambient withTagNameConfig(). Pass tagName explicitly via options.tagName instead.",
      );
    }
  }

  // ── Build gating context (mirrors parseRichText entry) ──
  let gating: GatingContext | null = null;
  if (options?.handlers) {
    const rawHandlers = options.handlers;
    const registeredTags = new Set(Object.keys(rawHandlers));
    const handlers = options.allowForms
      ? filterHandlersByForms(rawHandlers, new Set(options.allowForms))
      : rawHandlers;
    const allowInline = !options.allowForms || options.allowForms.includes("inline");
    gating = { handlers, registeredTags, allowInline };
  }

  const tracker = options?.trackPositions ? buildPositionTracker(text) : null;

  return parseNodes(text, 0, depthLimit, gating, false, 0, tracker, syntax, tagName);
};

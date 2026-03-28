import type { SourceSpan, StructuralNode, StructuralParseOptions, TagHandler } from "./types.js";
import { createSyntax, getSyntax, withSyntax } from "./syntax.js";
import { createTagNameConfig, withTagNameConfig } from "./chars.js";
import { readEscapedSequence } from "./escape.js";
import { supportsInlineForm } from "./consumers.js";
import { filterHandlersByForms } from "./parse.js";
import {
  readTagStartInfo,
  getTagCloserType,
  findInlineClose,
  findBlockClose,
  findRawClose,
  skipTagBoundary,
  skipDegradedInline,
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
 *
 * This mirrors the main parser's behavior when `tryConsumeComplexTag` returns
 * `{ handled: false }` and falls through to `tryConsumeInlineTag`:
 * - If inline form is supported, attempt `findInlineClose`.
 * - If close found → parse as inline, return the nodes and new index.
 * - If close not found → degrade opening.
 * - If inline form not supported → degrade single char.
 *
 * Returns `null` when the caller should do `buffer += text[i]; i++`.
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
): { nodes: StructuralNode[] | null; nextI: number; bufferAppend: string } => {
  const { endTag } = getSyntax();
  const handler = gating.handlers[info.tag];
  const isRegistered = gating.registeredTags.has(info.tag);

  if (!supportsInlineForm(handler, gating.allowInline, isRegistered)) {
    return { nodes: null, nextI: i + 1, bufferAppend: text[i] };
  }

  const closeStart = findInlineClose(text, info.inlineContentStart);
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
  );
  const nextI = closeStart + endTag.length;
  const position = makePosition(tracker, baseOffset + i, baseOffset + nextI);
  return {
    nodes: [
      position
        ? {
            type: "inline" as const,
            tag: info.tag,
            children,
            position,
          }
        : {
            type: "inline" as const,
            tag: info.tag,
            children,
          },
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
): StructuralNode[] => {
  const { tagDivider, tagOpen, endTag, rawOpen, rawClose, blockOpen, blockClose } = getSyntax();

  const nodes: StructuralNode[] = [];
  let i = 0;
  let buffer = "";
  let bufferStart = -1;

  const flush = () => {
    if (!buffer) return;
    const position = bufferStart >= 0
      ? makePosition(tracker, baseOffset + bufferStart, baseOffset + i)
      : undefined;
    const node: StructuralNode = { type: "text", value: buffer };
    if (position) node.position = position;
    nodes.push(node);
    buffer = "";
    bufferStart = -1;
  };

  while (i < text.length) {
    // ── Escape sequence ──
    const [escaped, next] = readEscapedSequence(text, i);
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
    const info = readTagStartInfo(text, i);
    if (!info) {
      if (bufferStart === -1) bufferStart = i;
      buffer += text[i];
      i++;
      continue;
    }

    // ── Depth limit → skip entire tag ──
    if (depth >= depthLimit) {
      const degradedEnd = skipTagBoundary(text, info);
      if (bufferStart === -1) bufferStart = i;
      buffer += text.slice(i, degradedEnd);
      i = degradedEnd;
      continue;
    }

    const closerInfo = getTagCloserType(text, info.tagNameEnd + tagOpen.length);
    if (!closerInfo) {
      if (bufferStart === -1) bufferStart = i;
      buffer += text.slice(i, info.inlineContentStart);
      i = info.inlineContentStart;
      continue;
    }

    // ── Inline: $$tag(…)$$ ──
    if (closerInfo.closer === endTag) {
      // Form gating: check inline support
      if (gating && !supportsInlineForm(
        gating.handlers[info.tag],
        gating.allowInline,
        gating.registeredTags.has(info.tag),
      )) {
        if (bufferStart === -1) bufferStart = i;
        buffer += text[i];
        i++;
        continue;
      }

      const closeStart = findInlineClose(text, info.inlineContentStart);
      if (closeStart === -1) {
        if (bufferStart === -1) bufferStart = i;
        buffer += text.slice(i, info.inlineContentStart);
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
        ),
      };
      if (position) node.position = position;
      nodes.push(node);
      i = nextI;
      continue;
    }

    // ── Complex form (raw or block syntax) ──

    // Form gating: if handler has no complex support → inline fallback
    // Mirrors: tryConsumeComplexTag returning { handled: false } → tryConsumeInlineTag
    if (gating) {
      const handler = gating.handlers[info.tag];
      const hasComplexSupport = !!handler?.raw || !!handler?.block;

      if (!hasComplexSupport) {
        const fb = tryInlineFallback(text, i, info, depth, depthLimit, gating, baseOffset, tracker);
        if (fb.nodes) {
          flush();
          fb.nodes.forEach((n) => nodes.push(n));
        } else {
          if (bufferStart === -1) bufferStart = i;
          buffer += fb.bufferAppend;
        }
        i = fb.nextI;
        continue;
      }
    }

    // ── Raw: $$tag(args)% content %end$$ ──
    if (closerInfo.closer === rawClose) {
      const contentStart = closerInfo.argClose + rawOpen.length;
      const closeStart = findRawClose(text, contentStart);
      if (closeStart === -1) {
        if (bufferStart === -1) bufferStart = i;
        buffer += text.slice(i, contentStart);
        i = contentStart;
        continue;
      }

      // Form gating: handler has complex support but not raw specifically
      // Mirrors: tryParseComplexTag `if (!handler.raw) { fallbackText }`
      if (gating && !gating.handlers[info.tag]?.raw) {
        if (bufferStart === -1) bufferStart = i;
        buffer += text.slice(i, closeStart + rawClose.length);
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
    const closeStart = findBlockClose(text, contentStart);
    if (closeStart === -1) {
      if (bufferStart === -1) bufferStart = i;
      buffer += text.slice(i, contentStart);
      i = contentStart;
      continue;
    }

    // Form gating: handler has complex support but not block specifically
    // Mirrors: tryParseComplexTag `if (!handler.block) { fallbackText }`
    if (gating && !gating.handlers[info.tag]?.block) {
      if (bufferStart === -1) bufferStart = i;
      buffer += text.slice(i, closeStart + blockClose.length);
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
      ),
      children: parseNodes(text.slice(contentStart, closeStart), depth + 1, depthLimit, gating, false, baseOffset + contentStart, tracker),
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
 * Respects the active syntax set via {@link withSyntax}; defaults to
 * {@link DEFAULT_SYNTAX}.
 */
export const parseStructural = (
  text: string,
  options?: StructuralParseOptions,
): StructuralNode[] => {
  if (!text) return [];

  const depthLimit = options?.depthLimit ?? 50;

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

  // ── Build run function with optional context closures ──
  let run: () => StructuralNode[] = () => parseNodes(text, 0, depthLimit, gating, false, 0, tracker);

  if (options?.tagName) {
    const inner = run;
    const tagName = createTagNameConfig(options.tagName);
    run = () => withTagNameConfig(tagName, inner);
  }

  if (options?.syntax) {
    const inner = run;
    const syntax = createSyntax(options.syntax);
    run = () => withSyntax(syntax, inner);
  }

  return run();
};

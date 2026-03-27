import type { StructuralNode, StructuralParseOptions, TagHandler } from "./types.js";
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
  skipDegradedInline,
} from "./scanner.js";

// ── Form gating context ──

interface GatingContext {
  handlers: Record<string, TagHandler>;
  registeredTags: ReadonlySet<string>;
  allowInline: boolean;
}

// ── Structural parser ──

/**
 * Skip over a depth-limited tag without parsing its internals.
 * Returns the position immediately after the tag boundary.
 */
const skipTagBoundary = (
  text: string,
  info: NonNullable<ReturnType<typeof readTagStartInfo>>,
): number => {
  const { tagOpen, endTag, rawOpen, rawClose, blockOpen, blockClose } = getSyntax();

  const closerInfo = getTagCloserType(text, info.tagNameEnd + tagOpen.length);
  if (!closerInfo) return info.inlineContentStart;

  if (closerInfo.closer === endTag) {
    const closeStart = findInlineClose(text, info.inlineContentStart);
    return closeStart === -1
      ? skipDegradedInline(text, info.inlineContentStart)
      : closeStart + endTag.length;
  }

  if (closerInfo.closer === rawClose) {
    const contentStart = closerInfo.argClose + rawOpen.length;
    const closeStart = findRawClose(text, contentStart);
    return closeStart === -1 ? contentStart : closeStart + rawClose.length;
  }

  const contentStart = closerInfo.argClose + blockOpen.length;
  const closeStart = findBlockClose(text, contentStart);
  return closeStart === -1 ? contentStart : closeStart + blockClose.length;
};

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
  );
  return {
    nodes: [{ type: "inline" as const, tag: info.tag, children }],
    nextI: closeStart + endTag.length,
    bufferAppend: "",
  };
};

const parseNodes = (
  text: string,
  depth: number,
  depthLimit: number,
  gating: GatingContext | null,
  insideArgs: boolean,
): StructuralNode[] => {
  const { tagDivider, tagOpen, endTag, rawOpen, rawClose, blockOpen, blockClose } = getSyntax();

  const nodes: StructuralNode[] = [];
  let i = 0;
  let buffer = "";

  const flush = () => {
    if (!buffer) return;
    nodes.push({ type: "text", value: buffer });
    buffer = "";
  };

  while (i < text.length) {
    // ── Escape sequence ──
    const [escaped, next] = readEscapedSequence(text, i);
    if (escaped !== null) {
      flush();
      nodes.push({ type: "escape", raw: text.slice(i, next) });
      i = next;
      continue;
    }

    // ── Pipe separator (only inside tag argument sections) ──
    if (insideArgs && text.startsWith(tagDivider, i)) {
      flush();
      nodes.push({ type: "separator" });
      i += tagDivider.length;
      continue;
    }

    // ── Tag start ──
    const info = readTagStartInfo(text, i);
    if (!info) {
      buffer += text[i];
      i++;
      continue;
    }

    // ── Depth limit → skip entire tag ──
    if (depth >= depthLimit) {
      const degradedEnd = skipTagBoundary(text, info);
      buffer += text.slice(i, degradedEnd);
      i = degradedEnd;
      continue;
    }

    const closerInfo = getTagCloserType(text, info.tagNameEnd + tagOpen.length);
    if (!closerInfo) {
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
        buffer += text[i];
        i++;
        continue;
      }

      const closeStart = findInlineClose(text, info.inlineContentStart);
      if (closeStart === -1) {
        buffer += text.slice(i, info.inlineContentStart);
        i = info.inlineContentStart;
        continue;
      }
      flush();
      nodes.push({
        type: "inline",
        tag: info.tag,
        children: parseNodes(
          text.slice(info.inlineContentStart, closeStart),
          depth + 1,
          depthLimit,
          gating,
          true,
        ),
      });
      i = closeStart + endTag.length;
      continue;
    }

    // ── Complex form (raw or block syntax) ──

    // Form gating: if handler has no complex support → inline fallback
    // Mirrors: tryConsumeComplexTag returning { handled: false } → tryConsumeInlineTag
    if (gating) {
      const handler = gating.handlers[info.tag];
      const hasComplexSupport = !!handler?.raw || !!handler?.block;

      if (!hasComplexSupport) {
        const fb = tryInlineFallback(text, i, info, depth, depthLimit, gating);
        if (fb.nodes) {
          flush();
          fb.nodes.forEach((n) => nodes.push(n));
        } else {
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
        buffer += text.slice(i, contentStart);
        i = contentStart;
        continue;
      }

      // Form gating: handler has complex support but not raw specifically
      // Mirrors: tryParseComplexTag `if (!handler.raw) { fallbackText }`
      if (gating && !gating.handlers[info.tag]?.raw) {
        buffer += text.slice(i, closeStart + rawClose.length);
        i = closeStart + rawClose.length;
        continue;
      }

      flush();
      nodes.push({
        type: "raw",
        tag: info.tag,
        args: parseNodes(
          text.slice(info.inlineContentStart, closerInfo.argClose),
          depth + 1,
          depthLimit,
          gating,
          true,
        ),
        content: text.slice(contentStart, closeStart),
      });
      i = closeStart + rawClose.length;
      continue;
    }

    // ── Block: $$tag(args)* content *end$$ ──
    const contentStart = closerInfo.argClose + blockOpen.length;
    const closeStart = findBlockClose(text, contentStart);
    if (closeStart === -1) {
      buffer += text.slice(i, contentStart);
      i = contentStart;
      continue;
    }

    // Form gating: handler has complex support but not block specifically
    // Mirrors: tryParseComplexTag `if (!handler.block) { fallbackText }`
    if (gating && !gating.handlers[info.tag]?.block) {
      buffer += text.slice(i, closeStart + blockClose.length);
      i = closeStart + blockClose.length;
      continue;
    }

    flush();
    nodes.push({
      type: "block",
      tag: info.tag,
      args: parseNodes(
        text.slice(info.inlineContentStart, closerInfo.argClose),
        depth + 1,
        depthLimit,
        gating,
        true,
      ),
      children: parseNodes(text.slice(contentStart, closeStart), depth + 1, depthLimit, gating, false),
    });
    i = closeStart + blockClose.length;
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
 * When `handlers` is omitted, **all** tags in **all** forms are accepted (highlight mode).
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

  // ── Build run function with optional context closures ──
  let run: () => StructuralNode[] = () => parseNodes(text, 0, depthLimit, gating, false);

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

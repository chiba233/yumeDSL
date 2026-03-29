import type {
  BufferState,
  StructuralNode,
  StructuralParseOptions,
  SyntaxConfig,
  TagNameConfig,
} from "./types.js";
import { getDefaultSyntaxInstance, getSyntax } from "./syntax.js";
import { DEFAULT_TAG_NAME, getTagNameConfig } from "./chars.js";
import { warnDeprecated } from "./deprecations.js";
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
import {
  buildPositionTracker,
  localOffsetTracker,
  makePosition,
  offsetTracker as wrapOffsetTracker,
  type PositionTracker,
} from "./positions.js";
import { type GatingContext, buildGatingContext, resolveBaseOptions } from "./resolveOptions.js";

// ── Form gating context ──


const pushNode = (nodes: StructuralNode[], node: StructuralNode, position: ReturnType<typeof makePosition>) => {
  if (position) node.position = position;
  nodes.push(node);
};

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
  const node: StructuralNode = { type: "inline", tag: info.tag, children };
  if (position) node.position = position;
  return {
    nodes: [node],
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
  // 注意：这是 structural parser 的主状态机。
  // 它不走 handler，也不产出运行时 token；这里只有三类核心状态：
  // `i`（扫描指针）、`buf`（待 flush 的纯文本）、`nodes`（当前层结构节点）。
  // 一旦改动“何时 flush / 何时推进 i / 何时递归”，
  // raw/block/inline 的边界和 position 映射都很容易一起偏掉。
  const { tagDivider, tagOpen, endTag, rawOpen, rawClose, blockOpen, blockClose } = syntax;

  const nodes: StructuralNode[] = [];
  let i = 0;
  const buf: BufferState = emptyBuffer();

  const flush = () => {
    if (!buf.content) return;
    const position =
      buf.start >= 0 ? makePosition(tracker, baseOffset + buf.start, baseOffset + i) : undefined;
    pushNode(nodes, { type: "text", value: buf.content }, position);
    const reset = emptyBuffer();
    buf.content = reset.content;
    buf.start = reset.start;
    buf.sourceEnd = reset.sourceEnd;
  };

  // 注意：这里同样依赖固定优先级：
  // escape -> 参数分隔符 -> tag start -> 普通文本。
  // 前面命中时必须先 flush，再推进指针；否则节点切分和子节点 position 会错。
  while (i < text.length) {
    // ── Escape sequence ──
    const [escaped, next] = readEscapedSequence(text, i, syntax);
    if (escaped !== null) {
      flush();
      pushNode(nodes, { type: "escape", raw: text.slice(i, next) }, makePosition(tracker, baseOffset + i, baseOffset + next));
      i = next;
      continue;
    }

    // ── Pipe separator (only inside tag argument sections) ──
    if (insideArgs && text.startsWith(tagDivider, i)) {
      flush();
      pushNode(nodes, { type: "separator" }, makePosition(tracker, baseOffset + i, baseOffset + i + tagDivider.length));
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

    // 注意：下面 inline / raw / block 三段是并排的同构分支。
    // 如果你只修其中一段，不同步检查另外两段，位置映射和退化行为大概率会分叉。
    // 这里最危险的点不是“能不能 parse”，而是：
    // 1. `flush()` 调用时机
    // 2. `nextI` 的闭合范围到底吃到哪里
    // 3. 递归子树的 `baseOffset` 到底从哪里开始算
    // 这三件事只要有一段偏了，测试不一定马上全红，但 structural 的位置会先悄悄烂掉。
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
      // 注意：这里必须先 flush 再挂 inline 节点，否则前置纯文本会被错误并进当前 tag 前后。
      // `nextI` 也必须覆盖完整 endTag；少吃一个字符，后面的源码 span 会整体错位。
      flush();
      const nextI = closeStart + endTag.length;
      pushNode(
        nodes,
        {
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
        },
        makePosition(tracker, baseOffset + i, baseOffset + nextI),
      );
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
      // 注意：raw 的 args 和 content 起点不一样。
      // `inlineContentStart` 是参数区起点，`contentStart` 才是正文起点；
      // 这俩混了以后，args 子节点和 content 整体 position 会一起偏。
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

      // 注意：raw 分支和 inline/block 一样，都是“flush -> 算 nextI -> 挂节点 -> i = nextI”。
      // 这里别单独搞特殊流程，不然后面三条分支的边界语义会各说各话。
      flush();
      const nextI = closeStart + rawClose.length;
      pushNode(
        nodes,
        {
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
        },
        makePosition(tracker, baseOffset + i, baseOffset + nextI),
      );
      i = nextI;
      continue;
    }

    // ── Block: $$tag(args)* content *end$$ ──
    // 注意：block 是最容易被顺手改炸的分支，因为它同时有 args 子树和 children 子树，
    // 两边的 `baseOffset` 起点不同；一边对一边错时，表面 parse 正常，位置却会成片漂移。
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

    // 注意：这里的 `nextI` 必须吃完整个 blockClose；children 的递归起点必须从 `contentStart` 算。
    // 改这里前先对照 raw/inline 一起看，不要只在 block 上做“看起来合理”的局部修补。
    flush();
    const nextI = closeStart + blockClose.length;
    pushNode(
      nodes,
      {
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
      },
      makePosition(tracker, baseOffset + i, baseOffset + nextI),
    );
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

  // ── Legacy ambient fallback (parseStructural-specific) ──
  let legacySyntax: SyntaxConfig | undefined;
  if (!options?.syntax) {
    // 注意：这里只是兼容老的 withSyntax 闭包，不是推荐路径。
    // 新代码请老老实实从 options 传 syntax；这里一旦改坏，structural 会偷偷吃 ambient 配置。
    const ambient = getSyntax({ suppressDeprecation: true });
    if (ambient !== getDefaultSyntaxInstance()) {
      warnDeprecated(
        "parseStructural.syntax",
        "parseStructural() is reading ambient withSyntax(). Pass syntax explicitly via options.syntax instead.",
      );
      legacySyntax = ambient;
    }
  }

  let legacyTagName: TagNameConfig | undefined;
  if (!options?.tagName) {
    const ambient = getTagNameConfig();
    if (ambient !== DEFAULT_TAG_NAME) {
      warnDeprecated(
        "parseStructural.tagName",
        "parseStructural() is reading ambient withTagNameConfig(). Pass tagName explicitly via options.tagName instead.",
      );
      legacyTagName = ambient;
    }
  }

  const { syntax, tagName, depthLimit, tracker } = resolveBaseOptions(text, options, {
    syntax: legacySyntax,
    tagName: legacyTagName,
  });

  const gating = options?.handlers
    ? buildGatingContext(options.handlers, options.allowForms, filterHandlersByForms)
    : null;

  return parseNodes(text, 0, depthLimit, gating, false, 0, tracker, syntax, tagName);
};

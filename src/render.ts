import type {
  BlockTagLookup,
  CreateId,
  DslContext,
  MultilineForm,
  PositionTracker,
  SyntaxConfig,
  TextToken,
} from "./types.js";
import { createTextToken, materializeTextTokens } from "./builders.js";
import { supportsInlineForm } from "./resolveOptions.js";
import { createToken } from "./createToken.js";
import { makePosition } from "./positions.js";
import { readEscaped } from "./escape.js";
import { normalizeBlockTagContent, consumeBlockTagTrailingLineBreak } from "./blockTagFormatting.js";
import type { IndexedStructuralNode, TagMeta } from "./structural.js";

type EscapeMode = "root" | "nested";

export interface RenderContext {
  source: string;
  handlers: Record<string, import("./types").TagHandler>;
  registeredTags: ReadonlySet<string>;
  allowInline: boolean;
  blockTagSet: BlockTagLookup;
  tracker: PositionTracker | null;
  syntax: SyntaxConfig;
  createId: CreateId;
}

// ── 相邻 text 合并 ──

const mergeTextToken = (
  tokens: TextToken[],
  value: string,
  position: TextToken["position"],
  dslCtx: DslContext,
) => {
  if (!value) return;
  const last = tokens[tokens.length - 1];
  if (last?.type === "text" && typeof last.value === "string") {
    last.value += value;
    if (position && last.position) {
      last.position = { start: last.position.start, end: position.end };
    }
    return;
  }
  tokens.push(position ? { ...createTextToken(value, dslCtx), position } : createTextToken(value, dslCtx));
};

const appendToken = (tokens: TextToken[], token: TextToken, dslCtx: DslContext) => {
  if (token.type === "text" && typeof token.value === "string") {
    mergeTextToken(tokens, token.value, token.position, dslCtx);
    return;
  }
  tokens.push(token);
};

// ── 换行 / position 工具 ──

const trimLeadingLineBreak = (value: string): [string, number] => {
  if (value.startsWith("\r\n")) return [value.slice(2), 2];
  if (value.startsWith("\n")) return [value.slice(1), 1];
  return [value, 0];
};

const trimTrailingLineBreak = (value: string): [string, number] => {
  if (value.endsWith("\r\n")) return [value.slice(0, -2), 2];
  if (value.endsWith("\n")) return [value.slice(0, -1), 1];
  return [value, 0];
};

const shiftPosition = (
  pos: TextToken["position"],
  tracker: PositionTracker | null,
  side: "start" | "end",
  delta: number,
): TextToken["position"] => {
  if (!pos || !tracker) return pos;
  return side === "start"
    ? { start: tracker.resolve(pos.start.offset + delta), end: pos.end }
    : { start: pos.start, end: tracker.resolve(pos.end.offset - delta) };
};

const cloneToken = (token: TextToken): TextToken => {
  const cloned: TextToken = {
    ...token,
    value: Array.isArray(token.value) ? token.value.map(cloneToken) : token.value,
  };
  if (token.position) {
    cloned.position = { start: token.position.start, end: token.position.end };
  }
  return cloned;
};

// 注意：这里必须 clone 再改，不能直接 mutate renderNodes 返回的 token。
// block handler 拿到的 children 是 renderNodes 的返回值，如果直接改，
// handler 内部再读 children 时会看到被削掉的值。
const trimBlockBoundaryTokens = (
  tokens: TextToken[],
  tracker: PositionTracker | null,
): TextToken[] => {
  const trimmed = tokens.map(cloneToken);

  const first = trimmed[0];
  if (first?.type === "text" && typeof first.value === "string") {
    const [nextValue, removed] = trimLeadingLineBreak(first.value);
    if (removed > 0) {
      if (!nextValue) { trimmed.shift(); }
      else {
        first.value = nextValue;
        if (first.position && tracker) first.position = shiftPosition(first.position, tracker, "start", removed);
      }
    }
  }

  const last = trimmed[trimmed.length - 1];
  if (last?.type === "text" && typeof last.value === "string") {
    const [nextValue, removed] = trimTrailingLineBreak(last.value);
    if (removed > 0) {
      if (!nextValue) { trimmed.pop(); }
      else {
        last.value = nextValue;
        if (last.position && tracker) last.position = shiftPosition(last.position, tracker, "end", removed);
      }
    }
  }

  return trimmed;
};

// ── 节点降级 ──

// 注意：handler 不支持 / _meta 不完整时，整个节点退化回源码原文。
// 这里用的是 _meta.start/end 从 source 切片，不是 node 自身的 value；
// 改错后退化输出会截断或越界。
const degradeToSource = (
  tokens: TextToken[],
  node: IndexedStructuralNode,
  ctx: RenderContext,
  dslCtx: DslContext,
) => {
  mergeTextToken(tokens, ctx.source.slice(node._meta.start, node._meta.end), node.position, dslCtx);
};

// block/raw 标签的 position 要吃掉尾部被消费的换行。
const complexTagPosition = (
  ctx: RenderContext,
  tag: string,
  meta: TagMeta,
  form: MultilineForm,
) => {
  const end = consumeBlockTagTrailingLineBreak(tag, ctx.source, meta.end, ctx.blockTagSet, form);
  return makePosition(ctx.tracker, meta.start, end);
};

// ── 各节点类型的 render ──
//
// 注意：下面四个函数和 structural.ts 里 inline/raw/block 三段是对应关系。
// structural 负责"识别边界"，这里负责"调 handler 产出 token"。
// 如果你只改了一边而没检查另一边，退化行为和 position 映射大概率会分叉。

const renderTextLikeNode = (
  node: Extract<IndexedStructuralNode, { type: "text" | "escape" | "separator" }>,
  tokens: TextToken[],
  ctx: RenderContext,
  dslCtx: DslContext,
  escapeMode: EscapeMode,
): void => {
  switch (node.type) {
    case "text":
      mergeTextToken(tokens, node.value, node.position, dslCtx);
      return;
    case "escape": {
      // 注意：root 层解转义（\| → |），nested 层保留原始 escape（\| 原样传给 handler）。
      // nested 不能解是因为 parsePipeArgs 等 handler 工具需要先看到原始 \|，
      // 否则会把它误当分隔符。这个不是 bug，是刻意语义。
      const value = escapeMode === "root" ? readEscaped(node.raw, 0, ctx.syntax)[0] : node.raw;
      mergeTextToken(tokens, value, node.position, dslCtx);
      return;
    }
    case "separator":
      mergeTextToken(tokens, ctx.syntax.tagDivider, node.position, dslCtx);
      return;
  }
};

// 注意：inline 有三条路径，顺序不能乱：
// 1. 不支持 inline form → 退化回源码
// 2. handler 不存在（unknown tag passthrough）→ 去壳保留子节点
// 3. handler 存在 → 调 handler.inline 或 fallback 到 { type: tag, value: children }
const renderInlineNode = (
  node: Extract<IndexedStructuralNode, { type: "inline" }>,
  childTokens: TextToken[],
  tokens: TextToken[],
  ctx: RenderContext,
  dslCtx: DslContext,
): boolean => {
  const handler = ctx.handlers[node.tag];
  if (!supportsInlineForm(handler, ctx.allowInline, ctx.registeredTags.has(node.tag))) {
    degradeToSource(tokens, node, ctx, dslCtx);
    return false;
  }

  if (!handler) {
    // unknown tag passthrough：去壳，子节点原样落回当前层
    for (const t of materializeTextTokens(childTokens, dslCtx)) appendToken(tokens, t, dslCtx);
    return ctx.blockTagSet.has(node.tag, "inline");
  }

  const rendered = handler.inline
    ? { ...handler.inline(childTokens, dslCtx) }
    : { type: node.tag, value: materializeTextTokens(childTokens, dslCtx) };
  appendToken(tokens, createToken(rendered, node.position, dslCtx), dslCtx);
  return ctx.blockTagSet.has(node.tag, "inline");
};

const renderRawNode = (
  node: Extract<IndexedStructuralNode, { type: "raw" }>,
  tokens: TextToken[],
  ctx: RenderContext,
  dslCtx: DslContext,
): boolean => {
  const handler = ctx.handlers[node.tag];
  if (!handler?.raw) {
    degradeToSource(tokens, node, ctx, dslCtx);
    return false;
  }

  const { argStart, argEnd, contentStart, contentEnd } = node._meta;
  const arg = ctx.source.slice(argStart, argEnd).trim();
  const rawContent = ctx.source.slice(contentStart, contentEnd);
  // 注意：raw 正文里的转义闭合符（如 \%end$$）要还原成字面量，
  // 这里用 split/join 而不是 replace 是因为 escapeChar 可能是多字符。
  const unescaped = rawContent.split(ctx.syntax.escapeChar + ctx.syntax.rawClose).join(ctx.syntax.rawClose);
  const { content } = normalizeBlockTagContent(node.tag, unescaped, ctx.blockTagSet, "raw");
  const draft = handler.raw(arg, content, dslCtx);
  appendToken(tokens, createToken(draft, complexTagPosition(ctx, node.tag, node._meta, "raw"), dslCtx), dslCtx);
  return ctx.blockTagSet.has(node.tag, "raw");
};

const renderBlockNode = (
  node: Extract<IndexedStructuralNode, { type: "block" }>,
  childTokens: TextToken[],
  tokens: TextToken[],
  ctx: RenderContext,
  dslCtx: DslContext,
): boolean => {
  const handler = ctx.handlers[node.tag];
  if (!handler?.block) {
    degradeToSource(tokens, node, ctx, dslCtx);
    return false;
  }

  const { argStart, argEnd } = node._meta;
  const arg = ctx.source.slice(argStart, argEnd).trim();
  const normalizedChildren = ctx.blockTagSet.has(node.tag, "block")
    ? trimBlockBoundaryTokens(childTokens, ctx.tracker)
    : childTokens;
  const draft = handler.block(arg, normalizedChildren, dslCtx);
  appendToken(tokens, createToken(draft, complexTagPosition(ctx, node.tag, node._meta, "block"), dslCtx), dslCtx);
  return ctx.blockTagSet.has(node.tag, "block");
};

// ── 主循环 ──
//
// 注意：这是 render 阶段的主入口。它和旧版 internalParse 的 while 循环是对应物，
// 但不再逐字符扫描——structural parser 已经把边界全部算好了，
// 这里只需要按节点类型分发、调 handler、处理兄弟间换行。
//
// 每个 render*Node 返回 boolean：true 表示"我是 block-like 标签，
// 下一个兄弟节点的前导换行要吃掉"。
//
// 注意：block/raw/inline(blockTag) 标签渲染完之后，紧跟的第一个换行不属于内容，
// 而是标签自身"占行"的副作用。这个逻辑和旧版 tryConsumeTagClose 里的
// consumeBlockTagTrailingLineBreak 是对应的，只是从"扫描时消费"变成了"渲染时跳过"。
// 如果漏掉这一步，连续 block 标签之间会多出空行。

export const renderNodes = (
  nodes: IndexedStructuralNode[],
  ctx: RenderContext,
  escapeMode: EscapeMode,
): TextToken[] => {
  const dslCtx: DslContext = { syntax: ctx.syntax, createId: ctx.createId };
  interface RenderFrame {
    nodes: IndexedStructuralNode[];
    index: number;
    escapeMode: EscapeMode;
    tokens: TextToken[];
    consumeNextLB: boolean;
    resume: ((childTokens: TextToken[]) => void) | null;
  }

  const stack: RenderFrame[] = [{
    nodes,
    index: 0,
    escapeMode,
    tokens: [],
    consumeNextLB: false,
    resume: null,
  }];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.nodes.length) {
      const childTokens = frame.tokens;
      const resume = frame.resume;
      stack.pop();
      if (!resume) return childTokens;
      resume(childTokens);
      continue;
    }

    const node = frame.nodes[frame.index++];

    if (frame.consumeNextLB) {
      frame.consumeNextLB = false;
      if (node.type === "text") {
        const [trimmed, removed] = trimLeadingLineBreak(node.value);
        if (removed > 0) {
          if (trimmed) {
            mergeTextToken(
              frame.tokens,
              trimmed,
              shiftPosition(node.position, ctx.tracker, "start", removed),
              dslCtx,
            );
          }
          continue;
        }
      }
    }

    switch (node.type) {
      case "text":
      case "escape":
      case "separator":
        renderTextLikeNode(node, frame.tokens, ctx, dslCtx, frame.escapeMode);
        break;
      case "inline":
        stack.push({
          nodes: node.children,
          index: 0,
          escapeMode: "nested",
          tokens: [],
          consumeNextLB: false,
          resume: (childTokens) => {
            frame.consumeNextLB = renderInlineNode(node, childTokens, frame.tokens, ctx, dslCtx);
          },
        });
        break;
      case "raw":
        frame.consumeNextLB = renderRawNode(node, frame.tokens, ctx, dslCtx);
        break;
      case "block":
        stack.push({
          nodes: node.children,
          index: 0,
          escapeMode: "root",
          tokens: [],
          consumeNextLB: false,
          resume: (childTokens) => {
            frame.consumeNextLB = renderBlockNode(node, childTokens, frame.tokens, ctx, dslCtx);
          },
        });
        break;
    }
  }

  return [];
};

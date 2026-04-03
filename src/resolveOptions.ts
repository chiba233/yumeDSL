import type {
  ParserBaseOptions,
  PositionTracker,
  SyntaxConfig,
  TagForm,
  TagHandler,
  TagNameConfig,
} from "./types.js";
import { createSyntax } from "./syntax.js";
import { createTagNameConfig } from "./chars.js";
import {
  buildPositionTracker,
  localOffsetTracker,
  offsetTracker,
} from "./positions.js";

// ── Gating ──

export interface GatingContext {
  handlers: Record<string, TagHandler>;
  registeredTags: ReadonlySet<string>;
  allowInline: boolean;
}

export const filterHandlersByForms = (
  handlers: Record<string, TagHandler>,
  forms: ReadonlySet<TagForm>,
): Record<string, TagHandler> => {
  const allowInline = forms.has("inline");
  const allowRaw = forms.has("raw");
  const allowBlock = forms.has("block");

  const result: Record<string, TagHandler> = {};
  for (const [name, handler] of Object.entries(handlers)) {
    const hasInline = !!handler.inline;
    const hasRaw = !!handler.raw;
    const hasBlock = !!handler.block;
    const isPassthrough = !hasInline && !hasRaw && !hasBlock;

    // Passthrough handlers work through the inline code path
    if (isPassthrough) {
      if (allowInline) result[name] = handler;
      continue;
    }

    const filtered: TagHandler = {};
    if (allowInline && hasInline) filtered.inline = handler.inline;
    if (allowRaw && hasRaw) filtered.raw = handler.raw;
    if (allowBlock && hasBlock) filtered.block = handler.block;

    if (filtered.inline || filtered.raw || filtered.block) {
      result[name] = filtered;
    }
  }
  return result;
};

/**
 * Decide whether a tag may be consumed via the inline code path.
 *
 * Decision table (evaluated top-to-bottom, first match wins):
 *
 *  allowInline=false                          -> reject  (global inline disabled)
 *  handler missing + tag NOT registered       -> accept  (unknown tag -> passthrough)
 *  handler missing + tag IS registered        -> reject  (registered but filtered out by allowForms)
 *  handler has `inline`                       -> accept  (explicit inline support)
 *  handler has only `raw` / `block`           -> reject  (block/raw-only tag)
 *  handler is empty `{}`                      -> accept  (passthrough handler)
 *
 * This function is the inline-form rules centre.
 * Changes here affect every tag in every parse mode — add tests, not shortcuts.
 */
export const supportsInlineForm = (
  handler: TagHandler | undefined,
  allowInline: boolean,
  isRegistered: boolean,
): boolean => {
  if (!allowInline) return false;
  if (!handler) return !isRegistered;
  if (handler.inline) return true;
  return !handler.raw && !handler.block;
};

export const buildGatingContext = (
  handlers: Record<string, TagHandler>,
  allowForms: readonly TagForm[] | undefined,
): GatingContext => {
  const registeredTags = new Set(Object.keys(handlers));
  const filtered = allowForms
    ? filterHandlersByForms(handlers, new Set(allowForms))
    : handlers;
  const allowInline = !allowForms || allowForms.includes("inline");
  return { handlers: filtered, registeredTags, allowInline };
};

// ── Shared base options ──

export interface ResolvedBaseOptions {
  syntax: SyntaxConfig;
  tagName: TagNameConfig;
  depthLimit: number;
  tracker: PositionTracker | null;
}

/**
 * Resolve shared base options for both parseRichText and parseStructural.
 *
 * `overrides.syntax` / `overrides.tagName` allow the caller to inject
 * pre-resolved values (e.g. from legacy ambient fallback in parseStructural).
 * When omitted, they are derived from `options.syntax` / `options.tagName`.
 */
export const resolveBaseOptions = (
  text: string,
  options?: ParserBaseOptions & { trackPositions?: boolean },
  overrides?: { syntax?: SyntaxConfig; tagName?: TagNameConfig },
): ResolvedBaseOptions => {
  const syntax = overrides?.syntax ?? createSyntax(options?.syntax);
  const tagName = overrides?.tagName ?? createTagNameConfig(options?.tagName);
  const depthLimit = options?.depthLimit ?? 50;

  const baseOffset = options?.baseOffset ?? 0;
  const localTracker = options?.trackPositions ? buildPositionTracker(text) : null;
  // 注意：这里的语义比较绕，不要想当然。
  // 1. `trackPositions` 只决定要不要为“当前 text”现建本地 tracker
  // 2. 只要显式传了 `options.tracker`，下面仍然会走外部 tracker 路径
  // 3. `baseOffset` 只偏 offset；line/column 要不要跟着回指，取决于 tracker 来源
  // 这里改错后，slice 场景的位置很容易整体错位。
  const tracker = options?.tracker
    ? (offsetTracker(options.tracker, baseOffset) ?? options.tracker)
    : (localOffsetTracker(localTracker, baseOffset) ?? localTracker);

  return { syntax, tagName, depthLimit, tracker };
};

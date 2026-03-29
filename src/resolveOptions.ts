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

export const buildGatingContext = (
  handlers: Record<string, TagHandler>,
  allowForms: readonly TagForm[] | undefined,
  filterHandlersByForms: (
    handlers: Record<string, TagHandler>,
    forms: ReadonlySet<TagForm>,
  ) => Record<string, TagHandler>,
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
  const tracker = options?.tracker
    ? (offsetTracker(options.tracker, baseOffset) ?? options.tracker)
    : (localOffsetTracker(localTracker, baseOffset) ?? localTracker);

  return { syntax, tagName, depthLimit, tracker };
};

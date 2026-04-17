import type { ParserBaseOptions, SourceSpan } from "./core.js";

// ── Structural parse types ──

/**
 * A node in the structural parse tree.
 *
 * Unlike {@link TextToken}, this preserves the tag form (inline / raw / block)
 * and accepts any syntactically valid tag without handler registration.
 */
export type StructuralNode =
  | { type: "text"; value: string; position?: SourceSpan }
  | { type: "escape"; raw: string; position?: SourceSpan }
  | { type: "separator"; position?: SourceSpan }
  | {
      type: "inline";
      tag: string;
      children: StructuralNode[];
      /**
       * True when this inline node comes from implicit inline shorthand (`name(...)`)
       * inside an inline-arg context.
       */
      implicitInlineShorthand?: boolean;
      position?: SourceSpan;
    }
  | { type: "raw"; tag: string; args: StructuralNode[]; content: string; position?: SourceSpan }
  | {
      type: "block";
      tag: string;
      args: StructuralNode[];
      children: StructuralNode[];
      position?: SourceSpan;
    };

/**
 * Options for {@link parseStructural}.
 *
 * Extends {@link ParserBaseOptions} — shares tag recognition, form gating,
 * syntax, and depth-limit config with {@link ParseOptions}.
 *
 * When `handlers` is provided, gating rules are identical to `parseRichText`.
 * When omitted, all tags and forms are accepted.
 */
export interface StructuralParseOptions extends ParserBaseOptions {
  /** When true, attach source position info (`position`) to every StructuralNode. Default: false. */
  trackPositions?: boolean;
}

// ── Zone types ──

/**
 * A contiguous group of top-level structural nodes.
 *
 * Adjacent text / escape / separator / inline nodes merge into one zone.
 * Each top-level raw or block node gets a dedicated zone.
 *
 * Built by {@link buildZones}.
 */
export interface Zone {
  /** Start offset in the source text (inclusive). */
  startOffset: number;
  /** End offset in the source text (exclusive). */
  endOffset: number;
  /** The structural nodes belonging to this zone. */
  nodes: StructuralNode[];
}

import type { ParserBaseOptions, SourceSpan } from "./core.js";

// ── Structural parse types ──

/**
 * A node in the structural parse tree.
 *
 * Unlike {@link TextToken}, this preserves the tag form (inline / raw / block)
 * and accepts any syntactically valid tag without handler registration.
 */
export type StructuralNode =
  | {
      /** Plain text segment with no recognized tag structure. */
      type: "text";
      /** Text content exactly as preserved by structural parsing. */
      value: string;
      /** Optional source span when position tracking is enabled. */
      position?: SourceSpan;
    }
  | {
      /** Escaped syntax literal preserved as a dedicated node. */
      type: "escape";
      /** Raw escaped source content, including the escape sequence payload. */
      raw: string;
      /** Optional source span when position tracking is enabled. */
      position?: SourceSpan;
    }
  | {
      /** Separator token produced only inside structural arg parsing. */
      type: "separator";
      /** Optional source span when position tracking is enabled. */
      position?: SourceSpan;
    }
  | {
      /** Inline-form tag node. */
      type: "inline";
      /** Parsed tag name. */
      tag: string;
      /** Nested inline/body children. */
      children: StructuralNode[];
      /**
       * True when this inline node comes from implicit inline shorthand (`name(...)`)
       * inside an inline-arg context.
       */
      implicitInlineShorthand?: boolean;
      /** Optional source span when position tracking is enabled. */
      position?: SourceSpan;
    }
  | {
      /** Raw-form tag node. */
      type: "raw";
      /** Parsed tag name. */
      tag: string;
      /** Parsed structural arg nodes before the raw body. */
      args: StructuralNode[];
      /** Raw body content preserved as plain string. */
      content: string;
      /** Optional source span when position tracking is enabled. */
      position?: SourceSpan;
    }
  | {
      /** Block-form tag node. */
      type: "block";
      /** Parsed tag name. */
      tag: string;
      /** Parsed structural arg nodes before the block body. */
      args: StructuralNode[];
      /** Parsed structural children inside the block body. */
      children: StructuralNode[];
      /** Optional source span when position tracking is enabled. */
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

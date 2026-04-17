// ── Internal types (not re-exported from index) ──

/**
 * Buffered text/segment state while scanning structural frames.
 *
 * The scanner accumulates contiguous plain-text ranges and optional escaped
 * fragments before flushing them into structural nodes.
 */
export interface BufferState {
  /** Buffered range start in frame-local source. */
  start: number;
  /** Buffered range end in frame-local source. */
  end: number;
  /** Optional escaped-segment boundaries inside buffer. */
  segments: number[] | null;
}

/**
 * Parsed result for a complete tag-start token at the current cursor.
 *
 * Used by frame scanners after a tag head has already been recognized and the
 * parser needs the exact bounds of the argument section.
 */
export interface TagStartInfo {
  /** Parsed tag name. */
  tag: string;
  /** Cursor position of tag-open token. */
  tagOpenPos: number;
  /** End cursor of parsed tag-name span. */
  tagNameEnd: number;
  /** Start cursor of argument content. */
  argStart: number;
}

/**
 * Minimal tag-head info used by low-level scanner helpers.
 *
 * Compared with {@link TagStartInfo}, this is the lighter-weight shape used
 * before the full opening token has been validated.
 */
export interface TagHead {
  /** Parsed tag name. */
  tag: string;
  /** Cursor position where tag starts. */
  tagStart: number;
  /** End cursor of parsed tag-name span. */
  tagNameEnd: number;
  /** Start cursor of argument content. */
  argStart: number;
}

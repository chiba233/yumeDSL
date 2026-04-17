// ── Internal types (not re-exported from index) ──

/** Buffered text/segment state while scanning structural frames. */
export interface BufferState {
  /** Buffered range start in frame-local source. */
  start: number;
  /** Buffered range end in frame-local source. */
  end: number;
  /** Optional escaped-segment boundaries inside buffer. */
  segments: number[] | null;
}

/** Parsed result for a complete tag start token at cursor. */
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

/** Minimal tag head info used by scanner helpers. */
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

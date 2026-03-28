import type { ErrorCode, ParseError } from "./types.js";
import type { PositionTracker } from "./positions.js";

const ERROR_MESSAGES: Record<ErrorCode, string> = {
  DEPTH_LIMIT: "Nesting too deep",
  UNEXPECTED_CLOSE: "Unexpected close tag",
  BLOCK_NOT_CLOSED: "Block tag not closed",
  BLOCK_CLOSE_MALFORMED: "Malformed block close",
  RAW_NOT_CLOSED: "Raw block not closed",
  RAW_CLOSE_MALFORMED: "Malformed raw close",
  INLINE_NOT_CLOSED: "Inline tag not closed",
};

export const getErrorContext = (
  tracker: PositionTracker | null,
  text: string,
  index: number,
  length = 1,
  range = 15,
) => {
  let line: number;
  let column: number;

  if (tracker) {
    const pos = tracker.resolve(index);
    line = pos.line;
    column = pos.column;
  } else {
    line = 1;
    let lastLineStart = 0;
    for (let i = 0; i < index; i++) {
      if (text[i] === "\n") {
        line++;
        lastLineStart = i + 1;
      }
    }
    column = index - lastLineStart + 1;
  }

  const start = Math.max(0, index - range);
  const end = Math.min(text.length, index + length + range);

  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";

  const before = text.slice(start, index);
  const content = text.slice(index, index + length);
  const after = text.slice(index + length, end);

  const highlightedSnippet = `${prefix}${before} >>>${content}<<< ${after}${suffix}`;

  return {
    line,
    column,
    snippet: highlightedSnippet.replace(/\n/g, " "),
  };
};

export const emitError = (
  tracker: PositionTracker | null,
  onError: ((error: ParseError) => void) | undefined,
  code: ErrorCode,
  text: string,
  index: number,
  length?: number,
) => {
  if (!onError) return;

  const { line, column, snippet } = getErrorContext(tracker, text, index, length);
  const base = ERROR_MESSAGES[code] ?? code;
  const message = `(L${line}:C${column}) ${base}: ${snippet}`;

  try {
    onError({ code, message, line, column, snippet });
  } catch {}
};

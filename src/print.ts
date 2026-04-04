import type { StructuralNode, SyntaxInput } from "./types.js";
import { createSyntax } from "./syntax.js";

export interface PrintOptions {
  /** Override DSL syntax tokens. Must match the syntax used during parsing for round-trip fidelity. */
  syntax?: Partial<SyntaxInput>;
}

const printNodes = (nodes: StructuralNode[], s: SyntaxInput): string => {
  let out = "";

  for (const node of nodes) {
    if (node.type === "text") {
      out += node.value;
      continue;
    }

    if (node.type === "escape") {
      out += node.raw;
      continue;
    }

    if (node.type === "separator") {
      out += s.tagDivider;
      continue;
    }

    if (node.type === "inline") {
      out += s.tagPrefix + node.tag + s.tagOpen + printNodes(node.children, s) + s.endTag;
      continue;
    }

    if (node.type === "raw") {
      out +=
        s.tagPrefix +
        node.tag +
        s.tagOpen +
        printNodes(node.args, s) +
        s.rawOpen +
        node.content +
        s.rawClose;
      continue;
    }

    if (node.type === "block") {
      out +=
        s.tagPrefix +
        node.tag +
        s.tagOpen +
        printNodes(node.args, s) +
        s.blockOpen +
        printNodes(node.children, s) +
        s.blockClose;
    }
  }

  return out;
};

/**
 * Serialize a structural parse tree back to DSL source text.
 *
 * Always prints full tag syntax — no gating or validation is applied.
 * If the tree contains nodes whose form is not supported by the runtime parser,
 * they will be printed with full syntax and naturally degrade to plain text
 * when re-parsed.
 *
 * When the structural tree preserves the original syntax-relevant information
 * and the same syntax configuration is used, this can be used for round-trip
 * serialization of well-formed inputs.
 */
export const printStructural = (nodes: StructuralNode[], options?: PrintOptions): string => {
  const syntax = createSyntax(options?.syntax);
  return printNodes(nodes, syntax);
};

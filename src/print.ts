import type { StructuralNode, SyntaxInput } from "./types.js";
import { createSyntax } from "./syntax.js";

export interface PrintOptions {
  /** Override DSL syntax tokens. Must match the syntax used during parsing for round-trip fidelity. */
  syntax?: Partial<SyntaxInput>;
}

const printNodes = (nodes: StructuralNode[], s: SyntaxInput): string => {
  let out = "";

  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out += node.value;
        break;
      case "escape":
        out += node.raw;
        break;
      case "separator":
        out += s.tagDivider;
        break;
      case "inline":
        out += s.tagPrefix + node.tag + s.tagOpen + printNodes(node.children, s) + s.endTag;
        break;
      case "raw":
        out += s.tagPrefix + node.tag + s.tagOpen + printNodes(node.args, s) + s.rawOpen + node.content + s.rawClose;
        break;
      case "block":
        out += s.tagPrefix + node.tag + s.tagOpen + printNodes(node.args, s) + s.blockOpen + printNodes(node.children, s) + s.blockClose;
        break;
    }
  }

  return out;
};

/**
 * Serialize a structural parse tree back to DSL source text.
 *
 * When the structural tree preserves the original syntax-relevant information
 * and the same syntax configuration is used, this can be used for round-trip
 * serialization of well-formed inputs.
 */
export const printStructural = (
  nodes: StructuralNode[],
  options?: PrintOptions,
): string => {
  const syntax = createSyntax(options?.syntax);
  return printNodes(nodes, syntax);
};

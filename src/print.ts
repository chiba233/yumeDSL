import type { StructuralNode, SyntaxInput } from "./types.js";
import { createSyntax } from "./syntax.js";

export interface PrintOptions {
  /** Override DSL syntax tokens. Must match the syntax used during parsing for round-trip fidelity. */
  syntax?: Partial<SyntaxInput>;
}

type PrintTask =
  | { kind: "nodes"; nodes: StructuralNode[]; index: number; inInlineArgs: boolean }
  | { kind: "text"; value: string };

const printNodes = (nodes: StructuralNode[], s: SyntaxInput): string => {
  let out = "";
  const stack: PrintTask[] = [{ kind: "nodes", nodes, index: 0, inInlineArgs: false }];

  while (stack.length > 0) {
    const task = stack[stack.length - 1]!;

    if (task.kind === "text") {
      out += task.value;
      stack.pop();
      continue;
    } else if (task.index >= task.nodes.length) {
      stack.pop();
      continue;
    }

    const node = task.nodes[task.index++]!;

    if (node.type === "text") {
      out += node.value;
    } else if (node.type === "escape") {
      out += node.raw;
    } else if (node.type === "separator") {
      out += s.tagDivider;
    } else if (node.type === "inline") {
      const isImplicitShorthand = node.implicitInlineShorthand === true && task.inInlineArgs;
      stack.push({ kind: "text", value: isImplicitShorthand ? s.tagClose : s.endTag });
      stack.push({ kind: "nodes", nodes: node.children, index: 0, inInlineArgs: true });
      stack.push({
        kind: "text",
        value: (isImplicitShorthand ? "" : s.tagPrefix) + node.tag + s.tagOpen,
      });
    } else if (node.type === "raw") {
      stack.push({ kind: "text", value: s.rawClose });
      stack.push({ kind: "text", value: node.content });
      stack.push({ kind: "text", value: s.rawOpen });
      stack.push({ kind: "nodes", nodes: node.args, index: 0, inInlineArgs: true });
      stack.push({ kind: "text", value: s.tagPrefix + node.tag + s.tagOpen });
    } else if (node.type === "block") {
      stack.push({ kind: "text", value: s.blockClose });
      stack.push({ kind: "nodes", nodes: node.children, index: 0, inInlineArgs: false });
      stack.push({ kind: "text", value: s.blockOpen });
      stack.push({ kind: "nodes", nodes: node.args, index: 0, inInlineArgs: true });
      stack.push({ kind: "text", value: s.tagPrefix + node.tag + s.tagOpen });
    }
  }

  return out;
};

/**
 * Serialize a structural parse tree back to DSL source text.
 *
 * No gating or validation is applied.
 * Inline nodes marked with `implicitInlineShorthand: true` are serialized as
 * shorthand (`tag(...)` / `tag<...>` depending on syntax) only when they appear
 * in an inline-argument context; other nodes use full syntax.
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

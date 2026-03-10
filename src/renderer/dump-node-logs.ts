import type { FoldNode } from "../fold-node.ts";
import type { WriteStreamLike } from "./write-stream-like.ts";

export function dumpNodeLogs(node: FoldNode, output: WriteStreamLike): void {
  // Log lines through composedFlatMap, indented with 4 spaces
  for (const rawLine of node.logLines) {
    const mapped = node.composedFlatMap(rawLine);
    for (const line of mapped) {
      output.write(`    ${line}\n`);
    }
  }

  // Error + stack trace, indented with 4 spaces
  if (node.error) {
    if (node.error.stack) {
      for (const line of node.error.stack.split("\n")) {
        output.write(`    ${line}\n`);
      }
    } else {
      output.write(`    ${node.error.message}\n`);
    }
  }
}

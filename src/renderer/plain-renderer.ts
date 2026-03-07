import { formatDuration } from "../format.ts";
import {
  ancestorChain,
  countTasks,
  durationMillis,
  type TaskNode,
} from "../task-node.ts";
import type { Renderer } from "./renderer.ts";

/** Plain renderer — sequential text output for non-TTY environments. */
export function createPlainRenderer(
  output: { write(s: string): boolean },
): Renderer {
  let stopped = false;
  let root: TaskNode | undefined;

  /** Build the ancestor path prefix for a node, e.g. `[Root (C/N) > Child]`. */
  function prefix(node: TaskNode): string {
    const chain = ancestorChain(node);
    const parts: string[] = [];

    for (let i = 0; i < chain.length; i++) {
      const n = chain[i];
      // Title-less tasks omitted from ancestor path
      if (n.title === undefined) continue;

      let part = n.title;
      // Root task includes (C/N) progress count
      if (n.parent === undefined && root) {
        const { completed, total } = countTasks(root);
        part = `${part} (${completed}/${total})`;
      }
      parts.push(part);
    }

    return `[${parts.join(" > ")}]`;
  }

  return {
    onTaskStart(node: TaskNode): void {
      if (stopped) return;
      // Only show start for titled tasks
      if (node.title === undefined) return;
      output.write(`${prefix(node)} => started\n`);
    },

    onTaskEnd(node: TaskNode): void {
      if (stopped) return;
      // Only show end for titled tasks
      if (node.title === undefined) return;

      const ms = durationMillis(node);
      const duration = ms !== undefined ? formatDuration(ms) : "";

      switch (node.status) {
        case "success":
          output.write(`${prefix(node)} ✓ ${duration}\n`);
          break;
        case "warning":
          output.write(`${prefix(node)} ⚠ ${duration}\n`);
          break;
        case "fail":
          output.write(`${prefix(node)} ✗ ERROR  ${duration}\n`);
          // Dump full log on fail
          dumpFailLog(node, output);
          break;
        case "skipped":
          output.write(`${prefix(node)} ⊘ skipped\n`);
          break;
        default:
          break;
      }
    },

    onLog(node: TaskNode, line: string): void {
      if (stopped) return;
      // Find the nearest titled ancestor for the prefix
      const prefixNode = node.title !== undefined ? node : findTitledAncestor(
        node,
      );
      if (prefixNode) {
        // Apply composedFlatMap to the line
        const mapped = node.composedFlatMap(line);
        for (const mappedLine of mapped) {
          output.write(`${prefix(prefixNode)} ${mappedLine}\n`);
        }
      }
    },

    start(rootNode: TaskNode): void {
      if (stopped) return;
      root = rootNode;
    },

    stop(): void {
      if (stopped) return;
      stopped = true;
    },
  };
}

/** Find the nearest titled ancestor (including self). */
function findTitledAncestor(node: TaskNode): TaskNode | undefined {
  let current: TaskNode | undefined = node;
  while (current) {
    if (current.title !== undefined) return current;
    current = current.parent;
  }
  return undefined;
}

/** Dump full log for a failed task. */
function dumpFailLog(
  node: TaskNode,
  output: { write(s: string): boolean },
): void {
  // Only dump for leaf failures (no failed children)
  const hasFailedChild = node.children.some((c) => c.status === "fail");
  if (hasFailedChild) return;

  // Log lines through composedFlatMap
  for (const rawLine of node.logLines) {
    const mapped = node.composedFlatMap(rawLine);
    for (const line of mapped) {
      output.write(`    ${line}\n`);
    }
  }

  // Error + stack trace
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

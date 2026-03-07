import { formatDuration } from "../format.ts";
import {
  ancestorChain,
  countTasks,
  durationMillis,
  type TaskNode,
} from "../task-node.ts";
import { dumpNodeLogs } from "./dump-node-logs.ts";
import type { Renderer } from "./renderer.ts";
import type { WriteStreamLike } from "./write-stream-like.ts";

/** Plain renderer — sequential text output for non-TTY environments. */
export function createPlainRenderer(
  output: WriteStreamLike,
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
      if (n.title === undefined) {
        continue;
      }

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
      if (stopped) {
        return;
      }
      // Only show start for titled tasks
      if (node.title === undefined) {
        return;
      }
      output.write(`${prefix(node)} => started\n`);
    },

    onTaskEnd(node: TaskNode): void {
      if (stopped) {
        return;
      }
      // Only show end for titled tasks
      if (node.title === undefined) {
        return;
      }

      const ms = durationMillis(node);
      const duration = ms ? formatDuration(ms) : "";

      if (node.status === "success") {
        output.write(`${prefix(node)} ✓ ${duration}\n`);
        return;
      }
      if (node.status === "warning") {
        output.write(`${prefix(node)} ⚠ ${duration}\n`);
        return;
      }

      if (node.status === "fail") {
        output.write(`${prefix(node)} ✗ ERROR  ${duration}\n`);
        // Dump full log on fail
        dumpFailLog(node, output);
        return;
      }

      if (node.status === "skipped") {
        output.write(`${prefix(node)} ⊘ skipped\n`);
        return;
      }
    },

    onLog(node: TaskNode, line: string): void {
      if (stopped) {
        return;
      }
      // Find the nearest titled ancestor for the prefix
      const prefixNode = node.title ? node : findTitledAncestor(node);
      if (prefixNode) {
        // Apply composedFlatMap to the line
        const mapped = node.composedFlatMap(line);
        for (const mappedLine of mapped) {
          output.write(`${prefix(prefixNode)} ${mappedLine}\n`);
        }
      }
    },

    start(rootNode: TaskNode): void {
      if (stopped) {
        return;
      }
      root = rootNode;
    },

    stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
    },
  };
}

/** Find the nearest titled ancestor (including self). */
function findTitledAncestor(node: TaskNode): TaskNode | undefined {
  let current: TaskNode | undefined = node;
  while (current) {
    if (current.title !== undefined) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

/** Dump full log for a failed task. */
function dumpFailLog(
  node: TaskNode,
  output: WriteStreamLike,
): void {
  // Only dump for leaf failures (no failed children)
  const hasFailedChild = node.children.some((c) => c.status === "fail");
  if (hasFailedChild) {
    return;
  }

  // Log lines through composedFlatMap
  dumpNodeLogs(node, output);
}

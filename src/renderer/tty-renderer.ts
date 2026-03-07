import type { WriteStream } from "node:tty";
import { hideCursor, showCursor } from "../ansi.ts";
import { formatDuration } from "../format.ts";
import {
  ancestorChain,
  durationMillis,
  type TaskNode,
  walkTree,
} from "../task-node.ts";
import { computeFrame } from "./compute-frame.ts";
import type { Renderer } from "./renderer.ts";

/** TTY renderer — frame-based re-render using node:tty WriteStream methods. */
export function createTtyRenderer(
  output: WriteStream,
  tickInterval = 150,
): Renderer {
  let stopped = false;
  let root: TaskNode | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let previousLineCount = 0;
  const displayCounts = new WeakMap<TaskNode, number>();

  function render(): void {
    if (!root || stopped) return;

    const termWidth = output.columns || 80;
    const termHeight = output.rows || 24;

    const frame = computeFrame(root, {
      termWidth,
      termHeight,
      displayCounts,
      now: Date.now(),
    });

    // Cursor strategy
    if (previousLineCount > 0) {
      output.moveCursor(0, -previousLineCount);
    }
    output.cursorTo(0);
    output.write(hideCursor);

    for (const line of frame.lines) {
      output.clearLine(0);
      output.write(line + "\n");
    }

    output.clearScreenDown();
    previousLineCount = frame.lines.length;
    output.write(showCursor);
  }

  function renderFinal(): void {
    if (!root) return;

    const termWidth = output.columns || 80;

    // Final frame with no height limit
    const frame = computeFrame(root, {
      termWidth,
      termHeight: Infinity,
      displayCounts,
      now: Date.now(),
    });

    // Overwrite the last frame
    if (previousLineCount > 0) {
      output.moveCursor(0, -previousLineCount);
    }
    output.cursorTo(0);
    output.write(hideCursor);

    for (const line of frame.lines) {
      output.clearLine(0);
      output.write(line + "\n");
    }

    output.clearScreenDown();
    output.write(showCursor);

    // Dump full logs for leaf failures
    dumpFailedLeafLogs(root, output, termWidth);
  }

  return {
    onTaskStart(_node: TaskNode): void {
      // TtyRenderer ignores — reads tree on tick
    },
    onTaskEnd(_node: TaskNode): void {
      // TtyRenderer ignores — reads tree on tick
    },
    onLog(_node: TaskNode, _line: string): void {
      // TtyRenderer ignores — reads tree on tick
    },
    start(rootNode: TaskNode): void {
      if (stopped) return;
      root = rootNode;
      timer = setInterval(render, tickInterval);
      // Unref so the timer doesn't keep the process alive
      if (
        typeof timer === "object" && timer !== null && "unref" in timer &&
        typeof (timer as Record<string, unknown>).unref === "function"
      ) {
        (timer as { unref(): void }).unref();
      }
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      renderFinal();
    },
  };
}

/** Find leaf failures (failed nodes with no failed children). */
function findLeafFailures(root: TaskNode): TaskNode[] {
  const leaves: TaskNode[] = [];
  for (const { node } of walkTree(root)) {
    if (node.status !== "fail") continue;
    const hasFailedChild = node.children.some((c) => c.status === "fail");
    if (!hasFailedChild) {
      leaves.push(node);
    }
  }
  return leaves;
}

/** Dump full logs for leaf failures. */
function dumpFailedLeafLogs(
  root: TaskNode,
  output: WriteStream,
  _termWidth: number,
): void {
  const failures = findLeafFailures(root);
  for (const node of failures) {
    // Ancestor chain path header
    const chain = ancestorChain(node);
    const pathParts = chain.map((n) => n.title ?? "<unnamed task>");
    const header = `--- Failed: ${pathParts.join(" > ")} ---`;
    output.write("\n" + header + "\n");

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

    // Duration if available
    const ms = durationMillis(node);
    if (ms !== undefined) {
      output.write(`    Duration: ${formatDuration(ms)}\n`);
    }
  }
}

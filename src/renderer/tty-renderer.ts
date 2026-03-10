import type { WriteStream } from "node:tty";
import { hideCursor, showCursor } from "../ansi.ts";
import { formatDuration } from "../format.ts";
import {
  ancestorChain,
  durationMillis,
  type FoldNode,
  walkTree,
} from "../fold-node.ts";
import { computeFrame, type Frame } from "./compute-frame.ts";
import { dumpNodeLogs } from "./dump-node-logs.ts";
import type { Renderer } from "./renderer.ts";

/** TTY renderer — frame-based re-render using node:tty WriteStream methods. */
export function createTtyRenderer(
  output: WriteStream,
  tickInterval = 150,
): Renderer {
  let stopped = false;
  let root: FoldNode | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let previousLineCount = 0;
  const displayCounts = new WeakMap<FoldNode, number>();

  function render(): void {
    if (!root || stopped) {
      return;
    }

    const frame = computeFrame(
      root,
      {
        termWidth: output.columns || 80,
        termHeight: output.rows || 24,
        displayCounts,
        now: Date.now(),
      },
    );

    writeFrame(previousLineCount, output, frame);
    previousLineCount = frame.lines.length;
  }

  function renderFinal(): void {
    if (!root) {
      return;
    }

    // Final frame with no height limit
    const frame = computeFrame(
      root,
      {
        termWidth: output.columns || 80,
        termHeight: Infinity,
        displayCounts,
        now: Date.now(),
      },
    );

    // Overwrite the last frame
    writeFrame(previousLineCount, output, frame);

    // Dump full logs for leaf failures
    dumpFailedLeafLogs(root, output, output.columns || 80);
  }

  return {
    onFoldStart(_node: FoldNode): void {
      // TtyRenderer ignores — reads tree on tick
    },
    onFoldEnd(_node: FoldNode): void {
      // TtyRenderer ignores — reads tree on tick
    },
    onLog(_node: FoldNode, _line: string): void {
      // TtyRenderer ignores — reads tree on tick
    },
    start(rootNode: FoldNode): void {
      if (stopped) {
        return;
      }
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
      if (stopped) {
        return;
      }
      stopped = true;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      renderFinal();
    },
  };
}

function writeFrame(
  previousLineCount: number,
  output: WriteStream,
  frame: Frame,
): void {
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
}

/** Find leaf failures (failed nodes with no failed children). */
function findLeafFailures(root: FoldNode): FoldNode[] {
  const leaves: FoldNode[] = [];
  for (const { node } of walkTree(root)) {
    if (node.status !== "fail") {
      continue;
    }
    const hasFailedChild = node.children.some((c) => c.status === "fail");
    if (!hasFailedChild) {
      leaves.push(node);
    }
  }
  return leaves;
}

/** Dump full logs for leaf failures. */
function dumpFailedLeafLogs(
  root: FoldNode,
  output: WriteStream,
  _termWidth: number,
): void {
  const failures = findLeafFailures(root);
  for (const node of failures) {
    // Ancestor chain path header
    const chain = ancestorChain(node);
    const pathParts = chain.map((n) => n.title ?? "<unnamed fold>");
    const header = `--- Failed: ${pathParts.join(" > ")} ---`;
    output.write("\n" + header + "\n");
    dumpNodeLogs(node, output);

    // Duration if available
    const ms = durationMillis(node);
    if (ms !== undefined) {
      output.write(`    Duration: ${formatDuration(ms)}\n`);
    }
  }
}

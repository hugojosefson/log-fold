import type { FoldNode } from "../fold-node.ts";

/** Renderer interface for fold tree display. */
export type Renderer = {
  /** Called when a fold starts. TtyRenderer ignores this (reads tree on tick).
   *  PlainRenderer writes a start line immediately. */
  onFoldStart(node: FoldNode): void;
  /** Called when a fold completes (success or fail). TtyRenderer ignores this
   *  (reads tree on tick). PlainRenderer writes an end line immediately. */
  onFoldEnd(node: FoldNode): void;
  /** Called when a log line is appended to a fold. TtyRenderer ignores this
   *  (reads tree on tick). PlainRenderer writes the line immediately. */
  onLog(node: FoldNode, line: string): void;
  /** Start the render loop (TtyRenderer starts tick interval). */
  start(root: FoldNode): void;
  /** Stop the render loop, render final state, dump error logs. */
  stop(): void;
};

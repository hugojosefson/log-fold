import type { TaskNode } from "../task-node.ts";

/** Renderer interface for task tree display. */
export type Renderer = {
  /** Called when a task starts. TtyRenderer ignores this (reads tree on tick).
   *  PlainRenderer writes a start line immediately. */
  onTaskStart(node: TaskNode): void;
  /** Called when a task completes (success or fail). TtyRenderer ignores this
   *  (reads tree on tick). PlainRenderer writes an end line immediately. */
  onTaskEnd(node: TaskNode): void;
  /** Called when a log line is appended to a task. TtyRenderer ignores this
   *  (reads tree on tick). PlainRenderer writes the line immediately. */
  onLog(node: TaskNode, line: string): void;
  /** Start the render loop (TtyRenderer starts tick interval). */
  start(root: TaskNode): void;
  /** Stop the render loop, render final state, dump error logs. */
  stop(): void;
};

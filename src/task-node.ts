/**
 * TaskNode — the core data model for a task tree.
 *
 * Each node represents one task that can have children (sub-tasks).
 * The innermost running task accumulates log lines from its process output.
 */

/** Status of a task through its lifecycle. */
export type TaskStatus = "pending" | "running" | "success" | "fail";

/** A node in the task tree. */
export interface TaskNode {
  readonly id: string;
  readonly title: string;
  status: TaskStatus;
  readonly parent: TaskNode | undefined;
  readonly children: TaskNode[];

  /** Full log buffer — kept so we can dump it on error. */
  readonly logLines: string[];

  /** Error that caused failure, if any. */
  error: Error | undefined;

  /** Timestamps for duration calculation. */
  startedAt: number | undefined;
  finishedAt: number | undefined;
}

let nextId = 0;

/** Create a new task node. */
export function createTaskNode(
  title: string,
  parent?: TaskNode,
): TaskNode {
  const node: TaskNode = {
    id: `task-${nextId++}`,
    title,
    status: "pending",
    parent,
    children: [],
    logLines: [],
    error: undefined,
    startedAt: undefined,
    finishedAt: undefined,
  };
  if (parent) {
    parent.children.push(node);
  }
  return node;
}

/** Mark a task as running. */
export function startTask(node: TaskNode): void {
  node.status = "running";
  node.startedAt = Date.now();
}

/** Mark a task as successfully completed. */
export function succeedTask(node: TaskNode): void {
  node.status = "success";
  node.finishedAt = Date.now();
}

/** Mark a task as failed. */
export function failTask(node: TaskNode, error?: Error): void {
  node.status = "fail";
  node.error = error;
  node.finishedAt = Date.now();
}

/** Append a log line to the task's buffer. */
export function appendLog(node: TaskNode, line: string): void {
  node.logLines.push(line);
}

/** Append multiple log lines (e.g. from splitting a chunk on newlines). */
export function appendLogLines(node: TaskNode, text: string): void {
  const lines = text.split("\n");
  // If text ends with \n, the split produces a trailing empty string — skip it.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  for (const line of lines) {
    node.logLines.push(line);
  }
}

/** Get the last `n` log lines (the "tail window"). */
export function tailLogLines(node: TaskNode, n: number): string[] {
  return node.logLines.slice(-n);
}

/** Duration in seconds, or undefined if not started. */
export function durationSec(node: TaskNode): number | undefined {
  if (node.startedAt === undefined) return undefined;
  const end = node.finishedAt ?? Date.now();
  return (end - node.startedAt) / 1000;
}

/** Walk the tree depth-first, yielding each node and its depth. */
export function* walkTree(
  roots: TaskNode[],
  depth = 0,
): Generator<{ node: TaskNode; depth: number }> {
  for (const node of roots) {
    yield { node, depth };
    yield* walkTree(node.children, depth + 1);
  }
}

/**
 * Find the deepest currently-running node in a tree.
 * This is the "innermost active task" whose log tail we display.
 */
export function findDeepestRunning(
  roots: TaskNode[],
): TaskNode | undefined {
  let deepest: TaskNode | undefined;
  let maxDepth = -1;
  for (const { node, depth } of walkTree(roots)) {
    if (node.status === "running" && depth > maxDepth) {
      deepest = node;
      maxDepth = depth;
    }
  }
  return deepest;
}

/**
 * Get the chain of ancestors from root down to the given node (inclusive).
 */
export function ancestorChain(node: TaskNode): TaskNode[] {
  const chain: TaskNode[] = [];
  let current: TaskNode | undefined = node;
  while (current) {
    chain.unshift(current);
    current = current.parent;
  }
  return chain;
}

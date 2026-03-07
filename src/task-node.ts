/**
 * TaskNode — the core data model for a task tree.
 *
 * Each node represents one task that can have children (sub-tasks).
 * Running leaf tasks accumulate log lines from their process output.
 */

/** Spinner definition compatible with `cli-spinners` by sindresorhus. */
export type Spinner = {
  /** Frame interval in milliseconds. */
  interval: number;
  /** Animation frames, cycled on each render tick. */
  frames: string[];
};

/** Options for configuring a task's display behavior. */
export type TaskOptions = {
  /** Number of log tail lines to show. Child tasks inherit from the nearest ancestor that sets this. */
  tailLines?: number;
  /** Spinner for this running task. Child tasks inherit from the nearest ancestor that sets this. */
  spinner?: Spinner;
  /** Transform each log line before display and in error dumps. */
  map?: (line: string) => string;
  /** Filter log lines at display time and in error dumps. Return true to show, false to hide. */
  filter?: (line: string) => boolean;
};

export const TASK_OPTIONS_KEYS: (keyof TaskOptions)[] = [
  "tailLines",
  "spinner",
  "map",
  "filter",
];

/** Status of a task through its lifecycle. */
export type TaskStatus =
  | "pending"
  | "running"
  | "success"
  | "warning"
  | "fail"
  | "skipped";

/** A node in the task tree. */
export type TaskNode = {
  /** Display title — undefined means structural-only (not rendered, children appear at parent's depth). */
  title: string | undefined;
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

  /** Number of tail lines to show. Resolved at creation time from nearest ancestor. */
  readonly tailLines: number;

  /** Spinner for running state. Resolved at creation time from nearest ancestor. */
  readonly spinner: Spinner;

  /**
   * Composed map/filter chain for display.
   * Local map → local filter → parent's composedFlatMap.
   * Identity `(line) => [line]` when no map/filter on this task or any ancestor.
   */
  readonly composedFlatMap: (line: string) => string[];
};

const DEFAULT_TAIL_LINES = 6;

const DEFAULT_SPINNER: Spinner = {
  interval: 80,
  frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

/** Identity flatMap — passes every line through unchanged. */
const identityFlatMap = (line: string): string[] => [line];

/** Create a new task node, appending to parent's children if given. */
export function createTaskNode(
  title?: string,
  parent?: TaskNode,
  options?: TaskOptions,
): TaskNode {
  // Resolve tailLines: explicit option > nearest ancestor > default
  const tailLines = options?.tailLines ??
    parent?.tailLines ??
    DEFAULT_TAIL_LINES;

  // Resolve spinner: explicit option > nearest ancestor > default
  const spinner = options?.spinner ??
    parent?.spinner ??
    DEFAULT_SPINNER;

  // Compose map/filter into composedFlatMap
  const parentFlatMap = parent?.composedFlatMap ?? identityFlatMap;
  const localMap = options?.map;
  const localFilter = options?.filter;

  let composedFlatMap: (line: string) => string[];
  if (localMap && localFilter) {
    composedFlatMap = (line: string): string[] => {
      const mapped = localMap(line);
      if (!localFilter(mapped)) {
        return [];
      }
      return parentFlatMap(mapped);
    };
  } else if (localMap) {
    composedFlatMap = (line: string): string[] => {
      return parentFlatMap(localMap(line));
    };
  } else if (localFilter) {
    composedFlatMap = (line: string): string[] => {
      if (!localFilter(line)) {
        return [];
      }
      return parentFlatMap(line);
    };
  } else {
    composedFlatMap = parentFlatMap;
  }

  const node: TaskNode = {
    title,
    status: "pending",
    parent,
    children: [],
    logLines: [],
    error: undefined,
    startedAt: undefined,
    finishedAt: undefined,
    tailLines,
    spinner,
    composedFlatMap,
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

/** Update the node's display title in-place. */
export function setTitle(node: TaskNode, title: string): void {
  node.title = title;
}

/** Push a single line to the task's log buffer. */
export function appendLog(node: TaskNode, line: string): void {
  node.logLines.push(line);
}

/** Get the last `n` log lines (the "tail window"). */
export function tailLogLines(node: TaskNode, n: number): string[] {
  return node.logLines.slice(-n);
}

/**
 * Duration in milliseconds.
 * Returns elapsed ms for running/completed tasks, undefined for pending.
 */
export function durationMillis(node: TaskNode): number | undefined {
  if (node.startedAt === undefined) {
    return undefined;
  }
  const end = node.finishedAt ?? Date.now();
  return end - node.startedAt;
}

/** Walk the tree depth-first, yielding each node and its depth. */
export function* walkTree(
  root: TaskNode,
  depth = 0,
): Generator<{ node: TaskNode; depth: number }> {
  yield { node: root, depth };
  for (const child of root.children) {
    yield* walkTree(child, depth + 1);
  }
}

/** Find all currently-running leaf nodes (no running children). */
export function findRunningLeaves(root: TaskNode): TaskNode[] {
  const leaves: TaskNode[] = [];
  for (const { node } of walkTree(root)) {
    if (node.status !== "running") {
      continue;
    }
    const hasRunningChild = node.children.some((c) => c.status === "running");
    if (!hasRunningChild) {
      leaves.push(node);
    }
  }
  return leaves;
}

export type TasksProgress = { total: number; completed: number };

/**
 * Count total tasks and completed tasks in the tree.
 * Title-less (structural-only) tasks are excluded from counts.
 * "Completed" = any terminal status: success, warning, fail, or skipped.
 */
export function countTasks(
  root: TaskNode,
): TasksProgress {
  let total = 0;
  let completed = 0;
  for (const { node } of walkTree(root)) {
    if (node.title === undefined) {
      continue;
    }
    total++;
    if (
      node.status === "success" || node.status === "warning" ||
      node.status === "fail" || node.status === "skipped"
    ) {
      completed++;
    }
  }
  return { total, completed };
}

/** Total bytes of log output for a node. */
export function logBytes(node: TaskNode): number {
  return node.logLines
    .map((line) => line.length)
    .reduce((a: number, b: number) => a + b, 0);
}

/** Get the chain of ancestors from root down to the given node (inclusive). */
export function ancestorChain(node: TaskNode): TaskNode[] {
  const chain: TaskNode[] = [];
  let current: TaskNode | undefined = node;
  while (current) {
    chain.unshift(current);
    current = current.parent;
  }
  return chain;
}

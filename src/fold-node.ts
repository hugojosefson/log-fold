import cliSpinners from "cli-spinners";

/**
 * FoldNode — the core data model for a fold tree.
 *
 * Each node represents one fold that can have children (nested folds).
 * Running leaf folds accumulate log lines from their process output.
 */

/** Spinner definition compatible with `cli-spinners` by sindresorhus. */
export type Spinner = {
  /** Frame interval in milliseconds. */
  interval: number;
  /** Animation frames, cycled on each render tick. */
  frames: string[];
};

/** Options for configuring a fold's display behavior. */
export type FoldOptions = {
  /** Number of log tail lines to show. Child folds inherit from the nearest ancestor that sets this. */
  tailLines?: number;
  /** Spinner for this running fold. Child folds inherit from the nearest ancestor that sets this. */
  spinner?: Spinner;
  /** Transform each log line before display and in error dumps. */
  map?: (line: string) => string;
  /** Filter log lines at display time and in error dumps. Return true to show, false to hide. */
  filter?: (line: string) => boolean;
};

export const FOLD_OPTIONS_KEYS: (keyof FoldOptions)[] = [
  "tailLines",
  "spinner",
  "map",
  "filter",
];

/** Status of a fold through its lifecycle. */
export type FoldStatus =
  | "pending"
  | "running"
  | "success"
  | "warning"
  | "fail"
  | "skipped";

/** A node in the fold tree. */
export type FoldNode = {
  /** Display title — undefined means structural-only (not rendered, children appear at parent's depth). */
  title: string | undefined;
  status: FoldStatus;
  readonly parent: FoldNode | undefined;
  readonly children: FoldNode[];

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
   * Identity `(line) => [line]` when no map/filter on this fold or any ancestor.
   */
  readonly composedFlatMap: (line: string) => string[];
};

const DEFAULT_TAIL_LINES = 6;

const DEFAULT_SPINNER: Spinner = cliSpinners.dots;

/** Identity flatMap — passes every line through unchanged. */
const identityFlatMap = (line: string): string[] => [line];

/** Create a new fold node, appending to parent's children if given. */
export function createFoldNode(
  title?: string,
  parent?: FoldNode,
  options?: FoldOptions,
): FoldNode {
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

  const node: FoldNode = {
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

/** Set this fold's status to running. */
export function startFold(node: FoldNode): void {
  node.status = "running";
  node.startedAt = Date.now();
}

/** Set this fold's status to succeeded. */
export function succeedFold(node: FoldNode): void {
  node.status = "success";
  node.finishedAt = Date.now();
}

/** Set this fold's status to failed. */
export function failFold(node: FoldNode, error?: Error): void {
  node.status = "fail";
  node.error = error;
  node.finishedAt = Date.now();
}

/** Update the node's display title in-place. */
export function setTitle(node: FoldNode, title: string): void {
  node.title = title;
}

/** Push a single line to the fold's log buffer. */
export function appendLog(node: FoldNode, line: string): void {
  node.logLines.push(line);
}

/** Get the last `n` log lines (the "tail window"). */
export function tailLogLines(node: FoldNode, n: number): string[] {
  return node.logLines.slice(-n);
}

/**
 * Duration in milliseconds.
 * Returns elapsed ms for running/completed folds, undefined for pending.
 */
export function durationMillis(node: FoldNode): number | undefined {
  if (node.startedAt === undefined) {
    return undefined;
  }
  const end = node.finishedAt ?? Date.now();
  return end - node.startedAt;
}

/** Walk the tree depth-first, yielding each node and its depth. */
export function* walkTree(
  root: FoldNode,
  depth = 0,
): Generator<{ node: FoldNode; depth: number }> {
  yield { node: root, depth };
  for (const child of root.children) {
    yield* walkTree(child, depth + 1);
  }
}

/** Find all currently-running leaf nodes (no running children). */
export function findRunningLeaves(root: FoldNode): FoldNode[] {
  const leaves: FoldNode[] = [];
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

export type FoldsProgress = { total: number; completed: number };

/**
 * Count total folds and completed folds in the tree.
 * Title-less (structural-only) folds are excluded from counts.
 * "Completed" = any terminal status: success, warning, fail, or skipped.
 */
export function countFolds(
  root: FoldNode,
): FoldsProgress {
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
export function logBytes(node: FoldNode): number {
  return node.logLines
    .map((line) => line.length)
    .reduce((a: number, b: number) => a + b, 0);
}

/** Get the chain of ancestors from root down to the given node (inclusive). */
export function ancestorChain(node: FoldNode): FoldNode[] {
  const chain: FoldNode[] = [];
  let current: FoldNode | undefined = node;
  while (current) {
    chain.unshift(current);
    current = current.parent;
  }
  return chain;
}

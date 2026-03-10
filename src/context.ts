import process from "node:process";
import {
  Session,
  SESSION_OPTIONS_KEYS,
  type SessionOptions,
} from "./session.ts";
import { storage } from "./storage.ts";
import {
  appendLog,
  createTaskNode,
  failTask,
  setTitle,
  startTask,
  succeedTask,
  TASK_OPTIONS_KEYS,
  type TaskNode,
  type TaskOptions,
} from "./task-node.ts";

/** Shared run-and-finalize logic for both top-level and nested tasks. */
async function runTask<T, A extends unknown[] = unknown[]>(
  node: TaskNode,
  session: Session,
  fn: (...args: A) => T | Promise<T>,
  options?: { stopRenderer?: boolean },
): Promise<T> {
  startTask(node);
  session.renderer.onTaskStart(node);

  try {
    const result = await storage.run(
      { session, node },
      (...args: A) => Promise.resolve(fn(...args)),
    );
    if (node.status === "running") {
      succeedTask(node);
    }
    return result;
  } catch (e) {
    failTask(node, e instanceof Error ? e : new Error(String(e)));
    throw e;
  } finally {
    if (node.finishedAt === undefined) {
      node.finishedAt = Date.now();
    }
    session.renderer.onTaskEnd(node);
    if (options?.stopRenderer) {
      session.renderer.stop();
    }
  }
}

/**
 * Create and run a task. If called inside an existing task, nests as a child.
 * If called at the top level (no active context), auto-initializes a session
 * with default options.
 */
export function logTask<T, A extends unknown[] = unknown[]>(
  fn: (...args: A) => T | Promise<T>,
): Promise<T>;
export function logTask<T, A extends unknown[] = unknown[]>(
  options: TaskOptions,
  fn: (...args: A) => T | Promise<T>,
): Promise<T>;
export function logTask<T, A extends unknown[] = unknown[]>(
  options: SessionOptions & TaskOptions,
  fn: (...args: A) => T | Promise<T>,
): Promise<T>;
export function logTask<T, A extends unknown[] = unknown[]>(
  title: string | undefined,
  fn: (...args: A) => T | Promise<T>,
): Promise<T>;
export function logTask<T, A extends unknown[] = unknown[]>(
  title: string | undefined,
  options: TaskOptions,
  fn: (...args: A) => T | Promise<T>,
): Promise<T>;
export function logTask<T, A extends unknown[] = unknown[]>(
  title: string | undefined,
  options: SessionOptions & TaskOptions,
  fn: (...args: A) => T | Promise<T>,
): Promise<T>;

export function logTask<T, A extends unknown[] = unknown[]>(
  titleOrFnOrOptions:
    | string
    | undefined
    | ((...args: A) => T | Promise<T>)
    | (SessionOptions & TaskOptions),
  fnOrOptions?:
    | ((...args: A) => T | Promise<T>)
    | TaskOptions
    | (SessionOptions & TaskOptions),
  maybeFn?: (...args: A) => T | Promise<T>,
): Promise<T> {
  const { title, options, fn } = resolveLogTaskArgs(
    titleOrFnOrOptions,
    fnOrOptions,
    maybeFn,
  );

  const store = storage.getStore();

  if (!store) {
    // Top-level call — auto-init a session with defaults (or provided options)
    const session = new Session(
      options as SessionOptions | undefined,
    );
    const root = createTaskNode(
      title,
      undefined,
      options as TaskOptions | undefined,
    );
    session.root = root;
    session.renderer.start(session.root);
    return runTask(root, session, fn, { stopRenderer: true });
  }

  if (options) {
    const hasSessionOptions = SESSION_OPTIONS_KEYS.some((k) => k in options);
    if (hasSessionOptions) {
      throw new Error(
        `Session options (${SESSION_OPTIONS_KEYS.join(", ")}) are only ` +
          `allowed at the top level${
            title ? ` (in logTask("${title}"))` : ""
          }. ` +
          `Nested logTask() calls inherit the session ` +
          `from their parent. Per-task options (${
            TASK_OPTIONS_KEYS.join(", ")
          }) ` +
          `are allowed at any level.`,
      );
    }
  }

  // Nested call — create child under current context
  const { session, node: parent } = store;
  const child = createTaskNode(
    title,
    parent,
    options as TaskOptions | undefined,
  );
  return runTask(child, session, fn);
}

function resolveLogTaskArgs<T>(
  titleOrFnOrOptions:
    | string
    | undefined
    | (() => T | Promise<T>)
    | (SessionOptions & TaskOptions),
  fnOrOptions?:
    | (() => T | Promise<T>)
    | TaskOptions
    | (SessionOptions & TaskOptions),
  maybeFn?: () => T | Promise<T>,
): {
  title: string | undefined;
  options: Record<string, unknown> | undefined;
  fn: () => T | Promise<T>;
} {
  if (typeof titleOrFnOrOptions === "function") {
    // logTask(fn)
    return { title: undefined, options: undefined, fn: titleOrFnOrOptions };
  }

  if (
    typeof titleOrFnOrOptions === "object" &&
    titleOrFnOrOptions !== null
  ) {
    // logTask(options, fn)
    return {
      title: undefined,
      options: titleOrFnOrOptions,
      fn: fnOrOptions as () => T | Promise<T>,
    };
  }

  // logTask(title, ...) — title is string | undefined
  const title = titleOrFnOrOptions;
  if (typeof fnOrOptions === "function") {
    // logTask(title, fn)
    return { title, options: undefined, fn: fnOrOptions };
  }

  // logTask(title, options, fn)
  return {
    title,
    options: fnOrOptions as Record<string, unknown> | undefined,
    fn: maybeFn as () => T | Promise<T>,
  };
}

/**
 * Append log output to the current task. Splits on newlines — multi-line
 * strings produce multiple log entries. Strips trailing \r from each line.
 *
 * If called outside any task context, falls back to process.stderr.write(line + "\n").
 * If LOG_FOLD_STRICT env var is set, throws instead.
 */
export function log(text: string): void {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const store = storage.getStore();

  if (!store || !store.node) {
    // Outside any task context
    if (process.env.LOG_FOLD_STRICT) {
      throw new Error(
        "log() called outside a logTask() context. " +
          "Wrap your code in a logTask() call, or unset the LOG_FOLD_STRICT environment variable.",
      );
    }
    // Fall back to stderr
    for (const line of lines) {
      process.stderr.write(line + "\n");
    }
    return;
  }

  const { session, node } = store;
  for (const line of lines) {
    appendLog(node, line);
    session.renderer.onLog(node, line);
  }
}

/**
 * Mark the current task as completed with warnings.
 * Sets status to "warning" without setting finishedAt.
 */
export function setCurrentTaskWarning(): void {
  const store = storage.getStore();
  if (!store?.node) {
    throw new Error(
      "setCurrentTaskWarning() called outside a logTask() context.",
    );
  }
  store.node.status = "warning";
}

/**
 * Mark the current task as skipped.
 * Sets status to "skipped" without setting finishedAt.
 */
export function setCurrentTaskSkipped(): void {
  const store = storage.getStore();
  if (!store?.node) {
    throw new Error(
      "setCurrentTaskSkipped() called outside a logTask() context.",
    );
  }
  store.node.status = "skipped";
}

/**
 * Update the current task's display title.
 * The renderer picks up the change on the next tick.
 */
export function setCurrentTaskTitle(title: string): void {
  const store = storage.getStore();
  if (!store?.node) {
    throw new Error(
      "setCurrentTaskTitle() called outside a logTask() context.",
    );
  }
  setTitle(store.node, title);
}

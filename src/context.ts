import process from "node:process";
import { Session, type SessionOptions } from "./session.ts";
import { storage } from "./storage.ts";
import {
  appendLog,
  createTaskNode,
  failTask,
  setTitle,
  startTask,
  succeedTask,
  type TaskNode,
  type TaskOptions,
} from "./task-node.ts";

/** Creates a disposable handle that finalizes a task node on dispose. */
function taskHandle(
  node: TaskNode,
  session: Session,
  options?: { stopRenderer?: boolean },
): AsyncDisposable {
  return {
    [Symbol.asyncDispose]() {
      if (node.finishedAt === undefined) {
        node.finishedAt = Date.now();
      }
      session.renderer.onTaskEnd(node);
      if (options?.stopRenderer) {
        session.renderer.stop();
      }
      return Promise.resolve();
    },
  };
}

/**
 * Create and run a task. If called inside an existing task, nests as a child.
 * If called at the top level (no active context), auto-initializes a session
 * with default options.
 */
export async function logTask<T>(
  fn: () => T | Promise<T>,
): Promise<T>;
export async function logTask<T>(
  options: TaskOptions,
  fn: () => T | Promise<T>,
): Promise<T>;
export async function logTask<T>(
  options: SessionOptions & TaskOptions,
  fn: () => T | Promise<T>,
): Promise<T>;
export async function logTask<T>(
  title: string | undefined,
  fn: () => T | Promise<T>,
): Promise<T>;
export async function logTask<T>(
  title: string | undefined,
  options: TaskOptions,
  fn: () => T | Promise<T>,
): Promise<T>;
export async function logTask<T>(
  title: string | undefined,
  options: SessionOptions & TaskOptions,
  fn: () => T | Promise<T>,
): Promise<T>;

export async function logTask<T>(
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
): Promise<T> {
  // Overload dispatch: resolve (title, options, fn)
  let title: string | undefined;
  let options: Record<string, unknown> | undefined;
  let fn: () => T | Promise<T>;

  if (typeof titleOrFnOrOptions === "function") {
    // logTask(fn)
    title = undefined;
    fn = titleOrFnOrOptions;
  } else if (
    typeof titleOrFnOrOptions === "object" &&
    titleOrFnOrOptions !== null
  ) {
    // logTask(options, fn)
    title = undefined;
    options = titleOrFnOrOptions as Record<string, unknown>;
    fn = fnOrOptions as () => T | Promise<T>;
  } else {
    // logTask(title, ...) — title is string | undefined
    title = titleOrFnOrOptions;
    if (typeof fnOrOptions === "function") {
      fn = fnOrOptions;
    } else {
      options = fnOrOptions as Record<string, unknown> | undefined;
      fn = maybeFn as () => T | Promise<T>;
    }
  }

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
    startTask(root);
    session.renderer.start(session.root);
    session.renderer.onTaskStart(root);

    await using _handle = taskHandle(root, session, { stopRenderer: true });
    try {
      const result = await storage.run(
        { session, node: root },
        () => Promise.resolve(fn()),
      );
      // Respect warn/skip set during execution
      if (root.status === "running") succeedTask(root);
      return result;
    } catch (e) {
      failTask(root, e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
    // _handle[Symbol.asyncDispose]() runs automatically:
    // sets finishedAt, calls onTaskEnd, stops renderer
  }

  if (options) {
    const sessionKeys = [
      "mode",
      "tickInterval",
      "output",
    ];
    const hasSessionOptions = sessionKeys.some((k) => k in options);
    if (hasSessionOptions) {
      throw new Error(
        `Session options (mode, tickInterval, output) are only ` +
          `allowed at the top level${
            title ? ` (in logTask("${title}"))` : ""
          }. ` +
          `Nested logTask() calls inherit the session ` +
          `from their parent. Per-task options (tailLines, spinner, map, filter) ` +
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
  startTask(child);
  session.renderer.onTaskStart(child);

  await using _handle = taskHandle(child, session);
  try {
    const result = await storage.run(
      { session, node: child },
      () => Promise.resolve(fn()),
    );
    // Respect warn/skip set during execution
    if (child.status === "running") succeedTask(child);
    return result;
  } catch (e) {
    failTask(child, e instanceof Error ? e : new Error(String(e)));
    throw e;
  }
  // _handle[Symbol.asyncDispose]() runs automatically:
  // sets finishedAt, calls onTaskEnd
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

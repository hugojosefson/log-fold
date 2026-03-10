import process from "node:process";
import {
  Session,
  SESSION_OPTIONS_KEYS,
  type SessionOptions,
} from "./session.ts";
import { storage } from "./storage.ts";
import {
  appendLog,
  createFoldNode,
  failFold,
  FOLD_OPTIONS_KEYS,
  type FoldNode,
  type FoldOptions,
  setTitle,
  startFold,
  succeedFold,
} from "./fold-node.ts";

/** Shared run-and-finalize logic for both top-level and nested folds. */
async function runFold<T, A extends unknown[] = unknown[]>(
  node: FoldNode,
  session: Session,
  fn: (...args: A) => T | Promise<T>,
  options?: { stopRenderer?: boolean },
): Promise<T> {
  startFold(node);
  session.renderer.onFoldStart(node);

  try {
    const result = await storage.run(
      { session, node },
      (...args: A) => Promise.resolve(fn(...args)),
    );
    if (node.status === "running") {
      succeedFold(node);
    }
    return result;
  } catch (e) {
    failFold(node, e instanceof Error ? e : new Error(String(e)));
    throw e;
  } finally {
    if (node.finishedAt === undefined) {
      node.finishedAt = Date.now();
    }
    session.renderer.onFoldEnd(node);
    if (options?.stopRenderer) {
      session.renderer.stop();
    }
  }
}

/**
 * Create a fold and execute its body. If called inside an existing fold, nests as a child.
 * If called at the top level (no active context), auto-initializes a session
 * with default options.
 */
export function logFold<T, A extends unknown[] = unknown[]>(
  fn: (...args: A) => T | Promise<T>,
): Promise<T>;
export function logFold<T, A extends unknown[] = unknown[]>(
  options: FoldOptions,
  fn: (...args: A) => T | Promise<T>,
): Promise<T>;
export function logFold<T, A extends unknown[] = unknown[]>(
  options: SessionOptions & FoldOptions,
  fn: (...args: A) => T | Promise<T>,
): Promise<T>;
export function logFold<T, A extends unknown[] = unknown[]>(
  title: string | undefined,
  fn: (...args: A) => T | Promise<T>,
): Promise<T>;
export function logFold<T, A extends unknown[] = unknown[]>(
  title: string | undefined,
  options: FoldOptions,
  fn: (...args: A) => T | Promise<T>,
): Promise<T>;
export function logFold<T, A extends unknown[] = unknown[]>(
  title: string | undefined,
  options: SessionOptions & FoldOptions,
  fn: (...args: A) => T | Promise<T>,
): Promise<T>;

export function logFold<T, A extends unknown[] = unknown[]>(
  titleOrFnOrOptions:
    | string
    | undefined
    | ((...args: A) => T | Promise<T>)
    | (SessionOptions & FoldOptions),
  fnOrOptions?:
    | ((...args: A) => T | Promise<T>)
    | FoldOptions
    | (SessionOptions & FoldOptions),
  maybeFn?: (...args: A) => T | Promise<T>,
): Promise<T> {
  const { title, options, fn } = resolveLogFoldArgs(
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
    const root = createFoldNode(
      title,
      undefined,
      options as FoldOptions | undefined,
    );
    session.root = root;
    session.renderer.start(session.root);
    return runFold(root, session, fn, { stopRenderer: true });
  }

  if (options) {
    const hasSessionOptions = SESSION_OPTIONS_KEYS.some((k) => k in options);
    if (hasSessionOptions) {
      throw new Error(
        `Session options (${SESSION_OPTIONS_KEYS.join(", ")}) are only ` +
          `allowed at the top level${
            title ? ` (in logFold("${title}"))` : ""
          }. ` +
          `Nested logFold() calls inherit the session ` +
          `from their parent. Per-fold options (${
            FOLD_OPTIONS_KEYS.join(", ")
          }) ` +
          `are allowed at any level.`,
      );
    }
  }

  // Nested call — create child under current context
  const { session, node: parent } = store;
  const child = createFoldNode(
    title,
    parent,
    options as FoldOptions | undefined,
  );
  return runFold(child, session, fn);
}

function resolveLogFoldArgs<T>(
  titleOrFnOrOptions:
    | string
    | undefined
    | (() => T | Promise<T>)
    | (SessionOptions & FoldOptions),
  fnOrOptions?:
    | (() => T | Promise<T>)
    | FoldOptions
    | (SessionOptions & FoldOptions),
  maybeFn?: () => T | Promise<T>,
): {
  title: string | undefined;
  options: Record<string, unknown> | undefined;
  fn: () => T | Promise<T>;
} {
  if (typeof titleOrFnOrOptions === "function") {
    // logFold(fn)
    return { title: undefined, options: undefined, fn: titleOrFnOrOptions };
  }

  if (
    typeof titleOrFnOrOptions === "object" &&
    titleOrFnOrOptions !== null
  ) {
    // logFold(options, fn)
    return {
      title: undefined,
      options: titleOrFnOrOptions,
      fn: fnOrOptions as () => T | Promise<T>,
    };
  }

  // logFold(title, ...) — title is string | undefined
  const title = titleOrFnOrOptions;
  if (typeof fnOrOptions === "function") {
    // logFold(title, fn)
    return { title, options: undefined, fn: fnOrOptions };
  }

  // logFold(title, options, fn)
  return {
    title,
    options: fnOrOptions as Record<string, unknown> | undefined,
    fn: maybeFn as () => T | Promise<T>,
  };
}

/**
 * Append log output to the current fold. Splits on newlines — multi-line
 * strings produce multiple log entries. Strips trailing \r from each line.
 *
 * If called outside any fold context, falls back to process.stderr.write(line + "\n").
 * If LOG_FOLD_STRICT env var is set, throws instead.
 */
export function log(text: string): void {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const store = storage.getStore();

  if (!store || !store.node) {
    // Outside any fold context
    if (process.env.LOG_FOLD_STRICT) {
      throw new Error(
        "log() called outside a logFold() context. " +
          "Wrap your code in a logFold() call, or unset the LOG_FOLD_STRICT environment variable.",
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
 * Set the current fold's status to warning.
 * Sets status to "warning" without setting finishedAt.
 */
export function setCurrentFoldWarning(): void {
  const store = storage.getStore();
  if (!store?.node) {
    throw new Error(
      "setCurrentFoldWarning() called outside a logFold() context.",
    );
  }
  store.node.status = "warning";
}

/**
 * Set the current fold's status to skipped.
 * Sets status to "skipped" without setting finishedAt.
 */
export function setCurrentFoldSkipped(): void {
  const store = storage.getStore();
  if (!store?.node) {
    throw new Error(
      "setCurrentFoldSkipped() called outside a logFold() context.",
    );
  }
  store.node.status = "skipped";
}

/**
 * Update the current fold's display title.
 * The renderer picks up the change on the next tick.
 */
export function setCurrentFoldTitle(title: string): void {
  const store = storage.getStore();
  if (!store?.node) {
    throw new Error(
      "setCurrentFoldTitle() called outside a logFold() context.",
    );
  }
  setTitle(store.node, title);
}

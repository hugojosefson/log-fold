# log-fold implementation plan

## Goal

Build `@hugojosefson/log-fold` — a runtime-agnostic library (Deno, Node.js, Bun)
that renders a collapsing task tree to any output stream (stdout, stderr, etc.).
Inspired by Docker Buildkit's progress display. Tasks collapse to a single line
when complete; running tasks expand to show sub-tasks and a tail window of
subprocess output. Multiple tasks can run concurrently. On error, the full log
is dumped.

Intended for CLI tools, build systems, deployment scripts, and any program that
wants structured progress output. Not limited to build/CI — any workflow with
nested units of work benefits.

## Design decisions (confirmed)

| Decision               | Choice                                                                                                                                                                                                                                                                                              |
| :--------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API style              | Single `logTask()` function with AsyncLocalStorage-based implicit context. Auto-inits on first call; accepts optional config via options argument (top-level only — throws if passed to nested calls). Callbacks can be sync or async (`() => T \| Promise<T>`). Return type is always `Promise<T>` |
| Log tail               | Keep full log buffer, display last N lines in tail window. Print full log on error                                                                                                                                                                                                                  |
| VT100 emulation        | Skip for now; design the log buffer so a VT100 parser can plug in later                                                                                                                                                                                                                             |
| Subprocess integration | `logFromStream()` accepts Node.js `Readable`, web `ReadableStream`, arrays, or `{ stdout, stderr }` objects (covers `node:child_process`, `Deno.Command`, `Bun.spawn`). `runCommand()` wraps `node:child_process` as convenience                                                                    |
| Runtime                | Runtime-agnostic via `node:` built-in modules (`node:tty`, `node:process`, `node:async_hooks`, `node:child_process`). No Deno-specific APIs                                                                                                                                                         |
| Dependencies           | `jsr:@std/fmt` (includes colors) + `npm:cli-spinners` (runtime import — the default dots spinner is imported from `cli-spinners` at runtime, not hardcoded) + `npm:string-width` (ANSI-aware visual width measurement for line truncation) + `node:` built-ins                                      |
| Colors support         | Delegates to `jsr:@std/fmt/colors` which auto-checks `NO_COLOR` env var. No override option — users control colors via `NO_COLOR` environment variable                                                                                                                                              |
| Terminal control       | `node:tty` `WriteStream` methods (`cursorTo`, `moveCursor`, `clearLine`, `clearScreenDown`) instead of hand-written ANSI escapes. Only cursor hide/show requires raw ANSI                                                                                                                           |
| Unicode                | Unicode symbols only (`✓`, `✗`, `⚠`, `⊘`, `│`), no ASCII fallback. Running tasks use a configurable spinner (default: dots from cli-spinners)                                                                                                                                                       |
| Colors                 | Buildkit-style: cyan for completed, red for errors, yellow for warnings, dim for skipped                                                                                                                                                                                                            |
| Exports                | Submodule exports in `deno.jsonc`                                                                                                                                                                                                                                                                   |
| Concurrency            | Support multiple children running simultaneously under one parent                                                                                                                                                                                                                                   |

## Coding conventions

| Convention       | Rule                                                                                                                                                                                                                                              |
| :--------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Types            | Prefer `type` over `interface` for all type definitions. Use `type` for object shapes, unions, and intersections. `interface` is never used                                                                                                       |
| Immutability     | Prefer `const` over `let`. Use `let` only when reassignment is genuinely needed (e.g., loop counters where `const` iteration isn't possible)                                                                                                      |
| Resource cleanup | Prefer `using`/`await using` (with `Symbol.dispose`/`Symbol.asyncDispose`) over `const` + `try`/`finally` for resource lifecycle management. `try`/`catch` is still used for error handling — `using` replaces only the cleanup/`finally` portion |

## Architecture

```
src/
├── ansi.ts               # Cursor hide/show constants (only what node:tty lacks)
├── format.ts             # Display utilities (formatDuration) — pure functions, no rendering deps
├── task-node.ts          # TaskNode data model, tree operations
├── storage.ts            # AsyncLocalStorage instance + ContextStore type
├── session.ts            # Internal Session class (owns root, renderer)
├── context.ts            # Module-level logTask/log/setCurrentTask* (imports storage + session)
├── log-from-stream.ts    # logFromStream — pipe streams into current task's log
├── run-command.ts        # Optional subprocess wrapper (node:child_process)
├── renderer/
│   ├── renderer.ts       # Renderer type definition
│   ├── compute-frame.ts  # computeFrame pure function + FrameOptions
│   ├── tty-renderer.ts   # TtyRenderer (implements Renderer)
│   └── plain-renderer.ts # PlainRenderer (implements Renderer)
mod.ts                    # Public re-exports
```

## Detailed design

### Layer 1: `src/ansi.ts` — ANSI escape constants

Minimal file — only the two escape sequences that `node:tty` `WriteStream`
doesn't provide as methods:

```typescript
/** Hide the cursor. */
export const hideCursor = "\x1b[?25l";

/** Show the cursor. */
export const showCursor = "\x1b[?25h";
```

Everything else is handled by `node:tty` `WriteStream` methods on the output
stream (default: `process.stderr`):

| Operation                     | Method                     |
| :---------------------------- | :------------------------- |
| Move cursor up N lines        | `output.moveCursor(0, -n)` |
| Move cursor to column 0       | `output.cursorTo(0)`       |
| Erase current line            | `output.clearLine(0)`      |
| Erase cursor to end of screen | `output.clearScreenDown()` |
| Get terminal size             | `output.columns`, `.rows`  |
| Detect TTY                    | `output.isTTY`             |
| Write string                  | `output.write(s)`          |

The existing `src/ansi.ts` needs to be rewritten — remove `cursorUp`,
`cursorColumn0`, `eraseDown`, `eraseLine`, `writeSync`, and the `TextEncoder`.
Keep only `hideCursor` and `showCursor`.

### Layer 2: `src/task-node.ts` — task tree data model

Already partially written. Core types and operations:

- `TaskStatus`:
  `"pending" | "running" | "success" | "warning" | "fail" | "skipped"`
- `TaskNode` type: `title` (mutable — needed for `setTitle()`; `undefined` means
  the task is structural-only and not rendered — its children appear at the
  parent's depth level), `status`, `parent`, `children[]`, `logLines[]`,
  `error`, `startedAt`, `finishedAt`, `tailLines?`, `spinner?`,
  `composedFlatMap` (per-task display options — stored on the node so
  `computeFrame()` can access them without walking the ancestor chain on every
  render tick; see below)
- `createTaskNode(title?, parent?, taskOptions?)` — factory, appends to parent's
  `children[]`. Computes and stores `composedFlatMap` at creation time by
  composing the task's own `map`/`filter` with the parent's `composedFlatMap`:
  local `map` runs first, then local `filter`, then `parent.composedFlatMap`.
  Returns `string[]` (empty = filtered out, one element = mapped, multiple =
  expanded). The multi-element case is not producible by the current
  `map`/`filter` signatures — this is intentional future-proofing for a
  potential `flatMap` option. Do not simplify to `string | undefined`. **Default
  when no map/filter on this task or any ancestor**: identity function
  `(line: string) => [line]` — always set, never `undefined`. Renderer code
  calls `composedFlatMap` unconditionally without null checks. Also resolves
  `tailLines` and `spinner` by inheriting from the nearest ancestor that sets
  them. These never change after task creation.

  **Composition example**: given a parent task with
  `{ filter: (line) => !line.includes("SECRET") }` and a child task with
  `{ map: (line) => line.replace(/\/home\/user/g, "~") }`:

  - Child's `composedFlatMap` for input `"/home/user/token: SECRET_abc"`:
    1. Child's `map`: `"~/token: SECRET_abc"`
    2. Child's `filter`: (none) → passes through
    3. Parent's `composedFlatMap`: parent's filter sees `"~/token: SECRET_abc"`
       → contains "SECRET" → filtered out → returns `[]`

  - Child's `composedFlatMap` for input `"/home/user/src/main.ts"`:
    1. Child's `map`: `"~/src/main.ts"`
    2. Child's `filter`: (none) → passes through
    3. Parent's `composedFlatMap`: parent's filter sees `"~/src/main.ts"` → no
       "SECRET" → returns `["~/src/main.ts"]`

  Note: the parent's filter sees the child's **already-mapped** output. This
  matches the "transforms compose outward" mental model — child transforms apply
  first, then parent transforms wrap them.
- `startTask()`, `succeedTask()`, `failTask(error?)` — lifecycle transitions.
  **All are internal-only** (not exported from `mod.ts`). No `warnTask()` or
  `skipTask()` functions exist — the public `setCurrentTaskWarning()` and
  `setCurrentTaskSkipped()` in `context.ts` set `node.status` directly without
  setting `finishedAt`, so the `taskHandle` disposer sets `finishedAt` when the
  callback returns. The `logTask()` implementation only calls `succeedTask()` if
  `node.status` is still `"running"`, preserving any warning/skipped status set
  during execution.
- `setTitle(node, title)` — update the node's display title in-place (renderer
  picks it up on the next tick)
- `appendLog(node, line)` — pushes a single line to `logLines[]` (no splitting;
  the caller — `log()` in `context.ts` — is responsible for splitting on `\n`)
- `tailLogLines(node, n)` — last N lines for the tail window
- `durationMillis(node)` — returns `finishedAt - startedAt` (in milliseconds)
  for completed/failed/warned/skipped tasks, `Date.now() - startedAt` for
  running tasks, `undefined` for pending tasks. Returns raw milliseconds — all
  formatting is handled by `formatDuration()` in `src/format.ts`.
- `formatDuration(ms)` — **lives in `src/format.ts`** (display utility, not data
  model). Formats a duration in milliseconds for display. Auto-scales: `<10s` →
  `1.23s`, `10–60s` → `12.3s`, `60–3600s` → `1m 23s`, `≥3600s` → `1h 2m`. Simple
  manual formatting (~10 lines), no Temporal API.
- `walkTree(root)` — depth-first generator yielding `{ node, depth }`, starting
  from the given root. General-purpose utility — always yields raw tree depth
  based on structure. Does NOT adjust depth for title-less tasks;
  `computeFrame()` maintains its own display-depth tracking for that
- `ancestorChain(node)` — path from root to given node

Additional functions needed for concurrency:

```typescript
/** Find all currently-running leaf nodes (no running children). */
function findRunningLeaves(root: TaskNode): TaskNode[];

/** Count total tasks and completed tasks in the tree.
 *  Title-less (structural-only) tasks are excluded from counts —
 *  (C/N) reflects only visible titled tasks.
 *  "Completed" = any terminal status: success, warning, fail, or skipped.
 *  All terminal statuses count — the counter shows how many tasks have
 *  finished, regardless of outcome. */
function countTasks(root: TaskNode): { total: number; completed: number };

/** Total bytes of log output for a node (for activity ranking). */
function logBytes(node: TaskNode): number;
```

Remove existing `findDeepestRunning` (single-node assumption).

### Layer 3: `src/storage.ts` + `src/context.ts` — AsyncLocalStorage implicit context

`src/storage.ts` holds only the `AsyncLocalStorage` instance and the
`ContextStore` type. It has type-only imports from this package (no runtime
dependency cycle), breaking the circular dependency between `context.ts` and
`session.ts`:

```typescript
import { AsyncLocalStorage } from "node:async_hooks";
import type { Session } from "./session.ts";
import type { TaskNode } from "./task-node.ts";

export type ContextStore = {
  session: Session;
  node: TaskNode | undefined;
};

export const storage = new AsyncLocalStorage<ContextStore>();
```

`src/context.ts` imports `storage` from `./storage.ts` and `Session` from
`./session.ts`. `src/session.ts` also imports `storage` from `./storage.ts`.
Neither imports from the other — the circular dependency is eliminated.

Module-level functions:

```typescript
/**
 * Create and run a task. If called inside an existing task, nests as a child.
 * If called at the top level (no active context), auto-initializes a session
 * with default options — the renderer starts when this task starts
 * and stops when this task completes.
 *
 * Title may be undefined — structural-only tasks are not rendered in the
 * tree display. Their children appear at the parent's depth level. Useful
 * for grouping/wrapping without adding visual noise.
 *
 * Options are split into two categories:
 * - Session options (mode, output, tickInterval) only apply at the top
 *   level. The overload accepting `SessionOptions & TaskOptions` is for
 *   top-level calls; the overload accepting only `TaskOptions` is for
 *   nested calls. TypeScript enforces this at compile time — passing
 *   session options to a nested `logTask()` is a type error.
 *   Runtime check retained as defense-in-depth for JavaScript callers
 *   and compiled TypeScript where overloads are erased.
 * - Per-task options (tailLines, spinner, map, filter) are allowed at any
 *   nesting level. tailLines and spinner inherit from the nearest ancestor
 *   that sets them; map and filter compose with ancestor tasks' map/filter
 *   (child first, then parent).
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

/**
 * Append log output to the current task. Splits on newlines — multi-line
 * strings produce multiple log entries. Trailing empty strings from the
 * split are kept (not dropped). `log("hello\n")` produces two entries:
 * "hello" and "". `log("")` appends one empty string to logLines[],
 * producing a blank line in the tail window — consistent with
 * `console.log("")`. Splits on `\n` and strips trailing `\r` from each
 * resulting line (so `\r\n` input is handled correctly — no stray `\r`
 * in logLines, tail window, or error dumps). For each resulting line,
 * calls appendLog(node, line) and renderer.onLog(node, line). appendLog
 * is a trivial array push; log() owns the splitting, \r stripping, and
 * renderer notification.
 *
 * If called outside any task context, falls back to splitting on newlines
 * and writing each line to process.stderr.write(line + "\n") — consistent
 * with in-context behavior. Output is never lost.
 *
 * Strict mode: when the `LOG_FOLD_STRICT` environment variable is set
 * (any non-empty value), calling `log()` outside a task context throws
 * an error instead of falling back to stderr. This helps catch bugs
 * during development where code runs outside a `logTask()` wrapper
 * unintentionally. Libraries should NOT set this — it is for end-user
 * scripts that want to ensure all output is captured in the task tree.
 */
export function log(text: string): void;

/**
 * Mark the current task as completed with warnings.
 * Sets status to "warning" without setting finishedAt (the task is still
 * running). When the logTask callback returns, the task handle's
 * `[Symbol.asyncDispose]()` sets finishedAt and the status is preserved
 * as "warning" instead of being overridden to "success".
 *
 * Implementation: sets node.status = "warning" directly. finishedAt is
 * left unset so the disposer handles it when the callback returns.
 */
export function setCurrentTaskWarning(): void;

/**
 * Mark the current task as skipped. The logTask callback should return
 * immediately after calling this. Sets status to "skipped" without setting
 * finishedAt. When the logTask callback returns, the task handle's
 * `[Symbol.asyncDispose]()` sets finishedAt and the status is preserved
 * as "skipped" instead of being overridden to "success".
 *
 * Implementation: sets node.status = "skipped" directly. finishedAt is
 * left unset so the disposer handles it when the callback returns.
 */
export function setCurrentTaskSkipped(): void;

/**
 * Update the current task's display title. The renderer picks up the
 * change on the next tick.
 */
export function setCurrentTaskTitle(title: string): void;
```

Design choices for "outside context" behavior:

**Note**: when called outside any context, `log()` writes to `process.stderr`
directly — not to a configurable output stream. This is by design: there is no
session to read configuration from. The session's `output` option only applies
to log lines rendered within a `logTask()` callback. Output is never lost.

| Function                               | Outside context                                                                                                                                                                                                          |
| :------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `logTask()` (context.ts)               | Auto-inits a session with defaults (or provided options). This becomes the root                                                                                                                                          |
| `log()` (context.ts)                   | Splits on `\n`, strips trailing `\r`, writes each line to `process.stderr.write(line + "\n")` — output is never lost. If `LOG_FOLD_STRICT` env var is set, throws instead                                                |
| `logFromStream()` (log-from-stream.ts) | Falls back to piping lines to `process.stderr` via `log()` — output is never lost. Still collects and returns lines as a string (the return value is about stream content, not task context). Respects `LOG_FOLD_STRICT` |

Sequential top-level `logTask()` calls (outside any context) each create their
own independent render session. Each session starts and stops its own renderer
(including cursor hide/show and independent progress counts). For scripts with
multiple sequential top-level tasks, this means multiple independent render
cycles. To unify multiple top-level tasks under one session with shared progress
tracking, wrap them in an outer `logTask()`.

Passing session options (mode, tickInterval, output) to a nested `logTask()`
(inside an existing context) throws an error — these options only apply at the
top level. This is a programming error and should be caught during development.
Per-task options (tailLines, spinner, map, filter) are allowed at any nesting
level. `tailLines` and `spinner` inherit from the nearest ancestor that sets
them.

`logTask()` pushes a new `ContextStore` into AsyncLocalStorage before calling
`fn()`, so any nested `logTask()`/`log()` calls inside `fn()` auto-nest
correctly. This is the key mechanism for auto-detecting call hierarchy:

```typescript
import { Session } from "./session.ts";
import { storage } from "./storage.ts";
import {
  createTaskNode,
  failTask,
  startTask,
  succeedTask,
} from "./task-node.ts";

/** Creates a disposable handle that finalizes a task node on dispose. */
function taskHandle(
  node: TaskNode,
  session: Session,
  options?: { stopRenderer?: boolean },
): AsyncDisposable {
  return {
    async [Symbol.asyncDispose]() {
      if (node.finishedAt === undefined) {
        node.finishedAt = Date.now();
      }
      session.renderer.onTaskEnd(node);
      if (options?.stopRenderer) {
        session.renderer.stop();
      }
    },
  };
}

export async function logTask(titleOrFnOrOptions, fnOrOptions?, maybeFn?) {
  // Overload dispatch: resolve (title, options, fn) from the 6 overload shapes.
  // First arg can be: string|undefined (title), function (fn), or object (options).
  let title: string | undefined;
  let options: Record<string, unknown> | undefined;
  let fn: () => unknown;

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
    options = titleOrFnOrOptions;
    fn = fnOrOptions;
  } else {
    // logTask(title, ...) — title is string | undefined
    title = titleOrFnOrOptions;
    if (typeof fnOrOptions === "function") {
      fn = fnOrOptions;
    } else {
      options = fnOrOptions;
      fn = maybeFn;
    }
  }

  const store = storage.getStore();

  if (!store) {
    // Top-level call — auto-init a session with defaults (or provided options)
    const session = new Session(options);
    const root = createTaskNode(title, undefined, options);
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
      if (root.status === "running") {
        succeedTask(root);
      }
      return result;
    } catch (e) {
      failTask(root, e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
    // _handle[Symbol.asyncDispose]() runs automatically:
    // sets finishedAt, calls onTaskEnd, stops renderer
  }

  if (options) {
    const SESSION_OPTIONS_KEYS = [
      "mode",
      "tickInterval",
      "output",
    ];
    const hasSessionOptions = SESSION_OPTIONS_KEYS.some((k) => k in options);
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
  const child = createTaskNode(title, parent, options);
  startTask(child);
  session.renderer.onTaskStart(child);

  await using _handle = taskHandle(child, session);
  try {
    const result = await storage.run(
      { session, node: child },
      () => Promise.resolve(fn()),
    );
    // Respect warn/skip set during execution
    if (child.status === "running") {
      succeedTask(child);
    }
    return result;
  } catch (e) {
    failTask(child, e instanceof Error ? e : new Error(String(e)));
    throw e;
  }
  // _handle[Symbol.asyncDispose]() runs automatically:
  // sets finishedAt, calls onTaskEnd
}
```

#### DX comparison — use cases

##### Use case 1 — simple sequential script

```typescript
import { log, logTask } from "@hugojosefson/log-fold";

await logTask("Build", async () => {
  await logTask("Install", async () => {
    log("npm install...");
    await install();
  });
  await logTask("Compile", async () => {
    log("tsc --build");
  });
});
```

The outer `logTask("Build")` auto-initializes the rendering session. No context
objects passed anywhere. `install()` could itself call `logTask()` and `log()`
and everything auto-nests.

##### Use case 2 — deep nesting across module boundaries

```typescript
// build.ts
import { log, logTask } from "@hugojosefson/log-fold";
import { compileFiles } from "./compile.ts";

export async function build() {
  await logTask("Compile", async () => {
    log("compiling...");
    await compileFiles(); // auto-nests under "Compile"
  });
}

// compile.ts — only imports log-fold, no context threading
import { log, logTask } from "@hugojosefson/log-fold";

export async function compileFiles() {
  await logTask("Parse", async () => {
    log("parsing...");
  });
  await logTask("Emit", async () => {
    log("emitting...");
  });
}
```

##### Use case 3 — concurrent tasks

```typescript
import { log, logTask } from "@hugojosefson/log-fold";

await logTask("CI", async () => {
  await logTask("Install", async () => {
    /* ... */
  });

  await Promise.all([
    logTask("Compile", async () => {
      log("tsc --build");
    }),
    logTask("Lint", async () => {
      log("eslint src/");
    }),
  ]);
});
```

Each branch of `Promise.all` has its own async context, so `log()` calls inside
each go to the right task. AsyncLocalStorage handles this correctly.

##### Use case 4 — library code that optionally logs

```typescript
// db.ts — works whether or not log-fold is active
import { log } from "@hugojosefson/log-fold";

export async function migrate() {
  log("running migrations..."); // goes to task log if active, stderr if not
  await runMigrations();
  log("migrations complete");
}
```

##### Use case 5 — subprocess with auto-nesting (runCommand)

```typescript
import { logTask } from "@hugojosefson/log-fold";
import { runCommand } from "@hugojosefson/log-fold/run-command";

await logTask("Build", async () => {
  await runCommand(["npm", "install"]);
  // title defaults to "npm install" — no duplication needed
  await runCommand("TypeScript compile", ["npx", "tsc", "--build"]);
  // explicit title when command isn't descriptive enough
});
```

##### Use case 6 — error with full log dump

```typescript
import { log, logTask } from "@hugojosefson/log-fold";

await logTask("Build", async () => {
  log("step 1...");
  log("step 2...");
  // ... 200 more log lines ...
  throw new Error("compilation failed");
  // → "Build" marked as fail
  // → renderer stops, all 202 lines dumped to output
  // → error propagates to caller
});
```

##### Use case 7 — wrapping third-party code

```typescript
import { logTask } from "@hugojosefson/log-fold";

await logTask("Deploy", async () => {
  await logTask("Database migration", async () => {
    // Third-party code doesn't call log() — that's fine.
    // Task shows as running with a timer, no log tail.
    await thirdPartyMigrate();
  });
});
```

##### Use case 8 — custom config via options

Pass options to the top-level `logTask()` for custom renderer configuration:

```typescript
import { log, logTask } from "@hugojosefson/log-fold";

await logTask(
  "Deploying",
  { tailLines: 10 },
  async () => {
    await logTask("Upload assets", async () => {
      log("uploading...");
    });
    await logTask("Invalidate cache", async () => {
      log("invalidating...");
    });
  },
);
```

Without options, the first `logTask()` auto-initializes with defaults. Options
are only needed for custom `tailLines`, `mode`, `output`, etc.

##### Use case 9 — BYO subprocess with `logFromStream` (Node.js `child_process`)

When you already have your own `ChildProcess` and want to pipe its output into a
log-fold task, use `logFromStream()`. It accepts the child process object
directly — it picks up `.stdout` and `.stderr` automatically:

```typescript
import { spawn } from "node:child_process";
import { logFromStream, logTask } from "@hugojosefson/log-fold";

await logTask("My process", async () => {
  const child = spawn("my-tool", ["--flag"]);
  const output = await logFromStream(child);
  // output is stdout only (stderr piped to log for display, not collected)
});
```

##### Use case 10 — BYO subprocess with `logFromStream` (Deno `Command`)

```typescript
import { logFromStream, logTask } from "@hugojosefson/log-fold";

await logTask("Build", async () => {
  const child = new Deno.Command("npm", {
    args: ["install"],
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  await logFromStream(child);
});
```

##### Use case 11 — BYO subprocess with `logFromStream` (Bun `spawn`)

```typescript
import { logFromStream, logTask } from "@hugojosefson/log-fold";

await logTask("Build", async () => {
  const child = Bun.spawn(["npm", "install"]);
  await logFromStream(child);
});
```

##### Use case 12 — piping a fetch response body

`logFromStream()` also accepts a single `ReadableStream`:

```typescript
import { logFromStream, logTask } from "@hugojosefson/log-fold";

await logTask("Fetch logs", async () => {
  const response = await fetch("https://example.com/logs");
  await logFromStream(response.body!);
});
```

##### Use case 13 — manual stream wiring (no `logFromStream`)

For full control, you can wire streams yourself using `log()` directly:

```typescript
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { log, logTask } from "@hugojosefson/log-fold";

await logTask("My process", async () => {
  const child = spawn("my-tool", ["--flag"]);
  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => log(line));
  await new Promise((resolve) => child.on("close", resolve));
});
```

##### Use case 14 — warning status from callback API

```typescript
import { log, logTask, setCurrentTaskWarning } from "@hugojosefson/log-fold";

await logTask("Deploy", async () => {
  log("deploying...");
  const result = await deploy();
  if (result.deprecationWarnings.length > 0) {
    log(`${result.deprecationWarnings.length} deprecation warnings`);
    setCurrentTaskWarning(); // task shows ⚠ instead of ✓
  }
});
```

##### Use case 15 — skip status from callback API

```typescript
import { logTask, setCurrentTaskSkipped } from "@hugojosefson/log-fold";

await logTask("Build cache", async () => {
  if (await cacheExists()) {
    setCurrentTaskSkipped(); // task shows ⊘ instead of ✓
    return;
  }
  // ... build cache ...
});
```

##### Use case 16 — dynamic task title

```typescript
import { log, logTask, setCurrentTaskTitle } from "@hugojosefson/log-fold";

await logTask("Download", async () => {
  const files = await listFiles();
  for (const [i, file] of files.entries()) {
    setCurrentTaskTitle(`Download (${i + 1}/${files.length})`);
    await downloadFile(file);
  }
});
```

##### Use case 17 — filtering sensitive output

```typescript
import { log, logTask } from "@hugojosefson/log-fold";

await logTask(
  "Deploy",
  { filter: (line) => !line.includes("SECRET") },
  async () => {
    log("connecting to server...");
    log("using token: SECRET_abc123"); // stored in logLines but hidden from display and error dumps
    log("deploy complete");
  },
);
```

##### Use case 18 — mapping log lines

```typescript
import { log, logTask } from "@hugojosefson/log-fold";

await logTask(
  "Build",
  { map: (line) => line.replace(/\/home\/user/g, "~") },
  async () => {
    log("compiling /home/user/src/main.ts"); // displayed and dumped on error as "compiling ~/src/main.ts"
  },
);
```

### Layer 4: `src/renderer/` — rendering

Two implementations behind a common `Renderer` type, in separate files under
`src/renderer/`.

#### Renderer type

```typescript
type Renderer = {
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
```

All Renderer methods become no-ops after `stop()` is called. This handles the
edge case where concurrent tasks continue writing after one branch throws and
the parent's `logTask` calls `stop()`. Users should use `Promise.allSettled` if
they need all branches to complete before the parent fails. Any tasks still in
`running` status when `stop()` is called remain in that status — the renderer
does not modify task state. Handling orphaned running tasks (cancellation,
aborting) is deferred to a future version (see "Cancellation" section).

The renderer receives the `root: TaskNode` reference on `start()` and reads the
tree directly on each render tick. The `onTaskStart`/`onTaskEnd` callbacks are
informational hooks for the PlainRenderer (which writes immediately). The
TtyRenderer ignores them — it reads the full tree state on each tick. The
`onLog` callback is used by PlainRenderer to write log lines immediately as they
arrive; TtyRenderer ignores it (new log output is picked up on the next
tick-based render frame).

**Wiring**: every code path that appends log output must call
`renderer.onLog(node, line)` after `appendLog()`. This means:

- `log()` in `context.ts` calls `session.renderer.onLog(node, line)` for each
  line after splitting and appending
- `logFromStream()` calls `log()` internally, which handles the wiring

#### TTY renderer — frame-based re-render (using `node:tty` `WriteStream`)

##### Render loop

- **Tick interval**: 150ms (configurable)
- **Render strategy**: render unconditionally on every tick. No dirty flag —
  running tasks always need duration timer and spinner frame updates, so
  "nothing changed" is rare. The tick is cheap if the frame is identical
- On `stop()`: one final frame with no height limit, then dump full log for any
  failed tasks. The final frame shows failed tasks as collapsed single lines
  (`✗ Task Name  ERROR  1.2s`). The full error log dump (ancestor path header +
  all log lines + error/stack trace) appears below the final frame as permanent
  non-overwritten output.

##### Frame computation

Extracted into a pure function `computeFrame(root, options)` returning
`{ lines: string[] }` so it's testable without a terminal. `options` includes
`termWidth`, `termHeight`, `displayCounts: WeakMap<TaskNode, number>`, and `now`
(current timestamp, so tests can pass a fixed value and get deterministic
spinner frames). Per-task `tailLines`, `spinner` and `composedFlatMap` are read
from each `TaskNode` directly (resolved at task creation time). The
`displayCounts` WeakMap is passed into `computeFrame` and **mutated in place** —
entries are incremented for nodes whose tail is shown this frame (tracks how
many frames each node's tail has been shown, providing "stickiness" so the
display doesn't thrash between tasks' log windows). Using `WeakMap` instead of
`Map` communicates ephemeral tracking intent and auto-cleans entries after
session disposal. The TtyRenderer persists this map as instance state and passes
the same instance into each `computeFrame()` call.

Each render cycle produces a list of output lines:

There is no separate header line. The aggregate progress count (completed/total)
is shown on the root task's running line (see Step 2).

###### Step 1 — task lines (recursive)

Walk the task tree depth-first. For each node at a given `depth`:

| Status            | Rendering                                                  | Color              |
| :---------------- | :--------------------------------------------------------- | :----------------- |
| `success`         | `✓ Task Name  1.2s` (single line, children hidden)         | dim cyan           |
| `warning`         | `⚠ Task Name  1.2s` (single line, children hidden)         | yellow             |
| `fail`            | `✗ Task Name  ERROR  1.2s` (single line)                   | red                |
| `running` (root)  | `<frame> Task Name  1.2s (3/8)` then recurse into children | default foreground |
| `running` (child) | `<frame> Task Name  1.2s` then recurse into children       | default foreground |
| `skipped`         | `⊘ Task Name` (single line, no duration)                   | dim                |
| `pending`         | not shown                                                  | —                  |

**Title-less tasks** (`title === undefined`): the task node itself is not
rendered (no status line). Its children are rendered at the parent's depth level
instead of indenting further. `walkTree` still visits the node, but
`computeFrame` skips its own line and recurses into children without
incrementing depth. For the plain renderer, title-less tasks are omitted from
the ancestor path prefix (e.g., `[Root > Child]` not
`[Root > undefined > Child]`).

**Title-less root task**: if the top-level `logTask()` call has no title, the
root node is not rendered and has no line for the `(C/N)` progress counter.
Children appear at depth 0 with no progress summary. This is valid — users who
want progress tracking should provide a title for the root task.

`<frame>` is the current spinner frame (cycled using
`frames[Math.floor(now / spinner.interval) % frames.length]`). The spinner
animation is decoupled from the render tick — it uses the spinner's own
`interval` property (default 80ms for dots), not `tickInterval` (150ms). At
150ms render ticks with an 80ms spinner interval, ~1.9 frames advance per tick —
some spinner frames are visually skipped. This is acceptable (buildkit uses a
similarly coarse tick). Users wanting smoother animation can lower
`tickInterval` to match the spinner's `interval` (e.g., 80ms) at the cost of
more redraws. The default spinner is the braille dots pattern from
`cli-spinners`.

Colors are applied using `@std/fmt/colors`:

```typescript
import { cyan, dim, red, yellow } from "@std/fmt/colors";

// Completed task line
dim(cyan(`✓ ${title}  ${duration}s`));
// Warning task line
yellow(`⚠ ${title}  ${duration}s`);
// Failed task line
red(`✗ ${title}  ERROR  ${duration}s`);
// Skipped task line
dim(`⊘ ${title}`);
// Log tail lines
dim(`│ ${line}`);
```

Indentation: each depth level adds 2 spaces of indent.

All output lines (task lines and log tail lines) are truncated to `termWidth`
with a trailing `…` if they exceed the terminal width. Truncation uses
`npm:string-width` (by sindresorhus) to measure visual width — this correctly
handles ANSI escape codes (zero width) and fullwidth Unicode characters (double
width), preventing mid-escape-sequence cuts and over-truncation. This prevents
wrapping artifacts that would break cursor math. Applies to all lines regardless
of source (auto-generated titles from `runCommand`, user-provided titles, log
content).

With concurrent tasks, multiple children of a running parent can be `running`
simultaneously. Each running child is shown expanded (its own line + its
children). Completed siblings are shown collapsed. This is exactly what buildkit
does — all started jobs appear; running ones get expanded subtrees.

###### Step 2 — log tail windows (competitive allocation)

Following buildkit's `setupTerminals()` approach:

1. Collect all running leaves (nodes with `status === "running"`, no running
   children, and `logLines.length > 0`)
2. Rank by activity: `logBytes + displayCount * 50` (where `displayCount` comes
   from the `displayCounts` map passed into `computeFrame`, keyed by `TaskNode`
   reference — tracks how many frames this node's tail has been shown, provides
   "stickiness" so the display doesn't thrash between different tasks' log
   windows)
3. Calculate available viewport lines: `free = termHeight - taskLines - 2`
4. Each tail window costs `tailLines + 1` lines (the log lines plus visual
   padding)
5. Greedily assign tail windows to ranked candidates while `free > 0`, reducing
   `tailLines` for the last candidate if needed to fit

Tail lines rendered dimmed, prefixed with the task's indent + `│`:

```
│ npm warn deprecated inflight@1.0.6
│ npm warn deprecated glob@7.2.3
│ added 247 packages in 3.1s
```

###### Step 3 — viewport fitting

If the total frame exceeds terminal height:

1. First, reduce tail window heights (fewer log lines shown)
2. If still too tall, drop completed tasks starting from the oldest
3. Never drop running tasks — they are always visible
4. If a running task was above the viewport cut, swap it in by removing a
   completed task from the visible portion (buildkit's `wrapHeight` algorithm)

##### Cursor strategy

Uses `node:tty` `WriteStream` methods on the output stream (default:
`process.stderr`):

1. `moveCursor(0, -previousLineCount)` to go back to the frame origin
2. `cursorTo(0)` to move to column 0
3. `write(hideCursor)` (raw ANSI — no built-in method)
4. For each line: `clearLine(0)` then `write(content + "\n")`
5. After writing the last line of the new frame: `clearScreenDown()` to erase
   any leftover content from a previously taller frame
6. Track `lineCount` for next cycle
7. `write(showCursor)` (raw ANSI)

##### First render

On the first call, `previousLineCount` is 0, so no cursor-up. The `repeated`
flag prevents moving past the origin.

##### Terminal resize

`output.columns` and `output.rows` are read at each render tick. These are
updated automatically by the runtime when the terminal resizes (via the
`'resize'` event on the `WriteStream`). No manual SIGWINCH handler or polling
needed.

##### Non-TTY detection

When mode is `"auto"` (default): `output.isTTY` at startup → selects TTY or
plain renderer.

#### Plain renderer — sequential text output

For piped / non-TTY / CI output. No cursor movement, append-only. PlainRenderer
is purely event-driven — it writes output immediately via `onLog`,
`onTaskStart`, and `onTaskEnd` callbacks. It does not use `computeFrame()`.

The root task prefix includes a progress count `(completed/total)` that updates
as tasks complete, matching the TTY renderer's root-line progress:

- On task start: `[Root (0/N) > Child] => started`
- On log append: `[Root (C/N) > Child] line content`
- On task end (success): `[Root (C/N) > Child] ✓ 1.2s`
- On task end (warning): `[Root (C/N) > Child] ⚠ 1.2s`
- On task end (fail): `[Root (C/N) > Child] ✗ ERROR  1.2s`, then dump full log
- On task end (skipped): `[Root (C/N) > Child] ⊘ skipped`

where `C` = completed tasks so far, `N` = total tasks created so far. **Note**:
`N` is monotonically increasing — it grows as new tasks are created during
execution. Early lines may show `(0/2)` while later lines show `(2/5)` as more
tasks are discovered. This is expected behavior, matching buildkit's approach.

Always prefix each line with the full ancestor path (like docker compose's
`service | line` pattern but extended for nested tasks). Title-less tasks
(`title === undefined`) are omitted from the ancestor path — their children
appear under the nearest titled ancestor. This keeps output unambiguous when
concurrent tasks interleave, even if different subtrees have tasks with the same
name:

```
[CI (0/4)] => started
[CI (0/4) > Install] => started
[CI (0/4) > Install] npm install...
[CI (1/4) > Install] ✓ 1.2s
[CI (1/4) > Compile] => started
[CI (1/4) > Test] => started
[CI (1/4) > Compile] tsc --build
[CI (1/4) > Test] running test suite...
[CI (2/4) > Compile] ✓ 1.2s
[CI (2/4) > Test] 5 tests passed
[CI (3/4) > Test] ✓ 0.8s
[CI (4/4)] ✓ 2.1s
```

### Layer 5: `src/session.ts` — internal session management

The `Session` class owns the task tree and renderer. It is not exported from the
package — it's an internal implementation detail used by `context.ts`.

The constructor validates the `mode`/`output` combination: if `mode` is `"tty"`
(or `"auto"` resolving to TTY), the `output` stream must be a `tty.WriteStream`
with `cursorTo`, `moveCursor`, `clearLine`, and `clearScreenDown` methods. If
these methods are missing, the constructor throws with a clear error message
explaining that TTY mode requires a `tty.WriteStream` (e.g., `process.stderr`).

#### Constructor options

```typescript
import type { WriteStream } from "node:tty";

/** Spinner definition compatible with `cli-spinners` by sindresorhus. */
export type Spinner = {
  /** Frame interval in milliseconds. */
  interval: number;
  /** Animation frames, cycled on each render tick. */
  frames: string[];
};

export type SessionOptions = {
  /** Force TTY or plain mode. Default: "auto" (detect via isTTY). */
  mode?: "tty" | "plain" | "auto";
  /** Render tick interval in ms. Default: 150.
   * This controls how often the frame is re-rendered (dirty flag check, duration
   * timers update). Spinner animation is independent — it uses the spinner's own
   * interval property (typically 80ms), not tickInterval. */
  tickInterval?: number;
  /**
   * Output stream. Default: process.stderr.
   * When mode is "tty", must be a tty.WriteStream (for cursor methods).
   * When mode is "plain", any Writable with write() works.
   */
  output?: WriteStream | { write(s: string): boolean };
};

export type TaskOptions = {
  /** Number of log tail lines to show for this task. Default: 6.
   * Set to 0 to suppress the log tail window entirely, even when log
   * lines exist (the task still shows its status line with spinner/timer).
   * Child tasks inherit from the nearest ancestor that sets this.
   * Resolved once at task creation by createTaskNode(). */
  tailLines?: number;
  /**
   * Spinner for this running task. Default: dots spinner imported from
   * `cli-spinners` at runtime (currently equivalent to
   * `{ interval: 80, frames: ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"] }`).
   * Pass any object matching `Spinner`, e.g. from the `cli-spinners` package.
   * Child tasks inherit from the nearest ancestor that sets this.
   * Resolved once at task creation by createTaskNode().
   */
  spinner?: Spinner;
  /**
   * Transform each log line before display and in error dumps.
   * At task creation, composed with ancestor chain into a single
   * `composedFlatMap: (line: string) => string[]` stored on the TaskNode.
   * Composition order: local map → local filter → parent's composedFlatMap.
   * computeFrame() and error dump code call composedFlatMap directly,
   * no ancestor walking at render time.
   */
  map?: (line: string) => string;
  /**
   * Filter log lines at display time and in error dumps. Return true to show,
   * false to hide. Applied after map, before parent's composedFlatMap.
   *
   * Tip: use `{ filter: () => false }` to suppress all log output for a
   * task while still recording lines in logLines[] (the raw, unfiltered
   * lines are always stored). Note: this also suppresses output in error
   * dumps. If you want logs hidden during execution but dumped on error,
   * use `{ tailLines: 0 }` instead — this suppresses the tail window
   * while running but preserves full error dump output.
   */
  filter?: (line: string) => boolean;
};
```

Session options and task options are combined inline as
`SessionOptions & TaskOptions` in the top-level `logTask()` overload signatures.
No separate `LogTaskOptions` type alias is defined — the inline intersection is
clear enough and avoids an extra export/type to maintain.

#### Error handling

- **Callback API**: thrown error → task fails, error stored on node. Error
  propagates up through the callback chain. The top-level `logTask()` catches
  it, calls `renderer.stop()`, then rethrows.
- **On `stop()`**: renderer renders one final frame, then dumps logs for every
  failed task that is a **leaf failure** (no failed children). When a nested
  task fails and the error propagates to the parent (making the parent also
  `fail`), only the deepest failed task gets a log dump — the ancestor path
  header already identifies the chain. Parents that failed solely due to error
  propagation (not from their own throw) are not dumped separately. **Title-less
  leaf failures** are dumped — their log lines and error are never lost. In the
  ancestor path header, title-less tasks are shown as `<unnamed task>` (e.g.,
  `--- Failed: Root > <unnamed task> ---`). Output goes to the same output
  stream configured for the session (not hardcoded to stderr). This output is
  permanent (not cursor-overwritten). Log lines are transformed through the
  task's `composedFlatMap` before output — so secret redaction via
  `map`/`filter` applies to error dumps too, not just the tail window. Error
  dump format:
  1. Ancestor chain path header: `--- Failed: Parent > Child > Grandchild ---`
  2. Log lines from the failed task (after `composedFlatMap`), indented with 4
     spaces
  3. Error message and stack trace (from `node.error`), indented with 4 spaces
  4. Blank line separator between multiple failed tasks
- **Top-level `logTask()` errors**: the error propagates after the renderer
  stops and the full log is dumped. Users should wrap top-level `logTask()` in
  try/catch if they want to handle errors gracefully, or let it crash with the
  full log visible.

### Layer 6: `src/log-from-stream.ts` — stream-to-log piping

Accepts a variety of stream shapes and pipes their content line-by-line into the
current task's log via `log()`. Returns collected lines as a string when all
streams have ended.

Exported from the default entry point (`mod.ts` / `"."`), not from the
`run-command` submodule. `runCommand` imports and uses `logFromStream`
internally.

#### Collection strategy

`logFromStream` maintains its own local `string[]` for the return value. Every
line from the input streams is both passed to `log()` (for task display) and
pushed to the local collection. The return value comes from this local
collection, never from `node.logLines`.

This avoids a subtle bug: if other code calls `log()` concurrently in the same
task while `logFromStream` is running, those lines would contaminate the return
value if it read from `node.logLines`. By collecting locally, the return value
contains exactly the lines that came from the piped stream(s).

For `StreamPair` inputs (process-like objects with `.stdout` and `.stderr`),
both streams are piped to `log()` for display, but **only stdout lines are
collected** for the return value. This matches the universal unix convention
that stdout is structured output and stderr is diagnostic noise. `runCommand`
relies on this behavior to capture only stdout as `RunCommandResult.stdout`.

**Rationale for implicit stdout-only return**: The "refactor risk" (changing
`logFromStream(child)` to `logFromStream(child.stdout)`) is low in practice —
switching from `child` to `child.stdout` would lose stderr piping (you'd
notice), and switching from `child.stdout` to `child` gains stderr piping while
keeping the same stdout content in the return value. The alternative of
returning `{ stdout, stderr }` for `StreamPair` would change the return type
based on input shape, which is more confusing than the current implicit
behavior.

For all other input types (single stream, array, `AsyncIterable`), all lines are
collected — there's no stdout/stderr distinction to make.

#### Type signature

```typescript
import type { Readable } from "node:stream";

/** A Node.js Readable or a web ReadableStream<Uint8Array>. */
type AnyReadable = Readable | ReadableStream<Uint8Array>;

/** An object with optional stdout and/or stderr streams. */
type StreamPair = {
  stdout?: AnyReadable | undefined;
  stderr?: AnyReadable | undefined;
};

/** What logFromStream accepts. */
type LogFromStreamInput =
  | AnyReadable
  | AnyReadable[]
  | StreamPair
  | AsyncIterable<string>;

/**
 * Pipe one or more streams into the current task's log.
 * Reads all streams concurrently; lines go to log() in event-loop arrival
 * order, which closely matches the source's actual write order.
 *
 * Collects lines locally (not from node.logLines) so that concurrent log()
 * calls from other code don't contaminate the return value.
 *
 * For StreamPair inputs, only stdout lines are collected for the return
 * value. Stderr lines are piped to log() for display but excluded from
 * the returned string. This means passing `child` (a StreamPair) vs
 * `child.stdout` (a single stream) gives different return values:
 * - `logFromStream(child)` → returns stdout only
 * - `logFromStream(child.stdout)` → returns everything from that stream
 *
 * Returns collected lines joined with "\n" and .trim()'d.
 *
 * For AsyncIterable<string>, each yielded string is passed to log(),
 * which splits on \n — so multi-line yielded strings produce multiple
 * log entries, consistent with all other input types. Collection strategy
 * (pre-split vs post-split) doesn't matter for the return value since
 * both are `.join("\n").trim()`'d to the same result.
 */
export async function logFromStream(input: LogFromStreamInput): Promise<string>;
```

The `StreamPair` shape covers subprocess objects from all three runtimes:

| Runtime | API                          | Passed as                                                                                  |
| :------ | :--------------------------- | :----------------------------------------------------------------------------------------- |
| Node.js | `child_process.spawn()`      | `child` — has `.stdout: Readable \| null`, `.stderr: Readable \| null`                     |
| Deno    | `new Deno.Command().spawn()` | `child` — has `.stdout: ReadableStream<Uint8Array>`, `.stderr: ReadableStream<Uint8Array>` |
| Bun     | `Bun.spawn()`                | `child` — has `.stdout: ReadableStream<Uint8Array>`, `.stderr: ReadableStream<Uint8Array>` |

#### Input detection logic

Order matters — Node.js `Readable` implements `Symbol.asyncIterator`, so stream
checks must come before the `AsyncIterable` check to avoid misidentifying
`Readable` streams as `AsyncIterable<string>` (which would treat raw byte chunks
as "lines").

1. Is it an `Array`? → process each element concurrently via `Promise.all`,
   collect all lines
2. Has `.stdout` or `.stderr` property, AND the **input object itself** does not
   have `.pipe()` or `.getReader()` (i.e., not a single stream that happens to
   have stdout/stderr-like properties)? → `StreamPair`: pipe both streams to
   `log()`, but only collect stdout lines for the return value
3. Has `.getReader()` method (on the input object)? → web `ReadableStream`,
   convert to Node.js `Readable` via `Readable.fromWeb()`, then use
   `node:readline`
4. Has `.pipe()` method (on the input object)? → Node.js `Readable`, use
   `node:readline` directly
5. Has `Symbol.asyncIterator` (and didn't match any above)? →
   `AsyncIterable<string>`, consume with
   `for await (const line of input) { log(line); collect(line); }`

#### Line splitting

Each stream is split into lines using `node:readline` `createInterface()`. Each
line is passed to `log()`. This handles both `\n` and `\r\n` line endings.

For web `ReadableStream<Uint8Array>`, convert first via
`Readable.fromWeb(stream)` from `node:stream`, then use `node:readline` as
usual.

#### Ordering

When multiple streams are read concurrently (e.g. stdout + stderr), lines go to
`log()` in event-loop arrival order. This closely matches the subprocess's
actual write order — any divergence is sub-millisecond and invisible to humans.
This is the same approach used by Docker Buildkit and Docker Compose.

### Layer 7: `src/run-command.ts` — optional subprocess wrapper

Uses `node:child_process` for runtime-agnostic subprocess execution.

#### `runCommand()` — subprocess convenience wrapper

```typescript
import type { SpawnOptions } from "node:child_process";

type RunCommandOptions = Omit<SpawnOptions, "stdio"> & {
  /**
   * Behavior on non-zero exit code. Default: true.
   * - true: throw an Error (task fails via the enclosing logTask catch)
   * - "warn": don't throw, set the task to warning status (⚠)
   * - false: don't throw, task stays success (✓)
   */
  throwOnError?: boolean | "warn";
};

type RunCommandResult = {
  /** Exit code, or undefined if the process was killed by a signal.
   *  Converted from node:child_process's null to undefined. */
  code: number | undefined;
  /** Signal name if killed, or undefined if exited normally.
   *  Converted from node:child_process's null to undefined. */
  signal: string | undefined;
  /** Captured stdout output (lines joined with "\n", .trim()'d). */
  stdout: string;
};

/**
 * Run a command as a sub-task, piping stdout+stderr to the task's log.
 * Auto-nests under the current task context (via AsyncLocalStorage).
 *
 * Two overloads:
 * - runCommand(command) — title defaults to command.join(" ")
 * - runCommand(title, command, options?) — explicit title
 */
export async function runCommand(
  command: string[],
  options?: RunCommandOptions,
): Promise<RunCommandResult>;
export async function runCommand(
  title: string,
  command: string[],
  options?: RunCommandOptions,
): Promise<RunCommandResult>;
```

Implementation:

1. Calls `logTask(title, ...)` (AsyncLocalStorage) to create the sub-task
2. Spawns via
   `spawn(command[0], command.slice(1), { ...options, stdio: ["ignore", "pipe", "pipe"] })`
   **Note**: stdin is always `"ignore"`. Commands that need stdin input are out
   of scope for `runCommand` — use `spawn()` + `logFromStream()` directly.
3. Calls `logFromStream(child)` — both stdout and stderr are piped to `log()`
   for display, but only stdout lines are collected for the return value (this
   is `logFromStream`'s `StreamPair` behavior)
4. Awaits process exit: wraps the `'close'` event in a Promise, which resolves
   with `{ code, signal, stdout }` after all stdio has ended and the process has
   exited
5. Non-zero exit handling depends on `throwOnError`:
   - `true` (default): throws `Error(`Command failed with exit code ${code}`)` —
     auto-fails the task via the enclosing `logTask` catch
   - `"warn"`: calls `setCurrentTaskWarning()`, returns the result without
     throwing — the warning is set on `runCommand`'s own subtask (not the
     caller's task), so the subtask shows ⚠ while the parent can still succeed
   - `false`: returns the result without throwing or changing task status — task
     shows ✓

**Note on `SpawnOptions.timeout`**: If the caller passes `timeout` in options,
`node:child_process` sends `SIGTERM` when the timeout elapses. The process exits
with `code: undefined` and `signal: 'SIGTERM'`. With `throwOnError: true`
(default), this throws (non-zero exit). With `throwOnError: false`, the result
is returned normally with `code: undefined, signal: 'SIGTERM'`. With
`throwOnError: "warn"`, the subtask shows ⚠. Users manage process timeouts
through this mechanism or externally via `AbortController`.

### Layer 8: `mod.ts` — public exports

```typescript
// AsyncLocalStorage convenience functions (primary API)
export { log, logTask } from "./src/context.ts";
export {
  setCurrentTaskSkipped,
  setCurrentTaskTitle,
  setCurrentTaskWarning,
} from "./src/context.ts";

// Stream piping
export { logFromStream } from "./src/log-from-stream.ts";
export type {
  AnyReadable,
  LogFromStreamInput,
  StreamPair,
} from "./src/log-from-stream.ts";

// Types
export type { SessionOptions, Spinner, TaskOptions } from "./src/session.ts";
export type { TaskNode, TaskStatus } from "./src/task-node.ts";
```

The `run-command` module is a separate submodule export:

```typescript
// @hugojosefson/log-fold/run-command
export { runCommand } from "./src/run-command.ts";
export type { RunCommandOptions, RunCommandResult } from "./src/run-command.ts";
```

`deno.jsonc` exports:

```jsonc
"exports": {
  ".": "./mod.ts",
  "./run-command": "./src/run-command.ts",
  "./example-usage": "./readme/example-usage.ts"
}
```

### Layer 9: tests

#### `test/task-node.test.ts` — data model unit tests

- `createTaskNode`: correct defaults (pending, no children, no logs)
- `createTaskNode` with parent: appended to parent's children
- `createTaskNode` with taskOptions: composedFlatMap stored on node
- `createTaskNode` with parent having composedFlatMap: child's map+filter
  composed with parent's composedFlatMap (local map → local filter →
  parent.composedFlatMap)
- `createTaskNode` tailLines/spinner inheritance: inherits from nearest ancestor
- `startTask`: status → running, startedAt set
- `succeedTask`: status → success, finishedAt set
- `failTask`: status → fail, error stored, finishedAt set
- `setTitle`: updates node title in-place
- `appendLog`: pushes a single line to logLines[] (no splitting)
- `tailLogLines`: returns last N lines, handles N > total
- `durationMillis`: returns elapsed ms, undefined if not started
- `walkTree`: correct DFS order and depth values
- `findRunningLeaves`: multiple concurrent running leaves
- `findRunningLeaves`: node with running children is not a leaf
- `ancestorChain`: correct root-to-node path
- `countTasks`: correct total and completed counts
- `logBytes`: correct byte count

#### `test/renderer.test.ts` — rendering unit tests

Test the pure `computeFrame()` function directly.

- Completed task → single collapsed line with `✓` and duration
- Warning task → single collapsed line with `⚠` and duration
- Failed task → single line with `✗` and ERROR
- Skipped task → single collapsed line with `⊘`, no duration
- Running task → expanded with children visible
- Pending task → not shown
- Concurrent running siblings → both expanded
- Log tail window → last N lines shown for running leaf
- Log tail window respects node.composedFlatMap (transforms and filters lines
  before display)
- Multiple concurrent leaves → competitive tail allocation by activity
- Viewport overflow → completed tasks dropped, running tasks preserved
- No tasks → empty frame
- Deeply nested → correct indentation at each level
- Title-less task → not rendered, children shown at parent's depth (no extra
  indentation)

#### `test/context.test.ts` — AsyncLocalStorage context tests

- `logTask()` outside any context auto-inits a session
- `log()` outside any context falls back to `process.stderr.write()` with
  newline
- Nested `logTask()` calls create correct hierarchy
- `Promise.all` with multiple `logTask()` calls → separate branches
- `log()` goes to the correct task in concurrent context
- `logTask()` with options at top level configures the session
- `logTask()` with session options at nested level throws an error
- `logTask()` with per-task options (map/filter) at nested level works
- map/filter compose: local map runs first, then local filter, then parent's
  composedFlatMap (stored as composedFlatMap on the TaskNode at creation time)
- map/filter apply to both tail window display and error dumps
- original lines always preserved in logLines[] regardless of map/filter
- `setCurrentTaskWarning()` sets task status to warning
- `setCurrentTaskSkipped()` sets task status to skipped
- `setCurrentTaskTitle()` updates task title
- `logTask(fn)` — title-less overload creates structural-only task
- `logTask(options, fn)` — title-less overload with options
- Title-less task children nest correctly under nearest titled ancestor

#### `test/log-fold.test.ts` — integration tests

- Sequential tasks run and complete
- Concurrent tasks via `Promise.all`
- Error → task fails, error captured, full log available
- Nested error → propagates to parent
- Error dump applies composedFlatMap (secrets redacted in dump)
- Error dump preserves all lines that pass composedFlatMap
- Concurrent error via Promise.all → orphaned sibling tasks remain in `running`
  status (deferred to post-v1)
- Promise.allSettled → all branches complete before parent handles errors

Tests use a mock output stream passed via `logTask()` options.

#### `test/run-command.test.ts` — subprocess tests

- Run `echo hello` → log contains "hello"
- Run a failing command → task fails
- Stdout and stderr both captured
- Auto-nests under current task

#### `test/log-from-stream.test.ts` — stream piping tests

- Node.js `Readable` → lines split correctly, all collected
- Web `ReadableStream<Uint8Array>` → converted and split correctly
- `StreamPair` (object with `.stdout` and `.stderr`) → both piped to `log()`,
  only stdout lines in return value
- `StreamPair` with only `.stderr` (no `.stdout`) → returns empty string, stderr
  still piped to `log()`
- `AsyncIterable<string>` → each yielded string passed to `log()`, multi-line
  yields split correctly
- `Array` of streams → processed concurrently, all lines collected
- Input detection priority: Array > StreamPair > ReadableStream > Readable >
  AsyncIterable (verify a Node.js Readable is not misidentified as
  AsyncIterable)
- Concurrent streams (stdout + stderr on StreamPair) → lines arrive in
  event-loop order, no corruption
- Empty stream → returns empty string
- Outside task context → falls back to `process.stderr` via `log()`

### Layer 10: example and docs

#### `readme/example-usage.ts`

```typescript
import { log, logTask } from "../mod.ts";

await logTask("All", async () => {
  await logTask("Install dependencies", async () => {
    log("npm install...");
    await new Promise((r) => setTimeout(r, 500));
    log("added 247 packages in 0.5s");
  });

  // Concurrent tasks
  await Promise.all([
    logTask("Compile TypeScript", async () => {
      log("tsc --build");
      await new Promise((r) => setTimeout(r, 300));
    }),
    logTask("Lint", async () => {
      log("eslint src/");
      await new Promise((r) => setTimeout(r, 200));
    }),
  ]);

  await logTask("Test", async () => {
    log("running 42 tests...");
    await new Promise((r) => setTimeout(r, 400));
    log("42 tests passed");
  });
});
```

#### `readme/README.md`

Update template with: what log-fold does, install instructions, basic API
example, concurrent tasks example, subprocess wrapper example, custom options
example, `setCurrentTaskWarning`/`setCurrentTaskSkipped`/`setCurrentTaskTitle`
examples, options reference. Include a visible callout in the `logFromStream`
section explaining the StreamPair return semantics: passing a process object
returns stdout only, while passing a single stream returns all its content.

Include a "Gotchas" or "Tips" section covering:

- `tailLines: 0` vs `filter: () => false` — the former hides the tail window
  during execution but preserves full log output on error; the latter suppresses
  output everywhere including error dumps (use for secret redaction)
- `map`/`filter` apply to error dumps too — raw lines are always stored in
  `logLines[]`, but error dump output goes through `composedFlatMap`
- Sequential top-level `logTask()` calls create independent sessions — wrap in
  an outer `logTask()` for shared progress tracking
- `LOG_FOLD_STRICT` env var — when set, `log()` outside a task context throws
  instead of silently falling back to stderr. Useful during development to catch
  missing `logTask()` wrappers. Libraries should not set this

## VT100 extension point

The log buffer stores plain text lines (`string[]`). To add VT100 emulation:

1. Create `src/vt100.ts` with `VT100Terminal` (2D character grid)
2. Add optional `term?: VT100Terminal` to `TaskNode`
3. When present, `appendLog()` writes raw bytes to the VT100 emulator
4. `tailLogLines()` reads the last N rows from the VT100 grid
5. Renderer calls `tailLogLines()` — no changes needed

`tailLogLines()` is the abstraction seam.

## `deno.jsonc` changes

Add `@std/fmt`, `cli-spinners`, and `string-width` to imports. Remove
`@std/path` (unused). Update exports for submodules:

```jsonc
{
  "imports": {
    "@std/assert": "jsr:@std/assert@^1.0.19",
    "@std/fmt": "jsr:@std/fmt@^1.0.0",
    "cli-spinners": "npm:cli-spinners@^3.0.0",
    "string-width": "npm:string-width@^7.0.0"
  },
  "exports": {
    ".": "./mod.ts",
    "./run-command": "./src/run-command.ts",
    "./example-usage": "./readme/example-usage.ts"
  }
}
```

No Deno-specific runtime APIs are used anywhere. All runtime interaction goes
through `node:` built-in modules:

| Module               | Used for                                       |
| :------------------- | :--------------------------------------------- |
| `node:tty`           | `WriteStream` type, cursor/clear methods       |
| `node:process`       | `process.stderr` (the default output stream)   |
| `node:async_hooks`   | `AsyncLocalStorage` for implicit context       |
| `node:child_process` | `spawn()` in `run-command.ts`                  |
| `node:readline`      | Line-by-line reading in `logFromStream`        |
| `node:stream`        | `Readable.fromWeb()` for web stream conversion |
| `npm:cli-spinners`   | Spinner frames for running tasks               |
| `npm:string-width`   | ANSI-aware visual width for line truncation    |

## Cancellation (future, not v1)

Out of scope for initial implementation. This includes:

- **Orphaned running tasks**: When `Promise.all` is used and one branch throws,
  the parent's `logTask` callback exits and calls `stop()`. Sibling tasks that
  are still running remain in `running` status — the renderer does not modify
  task state. The final frame may show spinner symbols for these orphaned tasks.
  Users who need all branches to finish before the parent handles errors should
  use `Promise.allSettled` instead.
- **AbortSignal propagation**: The user manages their own `AbortController`.
  Future extension point: `logTask()` could accept `{ signal: AbortSignal }` in
  options to propagate cancellation through the tree.
- **`abortTask` lifecycle function**: A future `abortTask()` could force-fail
  running nodes and mark them as aborted, distinguishing user-cancelled tasks
  from genuine failures in the error dump.

## OpenTelemetry bridge (future, not v1)

A future `@hugojosefson/log-fold/otel` entry point could provide a bridge that:

1. **Emits OTel spans** for each log-fold task — so they show up in tracing
   backends (Jaeger, Zipkin, etc.) alongside the terminal rendering
2. **Optionally consumes OTel spans** — for users with existing OTel
   instrumentation who want terminal rendering

This approach keeps log-fold lightweight for users who just want progress
output, while encouraging OTel adoption by providing immediate visual feedback
for instrumented code.

The bridge is post-v1 because OTel's `SpanProcessor` API doesn't support
real-time observation of span events during execution — the log tail window
(log-fold's key feature) requires our own API for streaming log lines.

## Confirmed design decisions (from plan review)

| Decision                                     | Choice                                                                                                                                                                                                                                                                  |
| :------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `logTask()` return type                      | Always `Promise<T>`, even for sync callbacks. AsyncLocalStorage and renderer interactions require async.                                                                                                                                                                |
| Declarative open/close API                   | Not for v1. Callback-only ensures cleanup. Declarative handle API can be added later.                                                                                                                                                                                   |
| `getCurrentTask()` export                    | Not for v1. `setCurrentTask*()` functions cover common cases; direct node access encourages tight coupling.                                                                                                                                                             |
| `getCurrentTaskLogs()` export                | Not for v1. Users track their own state. Keep the API surface minimal.                                                                                                                                                                                                  |
| `runCommand` default title                   | No truncation of the title string itself. `command.join(" ")` as-is; users pass an explicit title for complex commands. Long lines are truncated at terminal width by `computeFrame()` (see "Line truncation" decision).                                                |
| `logFromStream` return semantics             | Implicit based on input shape (StreamPair → stdout only, single stream → all). Follows unix convention (stdout=data, stderr=diagnostics). Documented with rationale in JSDoc and README.                                                                                |
| `map`/`filter` in error dumps                | Both apply (via `composedFlatMap`). Secrets redacted via `map`/`filter` are also redacted in error dumps. Raw `logLines[]` always preserved on the node. Use `tailLines: 0` (not `filter`) to hide output during execution while preserving error dumps.                |
| Plain renderer prefix                        | Full ancestor path with progress counts: `[Root (C/N) > Child > Leaf]` for unambiguous interleaved output with progress tracking.                                                                                                                                       |
| `map`/`filter` composition                   | Composed once at task creation time into a single `composedFlatMap: (line: string) => string[]` on the `TaskNode`. Composition: local map → local filter → parent's composedFlatMap. No ancestor chain walking at render time.                                          |
| `composedFlatMap` return type                | `string[]` — multi-element case is future-proofing for a potential `flatMap` option. Do not simplify to `string \| undefined`.                                                                                                                                          |
| Orphaned concurrent tasks                    | Deferred to post-v1. On `stop()`, tasks still in `running` status remain as-is — the renderer does not modify task state. Users should use `Promise.allSettled` if they need all branches to finish.                                                                    |
| Progress bar / ETA                           | Not for v1. The `(3/8)` count on the root task line is sufficient.                                                                                                                                                                                                      |
| Task lifecycle functions scope               | `startTask()`, `succeedTask()`, `failTask()` are internal-only — not exported from `mod.ts`. No `warnTask()`/`skipTask()` functions. Public API uses `setCurrentTaskWarning()`/`setCurrentTaskSkipped()` which set `node.status` directly without setting `finishedAt`. |
| `logTask()` options types                    | Separate overloads: `SessionOptions & TaskOptions` for top-level, `TaskOptions` for nested. TypeScript enforces at compile time. Runtime check retained as defense-in-depth.                                                                                            |
| Session output validation                    | Session constructor validates `mode`/`output` combination at runtime: TTY mode requires `tty.WriteStream` with cursor methods. Throws clear error if violated.                                                                                                          |
| `displayCounts` storage                      | `WeakMap<TaskNode, number>` (not `Map`). Communicates ephemeral tracking intent and auto-cleans after session disposal.                                                                                                                                                 |
| Duration format                              | Auto-scale: `<10s` → `1.23s`, `10–60s` → `12.3s`, `≥60s` → `1m 23s`, `≥3600s` → `1h 2m`. Manual formatting, no Temporal API.                                                                                                                                            |
| `runCommand` warning target                  | Warning is set on `runCommand`'s own subtask (not the caller's task). Subtask shows ⚠, parent can still succeed.                                                                                                                                                        |
| `setCurrentTaskWarning`/`Skipped` conflict   | Last-write-wins. Calling both on the same task is allowed; the last call determines the final status. No throw on conflict.                                                                                                                                             |
| Task timeout                                 | Out of scope for log-fold entirely (not just v1). Users manage timeouts externally via `AbortController`, `Promise.race`, etc.                                                                                                                                          |
| Silent/no-op mode                            | Not for v1. Libraries document their log-fold usage; consumers wrap in their own `logTask()` to control output.                                                                                                                                                         |
| Task metadata                                | Not for v1. Keep `TaskNode` lean. Add metadata when the OTel bridge is designed.                                                                                                                                                                                        |
| `composedFlatMap` default                    | Identity function `(line) => [line]` when no `map`/`filter` on this task or any ancestor. Always set, never `undefined`. Renderer calls it unconditionally without null checks.                                                                                         |
| `formatDuration` location                    | In `src/format.ts` (separate display utility file), not in `task-node.ts`. Pure function, no rendering deps.                                                                                                                                                            |
| Optional title                               | `logTask()` title is optional (`string \| undefined`). Title-less overloads allow calling `logTask(fn)` or `logTask(options, fn)` without passing `undefined`. Tasks with `undefined` title are structural-only — not rendered, children appear at parent's depth.      |
| `setCurrentTask*` naming                     | Keep verbose names (`setCurrentTaskWarning`, `setCurrentTaskSkipped`, `setCurrentTaskTitle`). Unambiguous, grep-friendly, no collision risk.                                                                                                                            |
| `runCommand` stdin                           | Out of scope. Stdin hardcoded to `"ignore"`. Users needing stdin should use `spawn()` + `logFromStream()` directly. Documented in JSDoc.                                                                                                                                |
| `log()` outside context target               | Writes to `process.stderr` directly (not a configurable stream). By design: no session exists to read config from. When `LOG_FOLD_STRICT` env var is set, throws instead. Documented explicitly in the plan.                                                            |
| Plain renderer dynamic N                     | `N` in `(C/N)` is monotonically increasing — grows as tasks are created. Early lines may show smaller N than later lines. Matches buildkit behavior.                                                                                                                    |
| `logTask()` nested session options check     | Runtime check retained as defense-in-depth for JavaScript callers and compiled TypeScript where overloads are erased. Documented in JSDoc.                                                                                                                              |
| `logFromStream` tests                        | Dedicated `test/log-from-stream.test.ts` covering all input shapes, detection priority, StreamPair stdout-only collection, concurrent ordering, edge cases.                                                                                                             |
| `TaskNode` interface → type                  | Convert from `interface` to `type` per coding conventions. Noted in implementation step 5.                                                                                                                                                                              |
| `displayCounts` Map vs WeakMap typo          | Fixed: implementation step 5 now correctly says `WeakMap<TaskNode, number>`, matching all other references.                                                                                                                                                             |
| `logTask()` overload ordering                | `TaskOptions`-only overload listed before `SessionOptions & TaskOptions` to ensure correct TypeScript overload resolution (narrower type first). Title-less overloads listed before titled overloads.                                                                   |
| StreamPair detection wording                 | Clarified: `.pipe()` / `.getReader()` checks are on the **input object itself**, not on its `.stdout`/`.stderr` properties.                                                                                                                                             |
| Title-less tasks in progress count           | Excluded. `countTasks()` only counts titled tasks. `(C/N)` reflects visible tasks only.                                                                                                                                                                                 |
| `cli-spinners` usage                         | Runtime import. The default dots spinner is imported from `cli-spinners` at runtime, not hardcoded. `cli-spinners` is a runtime dependency in `deno.jsonc`.                                                                                                             |
| `countTasks` completed definition            | All terminal statuses count: `success`, `warning`, `fail`, `skipped`. The counter shows how many tasks have finished, regardless of outcome.                                                                                                                            |
| Error dump scope                             | Leaf failures only. When a nested task fails and the error propagates to the parent, only the deepest failed task (no failed children) gets a log dump. The ancestor path header identifies the chain.                                                                  |
| `log()` trailing newline                     | Keep all split results. `log("hello\n")` produces `["hello", ""]` — both are appended. `log("")` appends one empty line. Trailing `\r` stripped from each line after split. Consistent with `console.log("")`.                                                          |
| TTY rate limit                               | Removed. Rely solely on the tick interval (150ms) for render throttling. Dirty-flag-triggered renders happen on the next tick, not immediately.                                                                                                                         |
| `walkTree` depth semantics                   | General-purpose. Always yields raw tree depth. `computeFrame()` maintains its own display-depth tracking for title-less task adjustments.                                                                                                                               |
| `logFromStream` outside-context return       | Still collects and returns lines as a string. The return value is about stream content, not task context.                                                                                                                                                               |
| `log("")` behavior                           | Appends one empty string to `logLines[]`, producing a blank line in the tail window. Intentional blank lines are supported. Consistent with `console.log("")`.                                                                                                          |
| Nested session options error message         | Includes the task title when available: `'Session options not allowed in nested logTask("My Task")'`. Helps identify the offending call.                                                                                                                                |
| Line truncation                              | All output lines truncated to `termWidth` with trailing `…` using `npm:string-width` for ANSI-aware visual width. Prevents wrapping artifacts that break cursor math. Applies to task lines and log tail lines.                                                         |
| `runCommand` `timeout` interaction           | Documented. `SpawnOptions.timeout` sends SIGTERM; `throwOnError` controls whether this throws, warns, or returns silently.                                                                                                                                              |
| `LogTaskOptions` export                      | Type alias removed entirely. No `LogTaskOptions` in code. Overloads use inline `SessionOptions & TaskOptions`.                                                                                                                                                          |
| README gotchas section                       | Include a dedicated "Gotchas" section covering: `tailLines: 0` vs `filter`, `map`/`filter` in error dumps, sequential top-level sessions.                                                                                                                               |
| `AsyncIterable` collection                   | Pre-split vs post-split doesn't matter — both `.join("\n").trim()` to the same result. Implementation can collect either way.                                                                                                                                           |
| TTY render strategy                          | Render unconditionally on every tick (150ms). No dirty flag — running tasks always need duration/spinner updates, so idle ticks are rare. Simpler implementation.                                                                                                       |
| `warnTask`/`skipTask` removal                | Removed. These internal functions are never called — `setCurrentTaskWarning()`/`setCurrentTaskSkipped()` set `node.status` directly, and the `logTask()` implementation only calls `succeedTask()` (guarded by `node.status === "running"`) and `failTask()`.           |
| `cli-spinners` spinner JSDoc                 | JSDoc documents current frames as "currently equivalent to" the `cli-spinners` dots spinner, not as hardcoded literal values. The default is imported from `cli-spinners` at runtime.                                                                                   |
| ANSI-aware line truncation                   | Uses `npm:string-width` (by sindresorhus) for visual width measurement. Correctly handles ANSI escape codes (zero width) and fullwidth Unicode (double width). Prevents mid-escape-sequence truncation.                                                                 |
| `logTask()` overload count                   | Keep all 6 overloads. Title and options are separate positional args. Each call site reads clearly despite the overload count.                                                                                                                                          |
| `logFromStream` return semantics             | Keep implicit. StreamPair → stdout-only, single stream → all. Documented, follows unix convention.                                                                                                                                                                      |
| `runCommand` stderr in result                | Keep stdout-only. Stderr is diagnostic output displayed in the log. Users needing stderr capture use `spawn()` + `logFromStream()` directly.                                                                                                                            |
| Title-less `logTask(fn)` behavior            | Keep as-is. `logTask(fn)` creates a title-less structural-only task. No error for missing title — this is a valid and convenient grouping mechanism.                                                                                                                    |
| `setCurrentTaskSkipped` enforcement          | Advisory only. The JSDoc recommends returning immediately after calling it, but no runtime enforcement. Consistent with `setCurrentTaskWarning`.                                                                                                                        |
| Silent/no-op mode                            | Deferred to post-v1. Users pass a no-op writable stream if needed.                                                                                                                                                                                                      |
| `setCurrentTaskWarning` JSDoc style          | Keep behavior description ("status is preserved as warning"). Implementation mechanism (`if (node.status === "running")` guard) is an internal detail — JSDoc describes user-facing behavior, not mechanism.                                                            |
| Error dump output stream                     | Uses the session's configured output stream. If the user configured a custom stream, error dumps go there too. `log()` outside context still writes to `process.stderr` (no session exists).                                                                            |
| Plain renderer double-prefixing              | Accepted. Plain renderer always prefixes with `[ancestor > path]`. Users can use `map()` to strip existing prefixes from log lines if needed.                                                                                                                           |
| `displayCounts` mutation strategy            | `computeFrame()` mutates the passed-in `WeakMap<TaskNode, number>` in place. No "new copy" returned. Simpler than copying (WeakMaps can't be iterated). TtyRenderer passes the same instance each tick.                                                                 |
| `\r` stripping in `log()`                    | `log()` splits on `\n` and strips trailing `\r` from each line. Handles `\r\n` input correctly — no stray `\r` in `logLines[]`, tail window, or error dumps.                                                                                                            |
| Spinner frame skipping                       | Accepted. At 150ms render tick with 80ms spinner interval, some spinner frames are visually skipped. Buildkit uses a similarly coarse tick. Users wanting smoother animation can lower `tickInterval` to match the spinner's `interval` (e.g., 80ms). Documented.       |
| Title-less task in error dump                | Dumped (log lines and error are never lost). In the ancestor path header, title-less tasks appear as `<unnamed task>` (e.g., `--- Failed: Root > <unnamed task> ---`).                                                                                                  |
| `LogTaskOptions` type alias                  | Removed. No type alias defined. Overload signatures use inline `SessionOptions & TaskOptions`. Fewer types to maintain.                                                                                                                                                 |
| Title-less root task                         | Allowed. No `(C/N)` progress counter visible. Children appear at depth 0. Users wanting progress tracking provide a title for the root task.                                                                                                                            |
| `log()` strict mode                          | `LOG_FOLD_STRICT` env var: when set (any non-empty value), `log()` outside a task context throws instead of falling back to stderr. For development bug catching. Libraries should not set this.                                                                        |
| `runCommand` stderr in result (re-confirmed) | Keep stdout-only in `RunCommandResult`. Stderr is diagnostic output displayed in the log. Users needing stderr capture use `spawn()` + `logFromStream()` directly.                                                                                                      |
| `map`/`filter` composition docs              | Added a concrete example to the plan showing parent filter + child map composition (see `createTaskNode` section in Layer 2). Clarifies implementation.                                                                                                                 |
| Title in `TaskOptions`                       | Title is always a separate positional arg, never in `TaskOptions`. The 3-arg form `logTask("title", options, fn)` is used for configured+titled tasks.                                                                                                                  |

## Implementation order

1. `deno.jsonc` — add `@std/fmt`, `cli-spinners`, `string-width`; remove
   `@std/path`; update exports (do this first so deps are available for all
   subsequent steps)
2. Remove `src/cli.ts` — unused empty shebang script, not part of the library
3. `src/ansi.ts` — rewrite: keep only `hideCursor`/`showCursor` constants
4. `src/format.ts` — new file: `formatDuration()` display utility (extracted
   from `task-node.ts`; pure function, no rendering deps)
5. `src/task-node.ts` — update: convert `TaskNode` from `interface` to `type`
   (per coding conventions — `interface` is never used); add `setTitle`,
   `findRunningLeaves`, `countTasks`, `logBytes`; add `composedFlatMap`,
   `tailLines?`, `spinner?` fields to `TaskNode`; remove `id` field (use
   `WeakMap<TaskNode, number>` for displayCounts instead);
   `createTaskNode(title, parent?, taskOptions?)` composes map/filter into
   `composedFlatMap` at creation time (identity function `(line) => [line]` when
   no map/filter on this task or any ancestor); make `title` optional (see
   "Optional title" in confirmed decisions); remove `findDeepestRunning` and
   `appendLogLines`; simplify `appendLog` to a single-line push (splitting moves
   to `log()` in `context.ts`). Move `formatDuration()` to new `src/format.ts`
   (display utility, not data model). No `warnTask()` or `skipTask()` — warning
   and skipped statuses are set directly by `setCurrentTaskWarning()` /
   `setCurrentTaskSkipped()` in `context.ts`
6. `src/renderer/` — `renderer.ts` (Renderer type with `onLog`),
   `compute-frame.ts` (`computeFrame()` pure function), `tty-renderer.ts` (TTY
   renderer using `node:tty` `WriteStream` methods, render loop, cursor
   strategy), `plain-renderer.ts` (plain renderer with immediate `onLog` output)
7. `src/storage.ts` — `AsyncLocalStorage` instance + `ContextStore` type.
   Type-only imports from this package (must come before `session.ts` since
   `session.ts` imports from it)
8. `src/session.ts` — internal `Session` class, `SessionOptions`, `TaskOptions`,
   `Spinner`. Renderer stored as a property. Imports `storage` from
   `./storage.ts`. Not exported from the package
9. `src/context.ts` — module-level `logTask()` (with options overload), `log()`,
   `setCurrentTaskWarning()`, `setCurrentTaskSkipped()`,
   `setCurrentTaskTitle()`. Imports `Session` from `./session.ts` and `storage`
   from `./storage.ts`
10. `src/log-from-stream.ts` — stream piping with `AsyncIterable<string>`
    support
11. `src/run-command.ts` — `runCommand(command)` or
    `runCommand(title, command, options?)`, uses `logTask()` internally
12. `mod.ts` — public exports
13. Remove `test/placeholder.test.ts` — replaced by real tests
14. `test/task-node.test.ts`
15. `test/context.test.ts`
16. `test/renderer.test.ts`
17. `test/log-from-stream.test.ts` — input detection (Readable, ReadableStream,
    StreamPair, AsyncIterable, Array), line splitting, StreamPair stdout-only
    collection, concurrent stream ordering
18. `test/log-fold.test.ts`
19. `test/run-command.test.ts`
20. `readme/example-usage.ts` + `readme/README.md`
21. `deno task all` — validate

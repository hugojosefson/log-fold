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

| Decision               | Choice                                                                                                                                                                                                                                          |
| :--------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API style              | Single `logTask()` function with AsyncLocalStorage-based implicit context. Auto-inits on first call; accepts optional config via options argument (top-level only — throws if passed to nested calls). Callbacks can be sync or async (`() => T |
| Log tail               | Keep full log buffer, display last N lines in tail window. Print full log on error                                                                                                                                                              |
| VT100 emulation        | Skip for now; design the log buffer so a VT100 parser can plug in later                                                                                                                                                                         |
| Subprocess integration | `logFromStream()` accepts Node.js `Readable`, web `ReadableStream`, arrays, or `{ stdout, stderr }` objects (covers `node:child_process`, `Deno.Command`, `Bun.spawn`). `runCommand()` wraps `node:child_process` as convenience                |
| Runtime                | Runtime-agnostic via `node:` built-in modules (`node:tty`, `node:process`, `node:async_hooks`, `node:child_process`). No Deno-specific APIs                                                                                                     |
| Dependencies           | `jsr:@std/fmt` (includes colors) + `npm:cli-spinners` + `node:` built-ins                                                                                                                                                                       |
| Colors support         | Delegates to `jsr:@std/fmt/colors` which auto-checks `NO_COLOR` env var. No override option — users control colors via `NO_COLOR` environment variable                                                                                          |
| Terminal control       | `node:tty` `WriteStream` methods (`cursorTo`, `moveCursor`, `clearLine`, `clearScreenDown`) instead of hand-written ANSI escapes. Only cursor hide/show requires raw ANSI                                                                       |
| Unicode                | Unicode symbols only (`✓`, `✗`, `⚠`, `⊘`, `│`), no ASCII fallback. Running tasks use a configurable spinner (default: dots from cli-spinners)                                                                                                   |
| Colors                 | Buildkit-style: cyan for completed, red for errors, yellow for warnings, dim for skipped                                                                                                                                                        |
| Exports                | Submodule exports in `deno.jsonc`                                                                                                                                                                                                               |
| Concurrency            | Support multiple children running simultaneously under one parent                                                                                                                                                                               |

## Architecture

```
src/
├── ansi.ts               # Cursor hide/show constants (only what node:tty lacks)
├── task-node.ts          # TaskNode data model, tree operations
├── storage.ts            # AsyncLocalStorage instance + ContextStore type
├── session.ts            # Internal Session class (owns roots[], renderer)
├── context.ts            # Module-level logTask/log/logFromStream etc. (imports storage + session)
├── log-from-stream.ts    # logFromStream — pipe streams into current task's log
├── run-command.ts        # Optional subprocess wrapper (node:child_process)
├── renderer/
│   ├── renderer.ts       # Renderer interface
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
- `TaskNode` interface: `id`, `title` (mutable — needed for `setTitle()`),
  `status`, `parent`, `children[]`, `logLines[]`, `error`, `startedAt`,
  `finishedAt`, `tailLines?`, `spinner?`, `composedFlatMap?` (per-task display
  options — stored on the node so `computeFrame()` can access them without
  walking the ancestor chain on every render tick; see below)
- `createTaskNode(title, parent?, taskOptions?)` — factory, appends to parent's
  `children[]`. Computes and stores `composedFlatMap` at creation time by
  composing the task's own `map`/`filter` with the parent's `composedFlatMap`:
  local `map` runs first, then local `filter`, then `parent.composedFlatMap`.
  Returns `string[]` (empty = filtered out, one element = mapped, multiple =
  expanded). Also resolves `tailLines` and `spinner` by inheriting from the
  nearest ancestor that sets them. These never change after task creation.
- `startTask()`, `succeedTask()`, `warnTask()`, `failTask(error?)`, `skipTask()`
  — lifecycle transitions
- `setTitle(node, title)` — update the node's display title in-place (renderer
  picks it up on the next tick)
- `appendLog(node, line)` — pushes a single line to `logLines[]` (no splitting;
  the caller — `log()` in `context.ts` — is responsible for splitting on `\n`)
- `tailLogLines(node, n)` — last N lines for the tail window
- `durationSec(node)` — returns `finishedAt - startedAt` for
  completed/failed/warned/skipped tasks, `Date.now() - startedAt` for running
  tasks, `undefined` for pending tasks
- `walkTree(roots)` — depth-first generator yielding `{ node, depth }`
- `ancestorChain(node)` — path from root to given node

Additional functions needed for concurrency:

```typescript
/** Find all currently-running leaf nodes (no running children). */
function findRunningLeaves(roots: TaskNode[]): TaskNode[];

/** Count total tasks and completed tasks in the tree. */
function countTasks(roots: TaskNode[]): { total: number; completed: number };

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
 * Options are split into two categories:
 * - Session options (mode, output, tickInterval) only apply at the top
 *   level. Passing session options to a nested logTask() throws an error
 *   — this is a programming error.
 * - Per-task options (tailLines, spinner, map, filter) are allowed at any
 *   nesting level. tailLines and spinner inherit from the nearest ancestor
 *   that sets them; map and filter compose with ancestor tasks' map/filter
 *   (child first, then parent).
 */
export async function logTask<T>(
  title: string,
  fn: () => T | Promise<T>,
): Promise<T>;
export async function logTask<T>(
  title: string,
  options: LogTaskOptions,
  fn: () => T | Promise<T>,
): Promise<T>;

/**
 * Append log output to the current task. Splits on newlines — multi-line
 * strings produce multiple log entries. For each resulting line, calls
 * appendLog(node, line) and renderer.onLog(node, line). appendLog is a
 * trivial array push; log() owns the splitting and renderer notification.
 *
 * If called outside any task context, falls back to splitting on newlines
 * and writing each line to process.stderr.write(line + "\n") — consistent
 * with in-context behavior. Output is never lost.
 */
export function log(text: string): void;

/**
 * Mark the current task as completed with warnings.
 * Sets status to "warning" without setting finishedAt (the task is still
 * running). When the logTask callback returns, the finally block sets
 * finishedAt and the status is preserved as "warning" instead of being
 * overridden to "success".
 *
 * Implementation: sets node.status = "warning" directly — does NOT call
 * warnTask() (which would also set finishedAt prematurely).
 */
export function setCurrentTaskWarning(): void;

/**
 * Mark the current task as skipped. The logTask callback should return
 * immediately after calling this. Sets status to "skipped" without setting
 * finishedAt. When the logTask callback returns, the finally block sets
 * finishedAt and the status is preserved as "skipped" instead of being
 * overridden to "success".
 *
 * Implementation: sets node.status = "skipped" directly — does NOT call
 * skipTask() (which would also set finishedAt prematurely).
 */
export function setCurrentTaskSkipped(): void;

/**
 * Update the current task's display title. The renderer picks up the
 * change on the next tick.
 */
export function setCurrentTaskTitle(title: string): void;
```

Design choices for "outside context" behavior:

| Function                               | Outside context                                                                                |
| :------------------------------------- | :--------------------------------------------------------------------------------------------- |
| `logTask()` (context.ts)               | Auto-inits a session with defaults (or provided options). This becomes the root                |
| `log()` (context.ts)                   | Splits on `\n`, writes each line to `process.stderr.write(line + "\n")` — output is never lost |
| `logFromStream()` (log-from-stream.ts) | Falls back to piping lines to `process.stderr` via `log()` — output is never lost              |

Sequential top-level `logTask()` calls (outside any context) each create their
own independent render session. Each session starts and stops its own renderer.
To unify multiple top-level tasks under one session, wrap them in an outer
`logTask()`.

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

export async function logTask(title, fnOrOptions, maybeFn?) {
  // Overload dispatch
  const options = typeof fnOrOptions === "function" ? undefined : fnOrOptions;
  const fn = typeof fnOrOptions === "function" ? fnOrOptions : maybeFn;

  const store = storage.getStore();

  if (!store) {
    // Top-level call — auto-init a session with defaults (or provided options)
    const session = new Session(options);
    const root = createTaskNode(title, undefined, options);
    session.roots.push(root);
    startTask(root);
    session.renderer.start(session.roots);
    session.renderer.onTaskStart(root);

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
    } finally {
      // Ensure finishedAt is set for all terminal statuses (warn/skip
      // set status during execution but don't set finishedAt — the task
      // is still running at that point)
      if (root.finishedAt === undefined) {
        root.finishedAt = Date.now();
      }
      session.renderer.onTaskEnd(root);
      session.renderer.stop();
    }
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
        "Session options (mode, tickInterval, output) are only " +
          "allowed at the top level. Nested logTask() calls inherit the session " +
          "from their parent. Per-task options (tailLines, spinner, map, filter) " +
          "are allowed at any level.",
      );
    }
  }

  // Nested call — create child under current context
  const { session, node: parent } = store;
  const child = createTaskNode(title, parent, options);
  startTask(child);
  session.renderer.onTaskStart(child);

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
  } finally {
    // Ensure finishedAt is set for all terminal statuses
    if (child.finishedAt === undefined) {
      child.finishedAt = Date.now();
    }
    session.renderer.onTaskEnd(child);
  }
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
  for (let i = 0; i < files.length; i++) {
    setCurrentTaskTitle(`Download (${i + 1}/${files.length})`);
    await downloadFile(files[i]);
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

Two implementations behind a common interface, in separate files under
`src/renderer/`.

#### Renderer interface

```typescript
type Renderer = {
  /** Called when a task starts. */
  onTaskStart(node: TaskNode): void;
  /** Called when a task completes (success or fail). */
  onTaskEnd(node: TaskNode): void;
  /** Called when a log line is appended to a task. TtyRenderer ignores this
   *  (it polls on tick). PlainRenderer writes the line immediately. */
  onLog(node: TaskNode, line: string): void;
  /** Start the render loop. */
  start(roots: TaskNode[]): void;
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

The renderer receives the `roots: TaskNode[]` reference on `start()` and reads
the tree directly on each render tick. The `onTaskStart`/`onTaskEnd` callbacks
serve as dirty-flag triggers, not data carriers. The `onLog` callback is used by
PlainRenderer to write log lines immediately as they arrive; TtyRenderer ignores
it (new log output is picked up on the next tick-based render frame).

**Wiring**: every code path that appends log output must call
`renderer.onLog(node, line)` after `appendLog()`. This means:

- `log()` in `context.ts` calls `session.renderer.onLog(node, line)` for each
  line after splitting and appending
- `logFromStream()` calls `log()` internally, which handles the wiring

#### TTY renderer — frame-based re-render (using `node:tty` `WriteStream`)

##### Render loop

- **Tick interval**: 150ms (configurable)
- **Rate limit**: 100ms minimum between renders
- **Dirty flag**: set by `onTaskStart`/`onTaskEnd`; renders also happen on tick
  (so duration timers update even without new events, and new log lines are
  picked up)
- On `stop()`: one final frame with no height limit, then dump full log for any
  failed tasks

##### Frame computation

Extracted into a pure function `computeFrame(roots, options)` returning
`{ lines: string[], displayCounts: Map<string, number> }` so it's testable
without a terminal. `options` includes `termWidth`, `termHeight`,
`displayCounts: Map<string, number>`, and `now` (current timestamp, so tests can
pass a fixed value and get deterministic spinner frames). Per-task `tailLines`,
`spinner` and `composedFlatMap` are read from each `TaskNode` directly (resolved
at task creation time). The `displayCounts` map is passed into `computeFrame`
and a new copy is returned (tracks how many frames each node's tail has been
shown, providing "stickiness" so the display doesn't thrash between tasks' log
windows). The TtyRenderer persists this map as instance state, passing it into
each `computeFrame()` call and updating it with the returned copy.

Each render cycle produces a list of output lines:

There is no separate header line. The aggregate progress count (completed/total)
is shown on the root task's running line (see Step 2).

###### Step 2 — task lines (recursive)

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

`<frame>` is the current spinner frame (cycled using
`frames[Math.floor(now / interval) % frames.length]`). The default spinner is
the braille dots pattern from `cli-spinners`.

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

With concurrent tasks, multiple children of a running parent can be `running`
simultaneously. Each running child is shown expanded (its own line + its
children). Completed siblings are shown collapsed. This is exactly what buildkit
does — all started jobs appear; running ones get expanded subtrees.

###### Step 3 — log tail windows (competitive allocation)

Following buildkit's `setupTerminals()` approach:

1. Collect all running leaves (nodes with `status === "running"`, no running
   children, and `logLines.length > 0`)
2. Rank by activity: `logBytes + displayCount * 50` (where `displayCount` comes
   from the `displayCounts` map passed into `computeFrame`, keyed by task ID —
   tracks how many frames this node's tail has been shown, provides "stickiness"
   so the display doesn't thrash between different tasks' log windows)
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

###### Step 4 — viewport fitting

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

For piped / non-TTY / CI output. No cursor movement, append-only.

- On task start: `[Parent > Child] => started` (full ancestor path prefix)
- On log append: `[Parent > Child] line content`
- On task end (success): `[Parent > Child] ✓ 1.2s`
- On task end (warning): `[Parent > Child] ⚠ 1.2s`
- On task end (fail): `[Parent > Child] ✗ ERROR  1.2s`, then dump full log
- On task end (skipped): `[Parent > Child] ⊘ skipped`

Always prefix each line with the full ancestor path (like docker compose's
`service | line` pattern but extended for nested tasks). This keeps output
unambiguous when concurrent tasks interleave, even if different subtrees have
tasks with the same name:

```
[CI > Install] => started
[CI > Install] npm install...
[CI > Install] ✓ 1.2s
[CI > Compile] => started
[CI > Test] => started
[CI > Compile] tsc --build
[CI > Test] running test suite...
[CI > Compile] ✓ 1.2s
[CI > Test] 5 tests passed
[CI > Test] ✓ 0.8s
```

### Layer 5: `src/session.ts` — internal session management

The `Session` class owns the task tree and renderer. It is not exported from the
package — it's an internal implementation detail used by `context.ts`.

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
  /** Render tick interval in ms. Default: 150. */
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
   * Child tasks inherit from the nearest ancestor that sets this.
   * Resolved once at task creation by createTaskNode(). */
  tailLines?: number;
  /**
   * Spinner for this running task. Default: dots spinner
   * (`{ interval: 80, frames: ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"] }`)
   * from cli-spinners.
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
   * lines are always stored).
   */
  filter?: (line: string) => boolean;
};

/** Options for the top-level logTask() call. Combines session + per-task options. */
export type LogTaskOptions = SessionOptions & TaskOptions;
```

#### Error handling

- **Callback API**: thrown error → task fails, error stored on node. Error
  propagates up through the callback chain. The top-level `logTask()` catches
  it, calls `renderer.stop()`, then rethrows.
- **On `stop()`**: renderer renders one final frame, then dumps logs for every
  failed task. Output goes to the same output stream configured for the session
  (not hardcoded to stderr). This output is permanent (not cursor-overwritten).
  Log lines are transformed through the task's `composedFlatMap` before output —
  so secret redaction via `map`/`filter` applies to error dumps too, not just
  the tail window. Error dump format:
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
collected** for the return value. This matches the universal convention that
stdout is structured output and stderr is diagnostic noise. `runCommand` relies
on this behavior to capture only stdout as `RunCommandResult.stdout`.

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
 * For AsyncIterable<string>, each yielded string is treated as a log line
 * (no further line splitting).
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
2. Has `.stdout` or `.stderr` property (and doesn't have `.pipe()` or
   `.getReader()`)? → `StreamPair`: pipe both streams to `log()`, but only
   collect stdout lines for the return value
3. Has `.getReader()` method? → web `ReadableStream`, convert to Node.js
   `Readable` via `Readable.fromWeb()`, then use `node:readline`
4. Has `.pipe()` method? → Node.js `Readable`, use `node:readline` directly
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
     throwing — task shows ⚠ with the exit code visible in the log
   - `false`: returns the result without throwing or changing task status — task
     shows ✓

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
export type {
  LogTaskOptions,
  SessionOptions,
  Spinner,
  TaskOptions,
} from "./src/session.ts";
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
- `warnTask`: status → warning, finishedAt set
- `failTask`: status → fail, error stored, finishedAt set
- `skipTask`: status → skipped, finishedAt set
- `setTitle`: updates node title in-place
- `appendLog`: pushes a single line to logLines[] (no splitting)
- `tailLogLines`: returns last N lines, handles N > total
- `durationSec`: returns elapsed, undefined if not started
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

## VT100 extension point

The log buffer stores plain text lines (`string[]`). To add VT100 emulation:

1. Create `src/vt100.ts` with `VT100Terminal` (2D character grid)
2. Add optional `term?: VT100Terminal` to `TaskNode`
3. When present, `appendLog()` writes raw bytes to the VT100 emulator
4. `tailLogLines()` reads the last N rows from the VT100 grid
5. Renderer calls `tailLogLines()` — no changes needed

`tailLogLines()` is the abstraction seam.

## `deno.jsonc` changes

Add `@std/fmt` and `cli-spinners` to imports. Remove `@std/path` (unused).
Update exports for submodules:

```jsonc
{
  "imports": {
    "@std/assert": "jsr:@std/assert@^1.0.19",
    "@std/fmt": "jsr:@std/fmt@^1.0.0",
    "cli-spinners": "npm:cli-spinners@^3.0.0"
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

| Decision                         | Choice                                                                                                                                                                                                                         |
| :------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `logTask()` return type          | Always `Promise<T>`, even for sync callbacks. AsyncLocalStorage and renderer interactions require async.                                                                                                                       |
| Declarative open/close API       | Not for v1. Callback-only ensures cleanup. Declarative handle API can be added later.                                                                                                                                          |
| `getCurrentTask()` export        | Not for v1. `setCurrentTask*()` functions cover common cases; direct node access encourages tight coupling.                                                                                                                    |
| `runCommand` default title       | No truncation. `command.join(" ")` as-is; users pass an explicit title for complex commands.                                                                                                                                   |
| `logFromStream` return semantics | Implicit based on input shape (StreamPair → stdout only, single stream → all). Document clearly.                                                                                                                               |
| `map`/`filter` in error dumps    | Both apply. Secrets redacted via `map`/`filter` are also redacted in error dumps. Raw `logLines[]` always preserved on the node.                                                                                               |
| Plain renderer prefix            | Full ancestor path: `[Parent > Child > Leaf]` for unambiguous interleaved output.                                                                                                                                              |
| `map`/`filter` composition       | Composed once at task creation time into a single `composedFlatMap: (line: string) => string[]` on the `TaskNode`. Composition: local map → local filter → parent's composedFlatMap. No ancestor chain walking at render time. |
| Orphaned concurrent tasks        | Deferred to post-v1. On `stop()`, tasks still in `running` status remain as-is — the renderer does not modify task state. Users should use `Promise.allSettled` if they need all branches to finish.                           |
| Progress bar / ETA               | Not for v1. The `(3/8)` count on the root task line is sufficient.                                                                                                                                                             |

## Implementation order

1. `deno.jsonc` — add `@std/fmt`, `cli-spinners`, remove `@std/path`, update
   exports (do this first so `@std/fmt` is available for all subsequent steps)
2. Remove `src/cli.ts` — unused empty shebang script, not part of the library
3. `src/ansi.ts` — rewrite: keep only `hideCursor`/`showCursor` constants
4. `src/task-node.ts` — update: add `warnTask`, `skipTask`, `setTitle`,
   `findRunningLeaves`, `countTasks`, `logBytes`; add `composedFlatMap?`,
   `tailLines?`, `spinner?` fields to `TaskNode`;
   `createTaskNode(title, parent?, taskOptions?)` composes map/filter into
   `composedFlatMap` at creation time; remove `findDeepestRunning` and
   `appendLogLines`; simplify `appendLog` to a single-line push (splitting moves
   to `log()` in `context.ts`)
5. `src/renderer/` — `renderer.ts` (interface with `onLog`), `compute-frame.ts`
   (`computeFrame()` pure function), `tty-renderer.ts` (TTY renderer using
   `node:tty` `WriteStream` methods, render loop, cursor strategy),
   `plain-renderer.ts` (plain renderer with immediate `onLog` output)
6. `src/storage.ts` — `AsyncLocalStorage` instance + `ContextStore` type.
   Type-only imports from this package (must come before `session.ts` since
   `session.ts` imports from it)
7. `src/session.ts` — internal `Session` class, `LogTaskOptions`,
   `SessionOptions`, `TaskOptions`, `Spinner`. Renderer stored as a property.
   Imports `storage` from `./storage.ts`. Not exported from the package
8. `src/context.ts` — module-level `logTask()` (with options overload), `log()`,
   `setCurrentTaskWarning()`, `setCurrentTaskSkipped()`,
   `setCurrentTaskTitle()`. Imports `Session` from `./session.ts` and `storage`
   from `./storage.ts`
9. `src/log-from-stream.ts` — stream piping with `AsyncIterable<string>` support
10. `src/run-command.ts` — `runCommand(command)` or
    `runCommand(title, command, options?)`, uses `logTask()` internally
11. `mod.ts` — public exports
12. Remove `test/placeholder.test.ts` — replaced by real tests
13. `test/task-node.test.ts`
14. `test/context.test.ts`
15. `test/renderer.test.ts`
16. `test/log-fold.test.ts`
17. `test/run-command.test.ts`
18. `readme/example-usage.ts` + `readme/README.md`
19. `deno task all` — validate

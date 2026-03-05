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

| Decision               | Choice                                                                                                                                                                                                                           |
| :--------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API style              | AsyncLocalStorage-based implicit context (primary) + explicit context passing (backup) + imperative begin/end. First `logTask()` auto-inits; `withLogFold()` optional for custom config                                          |
| Log tail               | Keep full log buffer, display last N lines in tail window. Print full log on error                                                                                                                                               |
| VT100 emulation        | Skip for now; design the log buffer so a VT100 parser can plug in later                                                                                                                                                          |
| Subprocess integration | `logFromStream()` accepts Node.js `Readable`, web `ReadableStream`, arrays, or `{ stdout, stderr }` objects (covers `node:child_process`, `Deno.Command`, `Bun.spawn`). `runCommand()` wraps `node:child_process` as convenience |
| Runtime                | Runtime-agnostic via `node:` built-in modules (`node:tty`, `node:process`, `node:async_hooks`, `node:child_process`). No Deno-specific APIs                                                                                      |
| Dependencies           | `@std/fmt/colors` + `node:` built-ins (zero fetched deps)                                                                                                                                                                        |
| Terminal control       | `node:tty` `WriteStream` methods (`cursorTo`, `moveCursor`, `clearLine`, `clearScreenDown`) instead of hand-written ANSI escapes. Only cursor hide/show requires raw ANSI                                                        |
| Unicode                | Unicode symbols only (`✓`, `✗`, `⚠`, `⊘`, `│`), no ASCII fallback. Running tasks use a configurable spinner (default: braille dots)                                                                                              |
| Colors                 | Buildkit-style: cyan for completed, red for errors, yellow for warnings, dim for skipped                                                                                                                                         |
| Exports                | Submodule exports in `deno.jsonc`                                                                                                                                                                                                |
| Concurrency            | Support multiple children running simultaneously under one parent                                                                                                                                                                |

## Architecture

```
src/
├── ansi.ts              # Cursor hide/show constants (only what node:tty lacks)
├── task-node.ts         # TaskNode data model, tree operations
├── storage.ts           # AsyncLocalStorage instance + ContextStore type (no imports from this package)
├── context.ts           # Module-level logTask/log/withLogFold (imports storage + log-fold)
├── log-from-stream.ts   # logFromStream — pipe streams into current task's log
├── log-fold.ts          # LogFold class — the public API (imports storage)
├── run-command.ts       # Optional subprocess wrapper (node:child_process)
├── renderer/
│   ├── renderer.ts      # Renderer interface
│   ├── compute-frame.ts # computeFrame pure function + FrameOptions
│   ├── tty-renderer.ts  # TtyRenderer (implements Renderer)
│   └── plain-renderer.ts # PlainRenderer (implements Renderer)
mod.ts                   # Public re-exports
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
- `TaskNode` interface: `id`, `title`, `status`, `parent`, `children[]`,
  `logLines[]`, `error`, `startedAt`, `finishedAt`
- `createTaskNode(title, parent?)` — factory, appends to parent's `children[]`
- `startTask()`, `succeedTask()`, `warnTask()`, `failTask(error?)`, `skipTask()`
  — lifecycle transitions
- `setTitle(node, title)` — update the node's display title in-place (renderer
  picks it up on the next tick)
- `appendLog(node, text)` — log accumulation (splits on `\n`, handles trailing
  newline)
- `tailLogLines(node, n)` — last N lines for the tail window
- `durationSec(node)` — elapsed seconds (uses `Date.now()` for running tasks)
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
`ContextStore` type. It has no imports from this package, breaking the circular
dependency between `context.ts` and `log-fold.ts`:

```typescript
import { AsyncLocalStorage } from "node:async_hooks";
import type { LogFold } from "./log-fold.ts";
import type { TaskNode } from "./task-node.ts";

type ContextStore = {
  logFold: LogFold;
  node: TaskNode | undefined;
};

export const storage = new AsyncLocalStorage<ContextStore>();
export type { ContextStore };
```

`src/context.ts` imports `storage` from `./storage.ts` and `LogFold` from
`./log-fold.ts`. `src/log-fold.ts` also imports `storage` from `./storage.ts`.
Neither imports from the other — the circular dependency is eliminated.

Module-level convenience functions that read from the AsyncLocalStorage store:

```typescript
/**
 * Create and run a task. If called inside an existing task, nests as a child.
 * If called at the top level (no active context), auto-initializes a LogFold
 * session with default options — the renderer starts when this task starts
 * and stops when this task completes.
 */
export async function logTask<T>(
  title: string,
  fn: () => Promise<T>,
): Promise<T>;

/**
 * Append log output to the current task. Splits on newlines — multi-line
 * strings produce multiple log entries. If called outside any task context,
 * falls back to process.stderr.write().
 */
export function log(text: string): void;

/**
 * Optional wrapper for custom LogFold options (tailLines, mode, output, etc).
 * Sets up a rendering session; any logTask() calls inside use this session.
 * Most users don't need this — the first logTask() auto-inits with defaults.
 *
 * withLogFold() creates a ContextStore with { logFold, node: undefined } and
 * starts the renderer immediately. When logTask() is called inside and finds
 * a store with no current node, it creates a root task under the existing
 * session instead of auto-initing a new one. The renderer stops when fn()
 * resolves or rejects.
 */
export async function withLogFold(
  options: LogFoldOptions,
  fn: () => Promise<void>,
): Promise<void>;
```

Design choices for "outside context" behavior:

| Function          | Outside context                                                               |
| :---------------- | :---------------------------------------------------------------------------- |
| `logTask()`       | Auto-inits a LogFold session with defaults. This task becomes a root task     |
| `log()`           | Falls back to `process.stderr.write(text)` — output is never lost             |
| `logFromStream()` | Falls back to piping lines to `process.stderr` — output is never lost         |
| `withLogFold()`   | Sets up a session with custom options. `logTask()` calls inside nest under it |

Sequential top-level `logTask()` calls (outside any context) each create their
own independent render session. Each session starts and stops its own renderer.
To unify multiple top-level tasks under one session, wrap them in
`withLogFold()`.

`logTask()` pushes a new `ContextStore` into AsyncLocalStorage before calling
`fn()`, so any nested `logTask()`/`log()` calls inside `fn()` auto-nest
correctly. This is the key mechanism for auto-detecting call hierarchy:

```typescript
import { LogFold } from "./log-fold.ts";
import { storage } from "./storage.ts";
import {
  createTaskNode,
  failTask,
  startTask,
  succeedTask,
} from "./task-node.ts";

export async function logTask(title, fn) {
  const store = storage.getStore();

  if (!store) {
    // Top-level call — auto-init a LogFold session with defaults
    const logFold = new LogFold();
    const root = createTaskNode(title);
    logFold.roots.push(root);
    startTask(root);
    logFold.renderer.start(logFold.roots);
    logFold.renderer.onTaskStart(root);

    try {
      const result = await storage.run({ logFold, node: root }, fn);
      succeedTask(root);
      return result;
    } catch (e) {
      failTask(root, e instanceof Error ? e : new Error(String(e)));
      throw e;
    } finally {
      logFold.renderer.onTaskEnd(root);
      logFold.renderer.stop();
    }
  }

  if (!store.node) {
    // Inside withLogFold() but no current task — create a root task under
    // the existing session (no new renderer, no auto-init)
    const { logFold } = store;
    const root = createTaskNode(title);
    logFold.roots.push(root);
    startTask(root);
    logFold.renderer.onTaskStart(root);

    try {
      const result = await storage.run({ logFold, node: root }, fn);
      succeedTask(root);
      return result;
    } catch (e) {
      failTask(root, e instanceof Error ? e : new Error(String(e)));
      throw e;
    } finally {
      logFold.renderer.onTaskEnd(root);
    }
  }

  // Nested call — create child under current context
  const { logFold, node: parent } = store;
  const child = createTaskNode(title, parent);
  startTask(child);
  logFold.renderer.onTaskStart(child);

  try {
    const result = await storage.run({ logFold, node: child }, fn);
    succeedTask(child);
    return result;
  } catch (e) {
    failTask(child, e instanceof Error ? e : new Error(String(e)));
    throw e;
  } finally {
    logFold.renderer.onTaskEnd(child);
  }
}
```

#### DX comparison — use cases

##### Use case 1 — simple sequential script (AsyncLocalStorage)

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

No `withLogFold()` needed — the outer `logTask("Build")` auto-initializes the
rendering session. No context objects passed anywhere. `install()` could itself
call `logTask()` and `log()` and everything auto-nests.

##### Use case 2 — deep nesting across module boundaries (AsyncLocalStorage)

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

##### Use case 5 — explicit context passing (backup API)

For testing, or when AsyncLocalStorage doesn't suit the use case:

```typescript
import { LogFold } from "@hugojosefson/log-fold";

const lf = new LogFold({ mode: "plain", output: captureStream });
await lf.run("Test suite", async (root) => {
  root.log("starting...");
  await root.task("Sub-test", async (t) => {
    t.log("sub-testing...");
  });
});
```

##### Use case 6 — imperative API (long-running/event-driven)

```typescript
import { LogFold } from "@hugojosefson/log-fold";

const lf = new LogFold();
lf.start();
try {
  const server = lf.begin("Server");
  server.log("listening on :8080");

  // Later, in an event handler:
  const req = server.begin("Request /api/users");
  try {
    req.log("processing...");
    // ... do work ...
    req.succeed();
  } catch (e) {
    req.fail(e instanceof Error ? e : new Error(String(e)));
  }

  // Eventually:
  server.succeed();
} finally {
  lf.stop();
}
```

##### Use case 7 — subprocess with auto-nesting (AsyncLocalStorage + runCommand)

```typescript
import { logTask } from "@hugojosefson/log-fold";
import { runCommand } from "@hugojosefson/log-fold/run-command";

await logTask("Build", async () => {
  await runCommand("npm install", ["npm", "install"]);
  // runCommand internally calls logTask() — auto-nests under "Build"
  await runCommand("tsc", ["npx", "tsc", "--build"]);
});
```

When AsyncLocalStorage isn't available, pass a `TaskContext` as the first arg:

```typescript
const lf = new LogFold();
await lf.run("Build", async (ctx) => {
  await runCommand(ctx, "npm install", ["npm", "install"]);
  await runCommand(ctx, "tsc", ["npx", "tsc", "--build"]);
});
```

##### Use case 8 — error with full log dump

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

##### Use case 9 — wrapping third-party code

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

##### Use case 10 — custom config via withLogFold

Use `withLogFold()` when you need non-default renderer options:

```typescript
import { log, logTask, withLogFold } from "@hugojosefson/log-fold";

await withLogFold(
  { tailLines: 10, headerText: "Deploying" },
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

Without `withLogFold()`, the first `logTask()` auto-initializes with defaults.
`withLogFold()` is only needed for custom `tailLines`, `mode`, `output`,
`headerText`, etc.

##### Use case 11 — mixed AsyncLocalStorage and explicit in the same tree

Both APIs share the same underlying `LogFold` instance and task tree:

```typescript
import { log, LogFold, logTask } from "@hugojosefson/log-fold";

const lf = new LogFold();
await lf.run("Pipeline", async (root) => {
  // Explicit context
  await root.task("Step 1", async (t) => {
    t.log("explicit...");
  });

  // AsyncLocalStorage — works because run() sets up the AsyncLocalStorage store
  await logTask("Step 2", async () => {
    log("implicit...");
  });
});
```

This works because `lf.run()` both passes the explicit `root` context AND sets
up the AsyncLocalStorage store. The module-level `logTask()` reads from
AsyncLocalStorage; `root.task()` uses the explicit reference. Both create nodes
in the same tree.

##### Use case 12 — BYO subprocess with `logFromStream` (Node.js `child_process`)

When you already have your own `ChildProcess` and want to pipe its output into a
log-fold task, use `logFromStream()`. It accepts the child process object
directly — it picks up `.stdout` and `.stderr` automatically:

```typescript
import { spawn } from "node:child_process";
import { logFromStream, logTask } from "@hugojosefson/log-fold";

await logTask("My process", async () => {
  const child = spawn("my-tool", ["--flag"]);
  await logFromStream(child);
});
```

##### Use case 13 — BYO subprocess with `logFromStream` (Deno `Command`)

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

##### Use case 14 — BYO subprocess with `logFromStream` (Bun `spawn`)

```typescript
import { logFromStream, logTask } from "@hugojosefson/log-fold";

await logTask("Build", async () => {
  const child = Bun.spawn(["npm", "install"]);
  await logFromStream(child);
});
```

##### Use case 15 — piping a fetch response body

`logFromStream()` also accepts a single `ReadableStream`:

```typescript
import { logFromStream, logTask } from "@hugojosefson/log-fold";

await logTask("Fetch logs", async () => {
  const response = await fetch("https://example.com/logs");
  await logFromStream(response.body!);
});
```

##### Use case 16 — manual stream wiring (no `logFromStream`)

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

The renderer receives the `roots: TaskNode[]` reference on `start()` and reads
the tree directly on each render tick. The `onTaskStart`/`onTaskEnd` callbacks
serve as dirty-flag triggers, not data carriers. The `onLog` callback is used by
PlainRenderer to write log lines immediately as they arrive; TtyRenderer ignores
it (new log output is picked up on the next tick-based render frame).

**Wiring**: every code path that appends log output must call
`renderer.onLog(node, line)` after `appendLog()`. This means:

- `log()` in `context.ts` calls `logFold.renderer.onLog(node, line)` for each
  line after splitting and appending
- `TaskContext.log()` in `log-fold.ts` does the same via its renderer reference
- `TaskHandle.log()` in `log-fold.ts` does the same

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
`string[]` so it's testable without a terminal. `options` includes `tailLines`,
`termWidth`, `termHeight`, `headerText`, `spinner`, and `now` (current
timestamp, so tests can pass a fixed value and get deterministic spinner
frames).

Each render cycle produces a list of output lines:

###### Step 1 — header line (optional)

Only rendered when `headerText` is set. If `headerText` is not set, the header
line is omitted entirely — the frame starts directly with task lines.

```
[+] Building 12.3s (3/8)
[+] Building 12.3s (8/8) FINISHED
```

Shows elapsed wall time since `start()` was called, completed/total task count
(all nodes in tree, not just roots), and "FINISHED" when everything is done.

###### Step 2 — task lines (recursive)

Walk the task tree depth-first. For each node at a given `depth`:

| Status    | Rendering                                            | Color              |
| :-------- | :--------------------------------------------------- | :----------------- |
| `success` | `✓ Task Name  1.2s` (single line, children hidden)   | dim cyan           |
| `warning` | `⚠ Task Name  1.2s` (single line, children hidden)   | yellow             |
| `fail`    | `✗ Task Name  ERROR  1.2s` (single line)             | red                |
| `running` | `<frame> Task Name  1.2s` then recurse into children | default foreground |
| `skipped` | `⊘ Task Name` (single line, no duration)             | dim                |
| `pending` | not shown                                            | —                  |

`<frame>` is the current spinner frame (cycled using
`frames[Math.floor(Date.now() / interval) % frames.length]`). The default
spinner is the braille dots pattern from `cli-spinners`.

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
2. Rank by activity: `logBytes + displayCount * 50` (where `displayCount` is
   renderer-internal state stored in a `Map<string, number>` keyed by task ID —
   tracks how many frames this node's tail has been shown, provides "stickiness"
   so the display doesn't thrash between different tasks' log windows)
3. Calculate available viewport lines:
   `free = termHeight - headerLines -
   taskLines - 2`
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

`output.isTTY` at startup → selects TTY or plain renderer.

#### Plain renderer — sequential text output

For piped / non-TTY / CI output. No cursor movement, append-only.

- On task start: `[Task Name] => started` (always prefixed with task name)
- On log append: `[Task Name] line content`
- On task end (success): `[Task Name] ✓ 1.2s`
- On task end (warning): `[Task Name] ⚠ 1.2s`
- On task end (fail): `[Task Name] ✗ ERROR  1.2s`, then dump full log
- On task end (skipped): `[Task Name] ⊘ skipped`

Always prefix each line with the task name (like docker compose's
`service | line` pattern). This keeps output unambiguous when concurrent tasks
interleave:

```
[Compile] => started
[Test] => started
[Compile] tsc --build
[Test] running test suite...
[Compile] ✓ 1.2s
[Test] 5 tests passed
[Test] ✓ 0.8s
```

### Layer 5: `src/log-fold.ts` — public API

The `LogFold` class owns the task tree and renderer. The renderer is stored as a
property (`this.renderer`) so that `context.ts` can access it via
`logFold.renderer` when the auto-init path in `logTask()` creates a `LogFold`
instance. Both `context.ts` and `log-fold.ts` import `storage` from
`./storage.ts`; neither imports from the other.

#### Constructor options

```typescript
import type { WriteStream } from "node:tty";

/** Spinner definition compatible with `cli-spinners` by sindresorhus. */
type Spinner = {
  /** Frame interval in milliseconds. */
  interval: number;
  /** Animation frames, cycled on each render tick. */
  frames: string[];
};

type LogFoldOptions = {
  /** Force TTY or plain mode. Default: "auto" (detect via isTTY). */
  mode?: "tty" | "plain" | "auto";
  /** Number of log tail lines to show per task. Default: 6. */
  tailLines?: number;
  /** Render tick interval in ms. Default: 150. */
  tickInterval?: number;
  /**
   * Output stream. Default: process.stderr.
   * When mode is "tty", must be a tty.WriteStream (for cursor methods).
   * When mode is "plain", any Writable with write() works.
   */
  output?: WriteStream | { write(s: string): boolean };
  /** Header text (e.g. "Building", "Deploying"). Default: none (no header line). */
  headerText?: string;
  /**
   * Spinner for running tasks. Default: dots spinner
   * (`{ interval: 80, frames: ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"] }`).
   * Pass any object matching `{ interval: number; frames: string[] }`,
   * e.g. from the `cli-spinners` package.
   */
  spinner?: Spinner;
};
```

#### `run()` method — explicit context entry point

Used by the explicit context API and internally by `withLogFold()`. Accepts a
title for the root task, which becomes a visible node in the task tree (matching
how `logTask()` works at the top level).

```typescript
import { storage } from "./storage.ts";
import { TtyRenderer } from "./renderer/tty-renderer.ts";
import { PlainRenderer } from "./renderer/plain-renderer.ts";
import type { TaskContext } from "./log-fold.ts";
import {
  createTaskNode,
  failTask,
  startTask,
  succeedTask,
} from "./task-node.ts";

class LogFold {
  renderer: Renderer;

  async run<T>(
    title: string,
    fn: (root: TaskContext) => Promise<T>,
  ): Promise<T> {
    this.renderer = this.options.mode === "plain"
      ? new PlainRenderer(this.options)
      : new TtyRenderer(this.options);

    const root = createTaskNode(title);
    this.roots.push(root);
    startTask(root);
    this.renderer.start(this.roots);
    this.renderer.onTaskStart(root);

    const rootCtx = new TaskContextImpl(root, this, this.renderer);

    try {
      // Set up AsyncLocalStorage so module-level logTask()/log() work inside fn()
      const result = await storage.run(
        { logFold: this, node: root },
        () => fn(rootCtx),
      );
      succeedTask(root);
      return result;
    } catch (e) {
      failTask(root, e instanceof Error ? e : new Error(String(e)));
      throw e;
    } finally {
      this.renderer.onTaskEnd(root);
      this.renderer.stop();
    }
  }
}
```

#### `TaskContext` — explicit context (passed through callbacks)

```typescript
type TaskContext = {
  /** Create and run a sub-task. Lifecycle is automatic. */
  task<T>(title: string, fn: (ctx: TaskContext) => Promise<T>): Promise<T>;
  /** Append log output. Splits on newlines. */
  log(text: string): void;
  /** Update the task's display title. */
  setTitle(title: string): void;
  /** The underlying TaskNode. */
  readonly node: TaskNode;
};
```

`task()` creates a child node, starts it, runs `fn` inside a new
AsyncLocalStorage scope (so module-level functions also work inside explicit
callbacks), and transitions to success/fail on completion.

#### Imperative API

```typescript
class LogFold {
  /** Start the render loop (for imperative usage). */
  start(): void;
  /** Create and start a root-level task (returns a handle). */
  begin(title: string): TaskHandle;
  /** Stop the render loop, final render, dump errors. */
  stop(): void;
}
```

`begin(title)` returns a `TaskHandle`:

```typescript
type TaskHandle = {
  /** Create and start a sub-task (immediately running). */
  begin(title: string): TaskHandle;
  /** Append log output. Splits on newlines. */
  log(text: string): void;
  /** Pipe one or more streams into this task's log. */
  logFromStream(input: LogFromStreamInput): Promise<void>;
  /** Mark as successfully completed. */
  succeed(): void;
  /** Mark as completed with warnings. */
  warn(): void;
  /** Mark as failed. */
  fail(error?: Error): void;
  /** Mark as skipped (cached, no-op). */
  skip(): void;
  /** Update the task's display title. */
  setTitle(title: string): void;
  /** The underlying TaskNode. */
  readonly node: TaskNode;
};
```

`begin()` creates and starts the node immediately. No AsyncLocalStorage involved
— the imperative API is fully explicit.

#### Error handling

- **Callback/AsyncLocalStorage API**: thrown error → task fails, error stored on
  node. Error propagates up through the callback chain. `run()` catches it,
  calls `renderer.stop()`, then rethrows.
- **Imperative API**: user calls `fail(error?)` explicitly.
- **On `stop()`**: renderer dumps full `logLines[]` buffer for every failed
  task, printed after the final frame. This output is permanent (not
  cursor-overwritten).
- **Top-level `logTask()` errors**: the error propagates after the renderer
  stops and the full log is dumped. Users should wrap top-level `logTask()` in
  try/catch if they want to handle errors gracefully, or let it crash with the
  full log visible.

#### Children of a failed parent

In the callback API, nesting guarantees children complete before the parent's
callback returns. If a child throws, the parent's callback also throws (unless
caught), so both fail naturally.

In the imperative API: calling `fail()` on a parent that has running children
auto-fails those children. Their status becomes `"fail"` with a synthetic
`Error("canceled: parent task failed")`.

### Layer 6: `src/log-from-stream.ts` — stream-to-log piping

Accepts a variety of stream shapes and pipes their content line-by-line into the
current task's log via `log()`. Resolves when all streams have ended.

Exported from the default entry point (`mod.ts` / `"."`), not from the
`run-command` submodule. `runCommand` imports and uses `logFromStream`
internally.

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
 * Resolves when all streams have ended.
 *
 * For AsyncIterable<string>, each yielded string is treated as a log line
 * (no further line splitting).
 */
export async function logFromStream(input: LogFromStreamInput): Promise<void>;
```

The `StreamPair` shape covers subprocess objects from all three runtimes:

| Runtime | API                          | Passed as                                                                                  |
| :------ | :--------------------------- | :----------------------------------------------------------------------------------------- |
| Node.js | `child_process.spawn()`      | `child` — has `.stdout: Readable \| null`, `.stderr: Readable \| null`                     |
| Deno    | `new Deno.Command().spawn()` | `child` — has `.stdout: ReadableStream<Uint8Array>`, `.stderr: ReadableStream<Uint8Array>` |
| Bun     | `Bun.spawn()`                | `child` — has `.stdout: ReadableStream<Uint8Array>`, `.stderr: ReadableStream<Uint8Array>` |

#### Input detection logic

1. Is it an `Array`? → process each element concurrently via `Promise.all`
2. Has `Symbol.asyncIterator`? → `AsyncIterable<string>`, consume with
   `for await (const line of input) { log(line); }`
3. Has `.getReader()` method? → web `ReadableStream`, convert to Node.js
   `Readable` via `Readable.fromWeb()`, then use `node:readline`
4. Has `.pipe()` method? → Node.js `Readable`, use `node:readline` directly
5. Has `.stdout` or `.stderr` property (and isn't itself a stream)? →
   `StreamPair`, extract non-null streams, process concurrently via
   `Promise.all`

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
  /** Whether to throw on non-zero exit code. Default: true. */
  throwOnError?: boolean;
};

type RunCommandResult = {
  code: number | undefined;
  signal: string | undefined;
};

/**
 * Run a command as a sub-task, piping stdout+stderr to the task's log.
 * Auto-nests under the current task context (via AsyncLocalStorage).
 */
export async function runCommand(
  title: string,
  command: string[],
  options?: RunCommandOptions,
): Promise<RunCommandResult>;

/**
 * Explicit-context overload — use when AsyncLocalStorage isn't available.
 */
export async function runCommand(
  ctx: TaskContext,
  title: string,
  command: string[],
  options?: RunCommandOptions,
): Promise<RunCommandResult>;
```

Implementation:

1. Overload dispatch: if first argument is a `TaskContext` (has a `.node`
   property), use `ctx.task(title, ...)` (explicit); otherwise use
   `logTask(title, ...)` (AsyncLocalStorage)
2. Spawns via
   `spawn(command[0], command.slice(1), { ...options, stdio: ["ignore", "pipe", "pipe"] })`
3. Calls `logFromStream(child)` to pipe stdout+stderr to the task's log
4. Awaits process exit: wraps the `'close'` event in a Promise, which resolves
   with `{ code, signal }` after all stdio has ended and the process has exited
5. Non-zero exit + `throwOnError !== false` → throws `Error(\`Command failed
   with exit code
   ${code}\`)`(auto-fails the task via the enclosing`logTask`catch). When`throwOnError`is`false`,
   non-zero exit returns the result without throwing or failing the task.

### Layer 8: `mod.ts` — public exports

```typescript
// Core class + types
export { LogFold } from "./src/log-fold.ts";
export type {
  LogFoldOptions,
  TaskContext,
  TaskHandle,
} from "./src/log-fold.ts";

// AsyncLocalStorage convenience functions
export { log, logTask, withLogFold } from "./src/context.ts";

// Stream piping
export { logFromStream } from "./src/log-from-stream.ts";
export type {
  AnyReadable,
  LogFromStreamInput,
  StreamPair,
} from "./src/log-from-stream.ts";

// Types
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
- `startTask`: status → running, startedAt set
- `succeedTask`: status → success, finishedAt set
- `warnTask`: status → warning, finishedAt set
- `failTask`: status → fail, error stored, finishedAt set
- `skipTask`: status → skipped, finishedAt set
- `setTitle`: updates node title in-place
- `appendLog`: splits on `\n`, handles trailing newline
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
- Multiple concurrent leaves → competitive tail allocation by activity
- Viewport overflow → completed tasks dropped, running tasks preserved
- No tasks → only header line
- Deeply nested → correct indentation at each level

#### `test/context.test.ts` — AsyncLocalStorage context tests

- `logTask()` outside any context auto-inits a session
- `log()` outside any context falls back to `process.stderr.write()`
- `logTask()` inside `withLogFold()` creates child of root
- Nested `logTask()` calls create correct hierarchy
- `Promise.all` with multiple `logTask()` calls → separate branches
- `log()` goes to the correct task in concurrent context
- Mixed AsyncLocalStorage and explicit context in the same tree

#### `test/log-fold.test.ts` — integration tests

- Callback API: sequential tasks run and complete
- Callback API: concurrent tasks via `Promise.all`
- Callback API: error → task fails, error captured, full log available
- Callback API: nested error → propagates to parent
- Imperative API: begin/log/succeed lifecycle
- Imperative API: begin/log/fail lifecycle
- Imperative API: concurrent begins
- Imperative API: fail parent with running children → children auto-fail

Tests use a mock output stream.

#### `test/run-command.test.ts` — subprocess tests

- Run `echo hello` → log contains "hello"
- Run a failing command → task fails
- Stdout and stderr both captured
- AsyncLocalStorage version auto-nests under current task

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

Update template with: what log-fold does, install instructions,
AsyncLocalStorage API example, explicit context example, imperative example,
concurrent tasks example, subprocess wrapper example, options reference.

## VT100 extension point

The log buffer stores plain text lines (`string[]`). To add VT100 emulation:

1. Create `src/vt100.ts` with `VT100Terminal` (2D character grid)
2. Add optional `term?: VT100Terminal` to `TaskNode`
3. When present, `appendLog()` writes raw bytes to the VT100 emulator
4. `tailLogLines()` reads the last N rows from the VT100 grid
5. Renderer calls `tailLogLines()` — no changes needed

`tailLogLines()` is the abstraction seam.

## `deno.jsonc` changes

Add `@std/fmt` to imports. Update exports for submodules. Add `nodeModulesDir`
so `node:` built-in module resolution works cleanly in Deno:

```jsonc
{
  "imports": {
    "@std/assert": "jsr:@std/assert@^1.0.19",
    "@std/fmt": "jsr:@std/fmt@^1.0.0",
    "@std/path": "jsr:@std/path@^1.1.4"
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

## Cancellation (future, not v1)

Out of scope for initial implementation. The user manages their own
`AbortController`. Future extension point: `withLogFold()` and `logTask()` could
accept `{ signal: AbortSignal }` to propagate cancellation through the tree.

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

## Implementation order

1. `deno.jsonc` — add `@std/fmt`, update exports, add `./run-command` submodule
   (do this first so `@std/fmt` is available for all subsequent steps)
2. Remove `src/cli.ts` — unused empty shebang script, not part of the library
3. `src/ansi.ts` — rewrite: keep only `hideCursor`/`showCursor` constants
4. `src/task-node.ts` — update: add `warnTask`, `skipTask`, `setTitle`,
   `findRunningLeaves`, `countTasks`, `logBytes`; remove `findDeepestRunning`
   and `appendLogLines` (fold splitting logic into `appendLog`)
5. `src/renderer/` — `renderer.ts` (interface with `onLog`), `compute-frame.ts`
   (`computeFrame()` pure function), `tty-renderer.ts` (TTY renderer using
   `node:tty` `WriteStream` methods, render loop, cursor strategy),
   `plain-renderer.ts` (plain renderer with immediate `onLog` output)
6. `src/log-from-stream.ts` — stream piping with `AsyncIterable<string>` support
7. `src/log-fold.ts` — `LogFold` class, `TaskContext`, `TaskHandle` (with
   `logFromStream`), `LogFoldOptions`, `Spinner`. Renderer stored as a property
   on `LogFold` so context.ts can access it via `logFold.renderer`. Imports
   `storage` from `./storage.ts`
8. `src/storage.ts` — `AsyncLocalStorage` instance + `ContextStore` type. No
   imports from this package
9. `src/context.ts` — module-level `logTask<T>()`, `withLogFold()`, `log()`.
   Imports `LogFold` from `./log-fold.ts` and `storage` from `./storage.ts`
10. `src/run-command.ts` — overloaded `runCommand` (optional `TaskContext` first
    arg), `RunCommandOptions` with `throwOnError`
11. `mod.ts` — public exports
12. Remove `test/placeholder.test.ts` — replaced by real tests
13. `test/task-node.test.ts`
14. `test/context.test.ts`
15. `test/renderer.test.ts`
16. `test/log-fold.test.ts`
17. `test/run-command.test.ts`
18. `readme/example-usage.ts` + `readme/README.md`
19. `deno task all` — validate

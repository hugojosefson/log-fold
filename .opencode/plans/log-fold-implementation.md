# log-fold implementation plan

## Goal

Build `@hugojosefson/log-fold` — a Deno-first library that renders a "docker
buildx"-style collapsing task tree to the terminal. Tasks collapse to a single
line when complete; running tasks expand to show sub-tasks and a tail window of
subprocess output. Multiple tasks can run concurrently. On error, the full log
is dumped.

## Design decisions (confirmed)

| Decision               | Choice                                                                                                        |
| :--------------------- | :------------------------------------------------------------------------------------------------------------ |
| API style              | AsyncLocalStorage-based implicit context (primary) + explicit context passing (backup) + imperative begin/end |
| Log tail               | Keep full log buffer, display last N lines in tail window. Print full log on error                            |
| VT100 emulation        | Skip for now; design the log buffer so a VT100 parser can plug in later                                       |
| Subprocess integration | Accept log lines as core API; optional convenience wrapper for `Deno.Command`                                 |
| Runtime                | Deno-first (uses `node:async_hooks`, `Deno.consoleSize`, `Deno.stdout`); also works on Node.js and Bun        |
| Dependencies           | `@std/fmt/colors` + `node:async_hooks` (built-in, zero fetched deps)                                          |
| Unicode                | Unicode symbols only (`✓`, `✗`, `⏳`, `│`), no ASCII fallback                                                 |
| Colors                 | Buildkit-style: cyan for completed, red for errors                                                            |
| Exports                | Submodule exports in `deno.jsonc`                                                                             |
| Concurrency            | Support multiple children running simultaneously under one parent                                             |

## Architecture

```
src/
├── ansi.ts          # ANSI escape constants + writeSync helper
├── task-node.ts     # TaskNode data model, tree operations
├── context.ts       # AsyncLocalStorage-based implicit task context
├── renderer.ts      # Renderer interface + TTY + Plain implementations
├── log-fold.ts      # LogFold class — the public API
├── run-command.ts   # Optional Deno.Command convenience wrapper
└── cli.ts           # CLI entry point (existing scaffold)
mod.ts               # Public re-exports
```

## Detailed design

### Layer 1: `src/ansi.ts` — ANSI escape utilities

Already written. Contains:

- `cursorUp(n)`, `cursorColumn0`, `eraseDown`, `eraseLine`
- `hideCursor`, `showCursor`
- `writeSync(s, writer)` — writes string as bytes to a `{ writeSync }` target

Minimal — ~8 constants. No external deps.

### Layer 2: `src/task-node.ts` — task tree data model

Already partially written. Core types and operations:

- `TaskStatus`: `"pending" | "running" | "success" | "fail"`
- `TaskNode` interface: `id`, `title`, `status`, `parent`, `children[]`,
  `logLines[]`, `error`, `startedAt`, `finishedAt`
- `createTaskNode(title, parent?)` — factory, appends to parent's `children[]`
- `startTask()`, `succeedTask()`, `failTask(error?)` — lifecycle transitions
- `appendLog()`, `appendLogLines(text)` — log accumulation (splits on `\n`)
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

### Layer 3: `src/context.ts` — AsyncLocalStorage implicit context

Uses `AsyncLocalStorage` from `node:async_hooks` to track the "current task"
without requiring developers to pass context objects through function calls.

```typescript
import { AsyncLocalStorage } from "node:async_hooks";

interface ContextStore {
  logFold: LogFold;
  node: TaskNode;
}

const storage = new AsyncLocalStorage<ContextStore>();
```

Module-level convenience functions that read from the ALS store:

```typescript
/**
 * Create and run a sub-task under the current context.
 * If called outside any run() context, throws.
 */
export async function task(
  title: string,
  fn: (ctx: TaskContext) => Promise<void>,
): Promise<void>;

/**
 * Append a log line to the current task.
 * If called outside any run() context, no-op (silent discard).
 */
export function log(line: string): void;

/**
 * Append multiple log lines to the current task.
 * If called outside any run() context, no-op (silent discard).
 */
export function logLines(text: string): void;
```

Design choices for "outside context" behavior:

| Function     | Outside context                                                                                  |
| :----------- | :----------------------------------------------------------------------------------------------- |
| `task()`     | Throws — creating a task with no parent is a programming error                                   |
| `log()`      | No-op — allows library code to sprinkle `log()` calls without forcing callers to set up log-fold |
| `logLines()` | No-op — same rationale as `log()`                                                                |

`task()` pushes a new `ContextStore` into ALS before calling `fn()`, so any
nested `task()`/`log()` calls inside `fn()` auto-nest correctly. This is the key
mechanism for auto-detecting call hierarchy:

```typescript
export async function task(title, fn) {
  const store = storage.getStore();
  if (!store) throw new Error("task() called outside of run()");
  const { logFold, node: parent } = store;

  const child = createTaskNode(title, parent);
  startTask(child);
  logFold.renderer.onTaskStart(child);

  try {
    await storage.run({ logFold, node: child }, () => fn(childCtx));
    succeedTask(child);
  } catch (e) {
    failTask(child, e instanceof Error ? e : new Error(String(e)));
    throw e;
  } finally {
    logFold.renderer.onTaskEnd(child);
  }
}
```

#### DX comparison — use cases

**Use case 1 — simple sequential script (ALS)**

```typescript
import { log, run, task } from "@hugojosefson/log-fold";

await run(async () => {
  await task("Install", async () => {
    log("npm install...");
    await install();
  });
  await task("Build", async () => {
    log("tsc --build");
  });
});
```

No context objects passed anywhere. `install()` could itself call `task()` and
`log()` and everything auto-nests.

**Use case 2 — deep nesting across module boundaries (ALS)**

```typescript
// build.ts
import { log, task } from "@hugojosefson/log-fold";

export async function build() {
  await task("Compile", async () => {
    log("compiling...");
    await compileFiles(); // auto-nests under "Compile"
  });
}

// compile.ts — only imports log-fold, no context threading
import { log, task } from "@hugojosefson/log-fold";

export async function compileFiles() {
  await task("Parse", async () => {
    log("parsing...");
  });
  await task("Emit", async () => {
    log("emitting...");
  });
}
```

**Use case 3 — concurrent tasks**

```typescript
import { log, run, task } from "@hugojosefson/log-fold";

await run(async () => {
  await task("Install", async () => {/* ... */});

  await Promise.all([
    task("Compile", async () => {
      log("tsc --build");
    }),
    task("Lint", async () => {
      log("eslint src/");
    }),
  ]);
});
```

Each branch of `Promise.all` has its own async context, so `log()` calls inside
each go to the right task. AsyncLocalStorage handles this correctly.

**Use case 4 — library code that optionally logs**

```typescript
// db.ts — works whether or not log-fold is active
import { log } from "@hugojosefson/log-fold";

export async function migrate() {
  log("running migrations..."); // no-op if no active context
  await runMigrations();
  log("migrations complete");
}
```

**Use case 5 — explicit context passing (backup API)**

For testing, or when ALS doesn't suit the use case:

```typescript
import { LogFold } from "@hugojosefson/log-fold";

const lf = new LogFold({ mode: "plain", output: captureStream });
await lf.run(async (root) => {
  await root.task("Test", async (t) => {
    t.log("testing...");
    await t.task("Sub-test", async (sub) => {
      sub.log("sub-testing...");
    });
  });
});
```

**Use case 6 — imperative API (long-running/event-driven)**

```typescript
import { LogFold } from "@hugojosefson/log-fold";

const lf = new LogFold();
lf.start();

const server = lf.begin("Server");
server.log("listening on :8080");

// Later, in an event handler:
const req = server.begin("Request /api/users");
req.log("processing...");
req.succeed();

// Eventually:
server.succeed();
lf.stop();
```

**Use case 7 — subprocess with auto-nesting (ALS + runCommand)**

```typescript
import { run, task } from "@hugojosefson/log-fold";
import { runCommand } from "@hugojosefson/log-fold/run-command";

await run(async () => {
  await task("Build", async () => {
    await runCommand("npm install", ["npm", "install"]);
    // runCommand internally calls task() — auto-nests under "Build"
    await runCommand("tsc", ["npx", "tsc", "--build"]);
  });
});
```

**Use case 8 — error with full log dump**

```typescript
await run(async () => {
  await task("Build", async () => {
    log("step 1...");
    log("step 2...");
    // ... 200 more log lines ...
    throw new Error("compilation failed");
    // → "Build" marked as fail
    // → on stop(), all 202 lines dumped to output
    // → error propagates to run(), which stops renderer then rethrows
  });
});
```

**Use case 9 — wrapping third-party code**

```typescript
await run(async () => {
  await task("Database migration", async () => {
    // Third-party code doesn't call log() — that's fine.
    // Task shows as running with a timer, no log tail.
    await thirdPartyMigrate();
  });
});
```

**Use case 10 — mixed ALS and explicit in the same tree**

Both APIs share the same underlying `LogFold` instance and task tree. You can
mix them:

```typescript
const lf = new LogFold();
await lf.run(async (root) => {
  // Explicit context
  await root.task("Step 1", async (t) => {
    t.log("explicit...");
  });

  // ALS — works because run() sets up the ALS store
  await task("Step 2", async () => {
    log("implicit...");
  });
});
```

This works because `lf.run()` both passes the explicit `root` context AND sets
up the ALS store. The module-level `task()` reads from ALS; `root.task()` uses
the explicit reference. Both create nodes in the same tree.

### Layer 4: `src/renderer.ts` — rendering

Two implementations behind a common interface.

#### Renderer interface

```typescript
interface Renderer {
  /** Called when a task starts. */
  onTaskStart(node: TaskNode): void;
  /** Called when a task completes (success or fail). */
  onTaskEnd(node: TaskNode): void;
  /** Called when log lines are appended to a task. */
  onLogAppend(node: TaskNode): void;
  /** Start the render loop. */
  start(roots: TaskNode[]): void;
  /** Stop the render loop, render final state, dump error logs. */
  stop(): void;
}
```

The renderer receives the `roots: TaskNode[]` reference on `start()` and reads
the tree directly on each render tick. The
`onTaskStart`/`onTaskEnd`/`onLogAppend` callbacks serve as dirty-flag triggers,
not data carriers.

#### TTY renderer — frame-based re-render

##### Render loop

- **Tick interval**: 150ms (configurable)
- **Rate limit**: 100ms minimum between renders
- **Dirty flag**: set by `onTask*`/`onLogAppend`; renders also happen on tick
  (so duration timers update even without new events)
- On `stop()`: one final frame with no height limit, then dump full log for any
  failed tasks

##### Frame computation

Extracted into a pure function `computeFrame(roots, options)` returning
`string[]` so it's testable without a terminal.

Each render cycle produces a list of output lines:

**Step 1 — Header line**

```
[+] Building 12.3s (3/8)
[+] Building 12.3s (8/8) FINISHED
```

Shows elapsed wall time since `start()` was called, completed/total task count
(all nodes in tree, not just roots), and "FINISHED" when everything is done.

**Step 2 — Task lines (recursive)**

Walk the task tree depth-first. For each node at a given `depth`:

| Status    | Rendering                                          | Color              |
| :-------- | :------------------------------------------------- | :----------------- |
| `success` | `✓ Task Name  1.2s` (single line, children hidden) | dim cyan           |
| `fail`    | `✗ Task Name  ERROR  1.2s` (single line)           | red                |
| `running` | `⏳ Task Name  1.2s` then recurse into children    | default foreground |
| `pending` | not shown                                          | —                  |

Indentation: each depth level adds 2 spaces of indent.

With concurrent tasks, multiple children of a running parent can be `running`
simultaneously. Each running child is shown expanded (its own line + its
children). Completed siblings are shown collapsed. This is exactly what buildkit
does — all started jobs appear; running ones get expanded subtrees.

**Step 3 — Log tail windows (competitive allocation)**

Following buildkit's `setupTerminals()` approach:

1. Collect all running leaves (nodes with `status === "running"`, no running
   children, and `logLines.length > 0`)
2. Rank by activity: `logBytes + displayCount * 50` (where `displayCount` tracks
   how many frames this node's tail has been shown — provides "stickiness" so
   the display doesn't thrash between different tasks' log windows)
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

**Step 4 — Viewport fitting**

If the total frame exceeds terminal height:

1. First, reduce tail window heights (fewer log lines shown)
2. If still too tall, drop completed tasks starting from the oldest
3. Never drop running tasks — they are always visible
4. If a running task was above the viewport cut, swap it in by removing a
   completed task from the visible portion (buildkit's `wrapHeight` algorithm)

##### Cursor strategy

1. Move cursor up by `previousLineCount` lines, move to column 0
2. Hide cursor
3. Print all lines of the new frame (each line = `eraseLine` + content + `\n`)
4. If new frame is shorter: blank leftover lines with `eraseLine` + `\n`, then
   cursor up by the difference
5. Track `lineCount` for next cycle
6. Show cursor

##### First render

On the first call, `previousLineCount` is 0, so no cursor-up. The `repeated`
flag prevents moving past the origin.

##### Terminal resize

Poll `Deno.consoleSize()` at each render tick. No SIGWINCH handler needed.

##### Non-TTY detection

`Deno.stdout.isTerminal()` at startup → selects TTY or plain renderer.

#### Plain renderer — sequential text output

For piped / non-TTY / CI output. No cursor movement, append-only.

- On task start: `=> Task Name` (indented by depth)
- On log append: `line content` (indented by depth + 3 spaces)
- On task end (success): `✓ Task Name  1.2s` (indented by depth)
- On task end (fail): `✗ Task Name  ERROR  1.2s`, then dump full log

For concurrent tasks in plain mode: prefix each line with the task name to
identify which task produced it (like docker compose's `service | line`
pattern):

```
[Compile] tsc --build
[Test] running test suite...
[Compile] ✓ done  1.2s
[Test] 5 tests passed
[Test] ✓ done  0.8s
```

Only use the prefix when multiple tasks are running concurrently at the same
depth. When only one task is active, omit the prefix for cleaner output.

### Layer 5: `src/log-fold.ts` — public API

The `LogFold` class owns the task tree and renderer.

#### Constructor options

```typescript
interface LogFoldOptions {
  /** Force TTY or plain mode. Default: "auto" (detect). */
  mode?: "tty" | "plain" | "auto";
  /** Number of log tail lines to show per task. Default: 6. */
  tailLines?: number;
  /** Render tick interval in ms. Default: 150. */
  tickInterval?: number;
  /** Output stream. Default: Deno.stdout. */
  output?: { writeSync(p: Uint8Array): number };
  /** Header text (e.g. "Building", "Deploying"). Default: "Building". */
  headerText?: string;
}
```

#### `run()` method — the primary entry point

Used by both the ALS convenience functions and the explicit context API.

```typescript
class LogFold {
  async run(fn: (root: TaskContext) => Promise<void>): Promise<void> {
    const renderer = createRenderer(this.options);
    renderer.start(this.roots);

    const rootCtx = new TaskContextImpl(/*implicit root*/, this, renderer);

    try {
      // Set up ALS so module-level task()/log() work inside fn()
      await storage.run(
        { logFold: this, node: rootCtx.node },
        () => fn(rootCtx),
      );
    } finally {
      renderer.stop();
    }
  }
}
```

#### `TaskContext` — explicit context (passed through callbacks)

```typescript
interface TaskContext {
  /** Create and run a sub-task. Lifecycle is automatic. */
  task(title: string, fn: (ctx: TaskContext) => Promise<void>): Promise<void>;
  /** Append a log line. */
  log(line: string): void;
  /** Append multiple lines (splits on \n). */
  logLines(text: string): void;
  /** The underlying TaskNode. */
  readonly node: TaskNode;
}
```

`task()` creates a child node, starts it, runs `fn` inside a new ALS scope (so
module-level functions also work inside explicit callbacks), and transitions to
success/fail on completion.

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
interface TaskHandle {
  /** Create and start a sub-task (immediately running). */
  begin(title: string): TaskHandle;
  /** Append a log line. */
  log(line: string): void;
  /** Append multiple lines. */
  logLines(text: string): void;
  /** Mark as successfully completed. */
  succeed(): void;
  /** Mark as failed. */
  fail(error?: Error): void;
  /** The underlying TaskNode. */
  readonly node: TaskNode;
}
```

`begin()` creates and starts the node immediately. No ALS involved — the
imperative API is fully explicit.

#### Error handling

- **Callback/ALS API**: thrown error → task fails, error stored on node. Error
  propagates up through the callback chain. `run()` catches it, calls
  `renderer.stop()`, then rethrows.
- **Imperative API**: user calls `fail(error?)` explicitly.
- **On `stop()`**: renderer dumps full `logLines[]` buffer for every failed
  task, printed after the final frame. This output is permanent (not
  cursor-overwritten).

#### Children of a failed parent

In the callback API, nesting guarantees children complete before the parent's
callback returns. If a child throws, the parent's callback also throws (unless
caught), so both fail naturally.

In the imperative API: calling `fail()` on a parent that has running children
auto-fails those children. Their status becomes `"fail"` with a synthetic
`Error("canceled: parent task failed")`.

### Layer 6: `src/run-command.ts` — optional subprocess wrapper

With ALS, the API is cleaner — no need to pass a `TaskContext`:

```typescript
/**
 * Run a command as a sub-task, piping stdout+stderr to the task's log.
 * Auto-nests under the current task context (via AsyncLocalStorage).
 */
export async function runCommand(
  title: string,
  command: string[],
  options?: Omit<Deno.CommandOptions, "stdout" | "stderr">,
): Promise<Deno.CommandStatus>;

/**
 * Explicit-context version for when ALS isn't available.
 */
export async function runCommandExplicit(
  ctx: TaskContext,
  title: string,
  command: string[],
  options?: Omit<Deno.CommandOptions, "stdout" | "stderr">,
): Promise<Deno.CommandStatus>;
```

Implementation:

1. Calls `task(title, ...)` (ALS version) or `ctx.task(title, ...)` (explicit)
2. Spawns
   `new Deno.Command(command[0], { args: command.slice(1), ...options, stdout: "piped", stderr: "piped" })`
3. Reads stdout and stderr concurrently via `Promise.all`, calls `log()` for
   each line
4. Awaits process completion
5. Non-zero exit → throws (auto-fails the task)

### Layer 7: `mod.ts` — public exports

```typescript
// Core class + types
export { LogFold } from "./src/log-fold.ts";
export type {
  LogFoldOptions,
  TaskContext,
  TaskHandle,
} from "./src/log-fold.ts";

// AsyncLocalStorage convenience functions
export { log, logLines, run, task } from "./src/context.ts";

// Types
export type { TaskNode, TaskStatus } from "./src/task-node.ts";
```

The `run-command` module is a separate submodule export:

```typescript
// @hugojosefson/log-fold/run-command
export { runCommand, runCommandExplicit } from "./src/run-command.ts";
```

`deno.jsonc` exports:

```jsonc
"exports": {
  ".": "./mod.ts",
  "./run-command": "./src/run-command.ts",
  "./example-usage": "./readme/example-usage.ts"
}
```

### Layer 8: tests

#### `test/task-node.test.ts` — data model unit tests

- `createTaskNode`: correct defaults (pending, no children, no logs)
- `createTaskNode` with parent: appended to parent's children
- `startTask`: status → running, startedAt set
- `succeedTask`: status → success, finishedAt set
- `failTask`: status → fail, error stored, finishedAt set
- `appendLog`: single line added
- `appendLogLines`: splits on `\n`, handles trailing newline
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
- Failed task → single line with `✗` and ERROR
- Running task → expanded with children visible
- Pending task → not shown
- Concurrent running siblings → both expanded
- Log tail window → last N lines shown for running leaf
- Multiple concurrent leaves → competitive tail allocation by activity
- Viewport overflow → completed tasks dropped, running tasks preserved
- No tasks → only header line
- Deeply nested → correct indentation at each level

#### `test/context.test.ts` — ALS context tests

- `task()` outside `run()` throws
- `log()` outside `run()` is a no-op
- `task()` inside `run()` creates child of root
- Nested `task()` calls create correct hierarchy
- `Promise.all` with multiple `task()` calls → separate branches
- `log()` goes to the correct task in concurrent context
- Mixed ALS and explicit context in the same tree

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
- ALS version auto-nests under current task

### Layer 9: example and docs

#### `readme/example-usage.ts`

```typescript
import { log, run, task } from "../mod.ts";

await run(async () => {
  await task("Install dependencies", async () => {
    log("npm install...");
    await new Promise((r) => setTimeout(r, 500));
    log("added 247 packages in 0.5s");
  });

  // Concurrent tasks
  await Promise.all([
    task("Compile TypeScript", async () => {
      log("tsc --build");
      await new Promise((r) => setTimeout(r, 300));
    }),
    task("Lint", async () => {
      log("eslint src/");
      await new Promise((r) => setTimeout(r, 200));
    }),
  ]);

  await task("Test", async () => {
    log("running 42 tests...");
    await new Promise((r) => setTimeout(r, 400));
    log("42 tests passed");
  });
});
```

#### `readme/README.md`

Update template with: what log-fold does, install instructions, ALS API example,
explicit context example, imperative example, concurrent tasks example,
subprocess wrapper example, options reference.

## VT100 extension point

The log buffer stores plain text lines (`string[]`). To add VT100 emulation:

1. Create `src/vt100.ts` with `VT100Terminal` (2D character grid)
2. Add optional `term?: VT100Terminal` to `TaskNode`
3. When present, `appendLog()` writes raw bytes to the VT100 emulator
4. `tailLogLines()` reads the last N rows from the VT100 grid
5. Renderer calls `tailLogLines()` — no changes needed

`tailLogLines()` is the abstraction seam.

## `deno.jsonc` changes

Add `@std/fmt` to imports. Update exports for submodules:

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

## Cancellation (future, not v1)

Out of scope for initial implementation. The user manages their own
`AbortController`. Future extension point: `run()` and `task()` could accept
`{ signal: AbortSignal }` to propagate cancellation through the tree.

## Implementation order

1. ~~`src/ansi.ts`~~ — done
2. `src/task-node.ts` — update: add `findRunningLeaves`, `countTasks`,
   `logBytes`; remove `findDeepestRunning`
3. `src/context.ts` — ALS store, module-level `run()`, `task()`, `log()`,
   `logLines()`
4. `src/renderer.ts` — `computeFrame()` pure function + TTY renderer (render
   loop, cursor strategy) + plain renderer
5. `src/log-fold.ts` — `LogFold` class, `TaskContext`, `TaskHandle`,
   `LogFoldOptions`
6. `src/run-command.ts` — `Deno.Command` wrapper (ALS + explicit versions)
7. `mod.ts` — public exports
8. `deno.jsonc` — add `@std/fmt`, update exports
9. `test/task-node.test.ts`
10. `test/context.test.ts`
11. `test/renderer.test.ts`
12. `test/log-fold.test.ts`
13. `test/run-command.test.ts`
14. `readme/example-usage.ts` + `readme/README.md`
15. `deno task all` — validate

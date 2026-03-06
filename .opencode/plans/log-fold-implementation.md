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

| Decision               | Choice                                                                                                                                                                                                                                                                                           |
| :--------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API style              | Single `logTask()` function with AsyncLocalStorage-based implicit context. Auto-inits on first call; accepts optional config via options argument. Module-level `log()`, `logFromStream()`, `setCurrentTaskWarning()`, `setCurrentTaskSkipped()`, `setCurrentTaskTitle()` for in-task operations |
| Log tail               | Keep full log buffer, display last N lines in tail window. Print full log on error                                                                                                                                                                                                               |
| VT100 emulation        | Skip for now; design the log buffer so a VT100 parser can plug in later                                                                                                                                                                                                                          |
| Subprocess integration | `logFromStream()` accepts Node.js `Readable`, web `ReadableStream`, arrays, or `{ stdout, stderr }` objects (covers `node:child_process`, `Deno.Command`, `Bun.spawn`). `runCommand()` wraps `node:child_process` as convenience                                                                 |
| Runtime                | Runtime-agnostic via `node:` built-in modules (`node:tty`, `node:process`, `node:async_hooks`, `node:child_process`). No Deno-specific APIs                                                                                                                                                      |
| Dependencies           | `jsr:@std/fmt` (includes colors) + `npm:cli-spinners` + `node:` built-ins                                                                                                                                                                                                                        |
| Colors support         | Delegates to `jsr:@std/fmt/colors` which auto-checks `NO_COLOR` env var on module load. The `colors` option overrides: `"auto"` (default, let @std/fmt decide), `true` (force on via `setColorEnabled(true)` after load), `false` (force off via `setColorEnabled(false)`)                       |
| Terminal control       | `node:tty` `WriteStream` methods (`cursorTo`, `moveCursor`, `clearLine`, `clearScreenDown`) instead of hand-written ANSI escapes. Only cursor hide/show requires raw ANSI                                                                                                                        |
| Unicode                | Unicode symbols only (`✓`, `✗`, `⚠`, `⊘`, `│`), no ASCII fallback. Running tasks use a configurable spinner (default: dots from cli-spinners)                                                                                                                                                    |
| Colors                 | Buildkit-style: cyan for completed, red for errors, yellow for warnings, dim for skipped                                                                                                                                                                                                         |
| Exports                | Submodule exports in `deno.jsonc`                                                                                                                                                                                                                                                                |
| Concurrency            | Support multiple children running simultaneously under one parent                                                                                                                                                                                                                                |

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
 * Options (tailLines, mode, output, etc.) are accepted but only apply at the
 * top level. If options are passed to a nested logTask(), a warning is logged
 * and the options are ignored.
 */
export async function logTask<T>(
  title: string,
  fn: () => Promise<T>,
): Promise<T>;
export async function logTask<T>(
  title: string,
  options: LogTaskOptions,
  fn: () => Promise<T>,
): Promise<T>;

/**
 * Append log output to the current task. Splits on newlines — multi-line
 * strings produce multiple log entries. If called outside any task context,
 * falls back to process.stderr.write() with a trailing newline appended
 * (if the text doesn't already end with one).
 */
export function log(text: string): void;

/**
 * Mark the current task as completed with warnings.
 * When the logTask callback returns, the task's status is preserved as
 * "warning" instead of being overridden to "success".
 */
export function setCurrentTaskWarning(): void;

/**
 * Mark the current task as skipped. The logTask callback should return
 * immediately after calling this. The task's status is preserved as
 * "skipped" instead of being overridden to "success".
 */
export function setCurrentTaskSkipped(): void;

/**
 * Update the current task's display title. The renderer picks up the
 * change on the next tick.
 */
export function setCurrentTaskTitle(title: string): void;
```

Design choices for "outside context" behavior:

| Function          | Outside context                                                                 |
| :---------------- | :------------------------------------------------------------------------------ |
| `logTask()`       | Auto-inits a session with defaults (or provided options). This becomes the root |
| `log()`           | Falls back to `process.stderr.write(text + "\n")` — output is never lost        |
| `logFromStream()` | Falls back to piping lines to `process.stderr` — output is never lost           |

Sequential top-level `logTask()` calls (outside any context) each create their
own independent render session. Each session starts and stops its own renderer.
To unify multiple top-level tasks under one session, wrap them in an outer
`logTask()`.

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
    const root = createTaskNode(title);
    session.roots.push(root);
    startTask(root);
    session.renderer.start(session.roots);
    session.renderer.onTaskStart(root);

    try {
      const result = await storage.run({ session, node: root }, fn);
      // Respect warn/skip set during execution
      if (root.status === "running") succeedTask(root);
      return result;
    } catch (e) {
      failTask(root, e instanceof Error ? e : new Error(String(e)));
      throw e;
    } finally {
      session.renderer.onTaskEnd(root);
      session.renderer.stop();
    }
  }

  if (options) {
    // Nested call with options — warn and ignore
    log(
      "[log-fold] options ignored in nested logTask() (only apply at top level)",
    );
  }

  // Nested call — create child under current context
  const { session, node: parent } = store;
  const child = createTaskNode(title, parent ?? undefined);
  if (!parent) session.roots.push(child);
  startTask(child);
  session.renderer.onTaskStart(child);

  try {
    const result = await storage.run({ session, node: child }, fn);
    // Respect warn/skip set during execution
    if (child.status === "running") succeedTask(child);
    return result;
  } catch (e) {
    failTask(child, e instanceof Error ? e : new Error(String(e)));
    throw e;
  } finally {
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
  await runCommand("npm install", ["npm", "install"]);
  // runCommand internally calls logTask() — auto-nests under "Build"
  await runCommand("tsc", ["npx", "tsc", "--build"]);
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

Without options, the first `logTask()` auto-initializes with defaults. Options
are only needed for custom `tailLines`, `mode`, `output`, `headerText`, etc.

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

export type LogTaskOptions = {
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
   * (`{ interval: 80, frames: ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"] }`)
   * from cli-spinners.
   * Pass any object matching `Spinner`, e.g. from the `cli-spinners` package.
   */
  spinner?: Spinner;
  /**
   * Color output. Default: "auto" (delegates to @std/fmt/colors which checks
   * NO_COLOR env var and TTY automatically).
   * - "auto": let @std/fmt/colors decide (default)
   * - true: force colors on (calls setColorEnabled(true) after module load,
   *   overrides NO_COLOR)
   * - false: force colors off (calls setColorEnabled(false))
   */
  colors?: boolean | "auto";
};
```

#### Error handling

- **Callback API**: thrown error → task fails, error stored on node. Error
  propagates up through the callback chain. The top-level `logTask()` catches
  it, calls `renderer.stop()`, then rethrows.
- **On `stop()`**: renderer dumps full `logLines[]` buffer for every failed
  task, printed after the final frame. This output is permanent (not
  cursor-overwritten).
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
 * the returned string.
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

1. Is it an `Array`? → process each element concurrently via `Promise.all`,
   collect all lines
2. Has `Symbol.asyncIterator`? → `AsyncIterable<string>`, consume with
   `for await (const line of input) { log(line); collect(line); }`
3. Has `.getReader()` method? → web `ReadableStream`, convert to Node.js
   `Readable` via `Readable.fromWeb()`, then use `node:readline`
4. Has `.pipe()` method? → Node.js `Readable`, use `node:readline` directly
5. Has `.stdout` or `.stderr` property (and isn't itself a stream)? →
   `StreamPair`: pipe both streams to `log()`, but only collect stdout lines for
   the return value

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
  /** Captured stdout output (lines joined with "\n", .trim()'d). */
  stdout: string;
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
5. Non-zero exit + `throwOnError !== false` → throws `Error(`Command failed with
   exit code ${code}`)` (auto-fails the task via the enclosing `logTask` catch).
   When `throwOnError` is `false`, non-zero exit returns the result without
   throwing or failing the task.

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
export type { LogTaskOptions, Spinner } from "./src/session.ts";
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
- `log()` outside any context falls back to `process.stderr.write()` with
  newline
- Nested `logTask()` calls create correct hierarchy
- `Promise.all` with multiple `logTask()` calls → separate branches
- `log()` goes to the correct task in concurrent context
- `logTask()` with options at top level configures the session
- `logTask()` with options at nested level logs a warning and ignores options
- `setCurrentTaskWarning()` sets task status to warning
- `setCurrentTaskSkipped()` sets task status to skipped
- `setCurrentTaskTitle()` updates task title

#### `test/log-fold.test.ts` — integration tests

- Sequential tasks run and complete
- Concurrent tasks via `Promise.all`
- Error → task fails, error captured, full log available
- Nested error → propagates to parent

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
examples, options reference.

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
Update exports for submodules. Add `nodeModulesDir` so `node:` built-in module
resolution works cleanly in Deno:

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

Out of scope for initial implementation. The user manages their own
`AbortController`. Future extension point: `logTask()` could accept
`{ signal: AbortSignal }` in options to propagate cancellation through the tree.

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

1. `deno.jsonc` — add `@std/fmt`, `cli-spinners`, remove `@std/path`, update
   exports (do this first so `@std/fmt` is available for all subsequent steps)
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
7. `src/session.ts` — internal `Session` class, `LogTaskOptions`, `Spinner`.
   Renderer stored as a property. Imports `storage` from `./storage.ts`. Not
   exported from the package
8. `src/storage.ts` — `AsyncLocalStorage` instance + `ContextStore` type.
   Type-only imports from this package
9. `src/context.ts` — module-level `logTask()` (with options overload), `log()`,
   `setCurrentTaskWarning()`, `setCurrentTaskSkipped()`,
   `setCurrentTaskTitle()`. Imports `Session` from `./session.ts` and `storage`
   from `./storage.ts`
10. `src/run-command.ts` — `runCommand(title, command, options?)`, uses
    `logTask()` internally
11. `mod.ts` — public exports
12. Remove `test/placeholder.test.ts` — replaced by real tests
13. `test/task-node.test.ts`
14. `test/context.test.ts`
15. `test/renderer.test.ts`
16. `test/log-fold.test.ts`
17. `test/run-command.test.ts`
18. `readme/example-usage.ts` + `readme/README.md`
19. `deno task all` — validate

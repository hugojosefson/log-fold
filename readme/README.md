# log-fold

[![JSR Version](https://jsr.io/badges/@hugojosefson/log-fold)](https://jsr.io/@hugojosefson/log-fold)
[![JSR Score](https://jsr.io/badges/@hugojosefson/log-fold/score)](https://jsr.io/@hugojosefson/log-fold)
[![CI](https://github.com/hugojosefson/log-fold/actions/workflows/release.yaml/badge.svg)](https://github.com/hugojosefson/log-fold/actions/workflows/release.yaml)

Collapsing task tree for CLI output, inspired by Docker Buildkit's progress
display. Tasks collapse to a single line when done; running tasks expand to show
sub-tasks and a tail window of log output. On error, the full log is dumped.

Works with Deno, Node.js, and Bun. Uses `node:` built-in modules — no
runtime-specific APIs.

## Installation

To add `@hugojosefson/log-fold` to your **Node.js** or **Bun** project with a
**`package.json`**, run:

```sh
"@@include(./install-node-or-bun.sh)";
```

To add it to a **Deno** project, run:

```sh
"@@include(./install-deno.sh)";
```

## Usage

### Basic example

Wrap units of work in `logTask()`. Call `log()` to append output lines. Nesting
is automatic via `AsyncLocalStorage` — no context objects to pass around.

```typescript
"@@include(./example-usage.ts)";
```

You may run the above example with:

```sh
deno run --reload jsr:@hugojosefson/log-fold/example-usage
```

### Concurrent tasks

Tasks inside `Promise.all` run simultaneously. Each branch has its own async
context, so `log()` calls go to the correct task.

```typescript
import { log, logTask } from "@hugojosefson/log-fold";

await logTask("CI", async () => {
  await logTask("Install", async () => {
    log("npm install...");
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

### Subprocess wrapper

`runCommand` spawns a process, pipes stdout+stderr to the task log, and returns
captured stdout. It auto-creates a `logTask` with the command as the title.

```typescript
import { logTask } from "@hugojosefson/log-fold";
import { runCommand } from "@hugojosefson/log-fold/run-command";

await logTask("Build", async () => {
  await runCommand(["npm", "install"]);
  await runCommand("TypeScript compile", ["npx", "tsc", "--build"]);
});
```

The first argument can be an explicit title or the command array. When passing
the command array directly, the title defaults to `command.join(" ")`.

Non-zero exit codes throw by default. Control this with `throwOnError`:

| `throwOnError` | Behavior on non-zero exit          |
| :------------- | :--------------------------------- |
| `true`         | Throws an error (default)          |
| `"warn"`       | Sets the subtask to warning status |
| `false`        | Ignores the exit code              |

### Custom options

Pass session and per-task options to the top-level `logTask()`:

```typescript
import { log, logTask } from "@hugojosefson/log-fold";

await logTask("Deploy", { tailLines: 10, mode: "plain" }, async () => {
  await logTask("Upload assets", async () => {
    log("uploading...");
  });
});
```

Per-task options (`tailLines`, `spinner`, `map`, `filter`) can be passed at any
nesting level. Session options (`mode`, `output`, `tickInterval`) are only
allowed at the top level — passing them to a nested `logTask()` throws.

### Warning, skipped, and dynamic title

```typescript
import {
  log,
  logTask,
  setCurrentTaskSkipped,
  setCurrentTaskTitle,
  setCurrentTaskWarning,
} from "@hugojosefson/log-fold";

await logTask("Pipeline", async () => {
  // Warning status — task shows ⚠ instead of ✓
  await logTask("Deploy", async () => {
    const result = await deploy();
    if (result.deprecationWarnings.length > 0) {
      log(`${result.deprecationWarnings.length} deprecation warnings`);
      setCurrentTaskWarning();
    }
  });

  // Skip status — task shows ⊘ instead of ✓
  await logTask("Build cache", async () => {
    if (await cacheExists()) {
      setCurrentTaskSkipped();
      return;
    }
    // ... build cache ...
  });

  // Dynamic title — updated on the next render tick
  await logTask("Download", async () => {
    const files = await listFiles();
    for (const [i, file] of files.entries()) {
      setCurrentTaskTitle(`Download (${i + 1}/${files.length})`);
      await downloadFile(file);
    }
  });
});
```

### Filtering and mapping log lines

Transform or filter log lines before display and error dumps using `map` and
`filter` task options. These compose with ancestor tasks — child transforms
apply first, then parent transforms.

```typescript
import { log, logTask } from "@hugojosefson/log-fold";

// Redact secrets — filtered lines are hidden from display AND error dumps
await logTask(
  "Deploy",
  { filter: (line) => !line.includes("SECRET") },
  async () => {
    log("connecting to server...");
    log("using token: SECRET_abc123"); // hidden everywhere
    log("deploy complete");
  },
);

// Rewrite paths — applies to display and error dumps
await logTask(
  "Build",
  { map: (line) => line.replace(/\/home\/user/g, "~") },
  async () => {
    log("compiling /home/user/src/main.ts"); // shown as "compiling ~/src/main.ts"
  },
);
```

### Stream piping with `logFromStream`

Pipe streams from any runtime's subprocess API (or any `ReadableStream`,
`Readable`, or `AsyncIterable`) into the current task's log.

```typescript
import { logFromStream, logTask } from "@hugojosefson/log-fold";

// Node.js child_process
import { spawn } from "node:child_process";

await logTask("My process", async () => {
  const child = spawn("my-tool", ["--flag"]);
  const output = await logFromStream(child);
});

// Deno.Command
await logTask("Build", async () => {
  const child = new Deno.Command("npm", {
    args: ["install"],
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  await logFromStream(child);
});

// Single ReadableStream (e.g. fetch response)
await logTask("Fetch logs", async () => {
  const response = await fetch("https://example.com/logs");
  await logFromStream(response.body!);
});
```

> **StreamPair return semantics**: when you pass a process-like object (has
> `.stdout` and/or `.stderr`), both streams are piped to `log()` for display,
> but only **stdout lines** are collected in the return value. This matches the
> unix convention that stdout is structured output and stderr is diagnostic.
> Passing a single stream (e.g. `child.stdout` directly) returns all its
> content.

## Options reference

### Session options

Passed to the top-level `logTask()` only.

| Option         | Type                                           | Default          | Description                                   |
| :------------- | :--------------------------------------------- | :--------------- | :-------------------------------------------- |
| `mode`         | `"tty" \| "plain" \| "auto"`                   | `"auto"`         | Force TTY or plain mode, or auto-detect       |
| `output`       | `WriteStream \| { write(s: string): boolean }` | `process.stderr` | Output stream (TTY mode requires WriteStream) |
| `tickInterval` | `number`                                       | `150`            | Render tick interval in ms                    |

### Task options

Passed at any nesting level. `tailLines` and `spinner` inherit from the nearest
ancestor that sets them. `map` and `filter` compose with ancestors (child first,
then parent).

| Option      | Type                        | Default                | Description                                              |
| :---------- | :-------------------------- | :--------------------- | :------------------------------------------------------- |
| `tailLines` | `number`                    | `6`                    | Log tail lines to show for running tasks (0 = hide tail) |
| `spinner`   | `Spinner`                   | dots from cli-spinners | Spinner animation for running tasks                      |
| `map`       | `(line: string) => string`  | identity               | Transform each log line before display                   |
| `filter`    | `(line: string) => boolean` | `() => true`           | Filter log lines (return `true` to show)                 |

## Gotchas

### `tailLines: 0` vs `filter: () => false`

Both suppress log output during execution, but they differ on error:

| Option                | Tail window | Error dump |
| :-------------------- | :---------- | :--------- |
| `tailLines: 0`        | Hidden      | Shown      |
| `filter: () => false` | Hidden      | Hidden     |

Use `tailLines: 0` when you want a clean display but full logs on failure. Use
`filter` when you need to redact content everywhere (including error dumps).

### `map`/`filter` apply to error dumps too

Raw log lines are always stored in `logLines[]` on the task node. When an error
dump is rendered, lines pass through `composedFlatMap` (the composed
`map`/`filter` chain). If you filter out lines containing secrets, those secrets
are also redacted in error dumps.

### Sequential top-level `logTask()` calls create independent sessions

Each top-level `logTask()` call (outside any existing context) creates its own
render session with independent progress tracking and cursor management. To
unify multiple top-level tasks under one session:

```typescript
await logTask("All", async () => {
  await logTask("First", async () => {/* ... */});
  await logTask("Second", async () => {/* ... */});
});
```

### `LOG_FOLD_STRICT` environment variable

When set (any non-empty value), `log()` outside a task context throws instead of
falling back to stderr. Useful during development to catch code paths that run
outside a `logTask()` wrapper unintentionally. Libraries should not set this.

## API

Full API docs on
[jsr.io/@hugojosefson/log-fold](https://jsr.io/@hugojosefson/log-fold).

For further usage examples, see the tests:

- [test/context.test.ts](test/context.test.ts)
- [test/log-fold.test.ts](test/log-fold.test.ts)
- [test/log-from-stream.test.ts](test/log-from-stream.test.ts)
- [test/renderer.test.ts](test/renderer.test.ts)
- [test/run-command.test.ts](test/run-command.test.ts)
- [test/task-node.test.ts](test/task-node.test.ts)

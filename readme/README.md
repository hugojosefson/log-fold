# log-fold

[![JSR Version](https://jsr.io/badges/@hugojosefson/log-fold)](https://jsr.io/@hugojosefson/log-fold)
[![JSR Score](https://jsr.io/badges/@hugojosefson/log-fold/score)](https://jsr.io/@hugojosefson/log-fold)
[![CI](https://github.com/hugojosefson/log-fold/actions/workflows/release-and-publish.yaml/badge.svg)](https://github.com/hugojosefson/log-fold/actions/workflows/release-and-publish.yaml)

Collapsing log tree for CLI output, inspired by Docker Buildkit's progress
display. Folds collapse to a single line when done; running folds expand to show
nested folds and a tail window of log output. On error, the full log is dumped.

Works with Node.js, Deno, and Bun. Uses `node:` built-in modules — no
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

Wrap units of work in `logFold()`. Call `log()` to append output lines. Nesting
is automatic via `AsyncLocalStorage` — no context objects to pass around.

```typescript
"@@include(./example-basic.ts)";
```

You may run the above example with:

```sh
deno run --reload jsr:@hugojosefson/log-fold/example-basic
```

### Concurrent folds

Folds inside `Promise.all` run simultaneously. Each branch has its own async
context, so `log()` calls go to the correct fold.

```typescript
"@@include(./example-concurrent-folds.ts)";
```

You may run the above example with:

```sh
deno run --reload jsr:@hugojosefson/log-fold/example-concurrent-folds
```

### Subprocess wrapper

`runCommand` spawns a process, pipes stdout+stderr to the fold log, and returns
captured stdout. It auto-creates a `logFold` with the command as the title.

```typescript
"@@include(./example-subprocess-wrapper.ts)";
```

The first argument can be an explicit title or the command array. When passing
the command array directly, the title defaults to `command.join(" ")`.

Non-zero exit codes throw by default. Control this with `throwOnError`:

| `throwOnError` | Behavior on non-zero exit              |
| :------------- | :------------------------------------- |
| `true`         | Throws an error (default)              |
| `"warn"`       | Sets the nested fold to warning status |
| `false`        | Ignores the exit code                  |

You may run the above example with:

```sh
deno run --allow-run=npm --allow-env --reload jsr:@hugojosefson/log-fold/example-subprocess-wrapper
```

### Custom options

Pass session and per-fold options to the top-level `logFold()`:

```typescript
"@@include(./example-custom-options.ts)";
```

Per-fold options (`tailLines`, `spinner`, `map`, `filter`) can be passed at any
nesting level. Session options (`mode`, `output`, `tickInterval`) are only
allowed at the top level — passing them to a nested `logFold()` throws.

You may run the above example with:

```sh
deno run --reload jsr:@hugojosefson/log-fold/example-custom-options
```

### Warning, skipped, and dynamic title

```typescript
"@@include(./example-warning-skipped-dynamic-title.ts)";
```

You may run the above example with:

```sh
deno run --reload jsr:@hugojosefson/log-fold/example-warning-skipped-dynamic-title
```

### Filtering and mapping log lines

Transform or filter log lines before display and error dumps using `map` and
`filter` fold options. These compose with ancestor folds — child transforms
apply first, then parent transforms.

```typescript
"@@include(./example-filtering-mapping.ts)";
```

You may run the above example with:

```sh
deno run --reload jsr:@hugojosefson/log-fold/example-filtering-mapping
```

### Stream piping with `logFromStream`

Pipe streams from any runtime's subprocess API (or any `ReadableStream`,
`Readable`, or `AsyncIterable`) into the current fold's log.

```typescript
"@@include(./example-stream-piping.ts)";
```

> **StreamPair return semantics**: when you pass a process-like object (has
> `.stdout` and/or `.stderr`), both streams are piped to `log()` for display,
> but only **stdout lines** are collected in the return value. This matches the
> unix convention that stdout is structured output and stderr is diagnostic.
> Passing a single stream (e.g. `child.stdout` directly) returns all its
> content.

You may run the above example with:

```sh
deno run --allow-run=find,npm --allow-net=example.com --allow-env --reload jsr:@hugojosefson/log-fold/example-stream-piping
```

## Options reference

### Session options

Passed to the top-level `logFold()` only.

| Option         | Type                                           | Default          | Description                                   |
| :------------- | :--------------------------------------------- | :--------------- | :-------------------------------------------- |
| `mode`         | `"tty" \| "plain" \| "auto"`                   | `"auto"`         | Force TTY or plain mode, or auto-detect       |
| `output`       | `WriteStream \| { write(s: string): boolean }` | `process.stderr` | Output stream (TTY mode requires WriteStream) |
| `tickInterval` | `number`                                       | `150`            | Render tick interval in ms                    |

### Fold options

Passed at any nesting level. `tailLines` and `spinner` inherit from the nearest
ancestor that sets them. `map` and `filter` compose with ancestors (child first,
then parent).

| Option      | Type                        | Default                | Description                                              |
| :---------- | :-------------------------- | :--------------------- | :------------------------------------------------------- |
| `tailLines` | `number`                    | `6`                    | Log tail lines to show for running folds (0 = hide tail) |
| `spinner`   | `Spinner`                   | dots from cli-spinners | Spinner animation for running folds                      |
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

Raw log lines are always stored in `logLines[]` on the fold node. When an error
dump is rendered, lines pass through `composedFlatMap` (the composed
`map`/`filter` chain). If you filter out lines containing secrets, those secrets
are also redacted in error dumps.

### Sequential top-level `logFold()` calls create independent sessions

Each top-level `logFold()` call (outside any existing context) creates its own
render session with independent progress tracking and cursor management. To
unify multiple top-level folds under one session:

```typescript
await logFold("All", async () => {
  await logFold("First", async () => {/* ... */});
  await logFold("Second", async () => {/* ... */});
});
```

### `LOG_FOLD_STRICT` environment variable

When set (any non-empty value), `log()` outside a fold context throws instead of
falling back to stderr. Useful during development to catch code paths that run
outside a `logFold()` wrapper unintentionally. Libraries should not set this.

## API

Full API docs on
[jsr.io/@hugojosefson/log-fold](https://jsr.io/@hugojosefson/log-fold).

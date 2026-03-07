# log-fold

[![JSR Version](https://jsr.io/badges/@hugojosefson/log-fold)](https://jsr.io/@hugojosefson/log-fold)
[![JSR Score](https://jsr.io/badges/@hugojosefson/log-fold/score)](https://jsr.io/@hugojosefson/log-fold)
[![CI](https://github.com/hugojosefson/log-fold/actions/workflows/release.yaml/badge.svg)](https://github.com/hugojosefson/log-fold/actions/workflows/release.yaml)

## Requirements

Requires [Deno](https://deno.com/) v2.7.4 or later.

_...or..._

- `/bin/sh`
- `unzip`
- `curl`

## API

Please see docs on
[jsr.io/@hugojosefson/log-fold](https://jsr.io/@hugojosefson/log-fold).

## Installation

```sh
# add as dependency to your project
deno add jsr:@hugojosefson/log-fold

# ...or...

# create and enter a directory for the script
mkdir -p "log-fold"
cd       "log-fold"

# download+extract the script, into current directory
curl -fsSL "https://github.com/hugojosefson/log-fold/tarball/main" \
  | tar -xzv --strip-components=1
```

## Example usage

```typescript
import { log, logTask } from "@hugojosefson/log-fold";

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

You may run the above example with:

```sh
deno run --reload jsr:@hugojosefson/log-fold/example-usage
```

For further usage examples, see the tests:

- [test/placeholder.test.ts](test/placeholder.test.ts)

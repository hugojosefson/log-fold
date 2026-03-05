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
import { placeholder } from "@hugojosefson/log-fold";

const result = placeholder();
console.dir({ result });
```

You may run the above example with:

```sh
deno run --reload jsr:@hugojosefson/log-fold/example-usage
```

For further usage examples, see the tests:

- [test/placeholder.test.ts](test/placeholder.test.ts)

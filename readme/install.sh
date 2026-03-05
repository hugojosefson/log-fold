#!/usr/bin/env bash
# add as dependency to your project
deno add jsr:@hugojosefson/log-fold

# ...or...

# create and enter a directory for the script
mkdir -p "log-fold"
cd       "log-fold"

# download+extract the script, into current directory
curl -fsSL "https://github.com/hugojosefson/log-fold/tarball/main" \
  | tar -xzv --strip-components=1

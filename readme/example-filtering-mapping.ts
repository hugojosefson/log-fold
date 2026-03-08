#!/usr/bin/env -S deno run
import { log, logTask } from "../mod.ts";

// Redact secrets — filtered lines are hidden from display AND error dumps
await logTask(
  "Deploy",
  { filter: (line) => !line.includes("SECRET") },
  () => {
    log("connecting to server...");
    log("using token: SECRET_abc123"); // hidden everywhere
    log("deploy complete");
  },
);

// Rewrite paths — applies to display and error dumps
await logTask(
  "Build",
  { map: (line) => line.replace(/\/home\/user/g, "~") },
  () => {
    log("compiling /home/user/src/main.ts"); // shown as "compiling ~/src/main.ts"
  },
);

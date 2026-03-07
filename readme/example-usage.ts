#!/usr/bin/env -S deno run
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

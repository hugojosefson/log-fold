#!/usr/bin/env -S deno run
import { log, logFold } from "../mod.ts";

await logFold("All", async () => {
  await logFold("Install dependencies", async () => {
    log("npm install...");
    await new Promise((r) => setTimeout(r, 5000));
    log("added 247 packages");
  });

  // Concurrent folds
  await Promise.all([
    logFold("Compile TypeScript", async () => {
      log("tsc --build");
      await new Promise((r) => setTimeout(r, 3000));
    }),
    logFold("Lint", async () => {
      log("eslint src/");
      await new Promise((r) => setTimeout(r, 2000));
    }),
  ]);

  await logFold("Test", async () => {
    log("running 42 tests...");
    await new Promise((r) => setTimeout(r, 4000));
    log("42 tests passed");
  });
});

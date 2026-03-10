#!/usr/bin/env -S deno run
import { log, logFold } from "../mod.ts";

await logFold("CI", async () => {
  await logFold("Install", () => {
    log("npm install...");
  });

  await Promise.all([
    logFold("Compile", () => {
      log("tsc --build");
    }),
    logFold("Lint", () => {
      log("eslint src/");
    }),
  ]);
});

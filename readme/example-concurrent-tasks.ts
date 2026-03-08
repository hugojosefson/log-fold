#!/usr/bin/env -S deno run
import { log, logTask } from "../mod.ts";

await logTask("CI", async () => {
  await logTask("Install", () => {
    log("npm install...");
  });

  await Promise.all([
    logTask("Compile", () => {
      log("tsc --build");
    }),
    logTask("Lint", () => {
      log("eslint src/");
    }),
  ]);
});

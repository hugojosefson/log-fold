#!/usr/bin/env -S deno run --allow-run=npm --allow-env

import { logFold, runCommand } from "../mod.ts";

await logFold("Run innocuous npm commands", async () => {
  await runCommand(["npm", "search", "typescript"]);
  await runCommand("Printing the shell completion script for npm", [
    "npm",
    "completion",
  ]);
});

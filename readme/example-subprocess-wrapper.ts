#!/usr/bin/env -S deno run --allow-run=npm --allow-env

import { logFold } from "../mod.ts";
import { runCommand } from "../src/run-command.ts";

await logFold("Run innocuous npm commands", async () => {
  await runCommand(["npm", "search", "typescript"]);
  await runCommand("Printing the shell completion script for npm", [
    "npm",
    "completion",
  ]);
});

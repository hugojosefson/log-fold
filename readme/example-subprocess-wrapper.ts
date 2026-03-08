#!/usr/bin/env -S deno run --allow-run=npm --allow-env

import { logTask } from "../mod.ts";
import { runCommand } from "../src/run-command.ts";

await logTask("Run innocuous npm commands", async () => {
  await runCommand(["npm", "search", "typescript"]);
  await runCommand("Printing the shell completion script for npm", [
    "npm",
    "completion",
  ]);
});

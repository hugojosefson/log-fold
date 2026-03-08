#!/usr/bin/env -S deno run --allow-run=find,npm --allow-net=example.com --allow-env
import { log, logFromStream, logTask } from "../mod.ts";
import { spawn } from "node:child_process";

// Node.js child_process
await logTask("My process", async () => {
  const child = spawn("find", [".", "-type", "f"]);
  const _output = await logFromStream(child);
});

if ("Deno" in globalThis) {
  // Deno.Command
  try {
    await logTask("Install npm deps", async () => {
      log("Create custom child process");
      const child = new Deno.Command("npm", {
        args: ["install"],
        stdout: "piped",
        stderr: "piped",
      }).spawn();

      await logTask("Pipe its output to the log", async () => {
        await logFromStream(child);
      });

      await logTask("Wait for custom process to end", async () => {
        const status = await child.status;
        if (!status.success) {
          throw new Error(JSON.stringify(status));
        }
      });
    });
  } catch {
    console.error(
      `<<< Swallowing error from "Install npm deps", because we expect "npm install" to fail if there is no "package.json", and so that the next example can run: >>>`,
    );
  }
}
// Single ReadableStream (e.g. fetch response)
await logTask("Fetch logs", async () => {
  const response = await fetch("https://example.com/logs");
  await logFromStream(response.body!);
});

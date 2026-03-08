#!/usr/bin/env -S deno run
import { log, logTask } from "../mod.ts";

await logTask("Deploy", { tailLines: 10, mode: "plain" }, async () => {
  await logTask("Upload assets", () => {
    log("uploading...");
  });
});

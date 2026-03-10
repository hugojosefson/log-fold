#!/usr/bin/env -S deno run
import { log, logFold } from "../mod.ts";

await logFold("Deploy", { tailLines: 10, mode: "plain" }, async () => {
  await logFold("Upload assets", () => {
    log("uploading...");
  });
});

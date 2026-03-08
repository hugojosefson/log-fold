#!/usr/bin/env -S deno run
import {
  log,
  logTask,
  setCurrentTaskSkipped,
  setCurrentTaskTitle,
  setCurrentTaskWarning,
} from "../mod.ts";

await logTask("Pipeline", async () => {
  // Warning status — task shows ⚠ instead of ✓
  await logTask("Deploy", async () => {
    const result = await deploy();
    if (result.deprecationWarnings.length > 0) {
      log(`${result.deprecationWarnings.length} deprecation warnings`);
      setCurrentTaskWarning();
    }
  });

  // Skip status — task shows ⊘ instead of ✓
  await logTask("Build cache", async () => {
    if (await cacheExists()) {
      setCurrentTaskSkipped();
      return;
    }
    // ... build cache ...
  });

  // Dynamic title — updated on the next render tick
  await logTask("Download", async () => {
    const files = await listFiles();
    for (const [i, file] of files.entries()) {
      setCurrentTaskTitle(`Download (${i + 1}/${files.length})`);
      await downloadFile(file);
    }
  });
});

// stub functions
function deploy() {
  return Promise.resolve({ deprecationWarnings: [] });
}
function cacheExists() {
  return Promise.resolve(false);
}
function listFiles() {
  return Promise.resolve(["file1.txt", "file2.txt"]);
}
async function downloadFile(_file: string) {
  await Promise.resolve();
}

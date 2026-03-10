#!/usr/bin/env -S deno run
import {
  log,
  logFold,
  setCurrentFoldSkipped,
  setCurrentFoldTitle,
  setCurrentFoldWarning,
} from "../mod.ts";

await logFold("Pipeline", async () => {
  // Warning status — fold shows ⚠ instead of ✓
  await logFold("Deploy", async () => {
    const result = await deploy();
    if (result.deprecationWarnings.length > 0) {
      log(`${result.deprecationWarnings.length} deprecation warnings`);
      setCurrentFoldWarning();
    }
  });

  // Skip status — fold shows ⊘ instead of ✓
  await logFold("Build cache", async () => {
    if (await cacheExists()) {
      setCurrentFoldSkipped();
      return;
    }
    // ... build cache ...
  });

  // Dynamic title — updated on the next render tick
  await logFold("Download", async () => {
    const files = await listFiles();
    for (const [i, file] of files.entries()) {
      setCurrentFoldTitle(`Download (${i + 1}/${files.length})`);
      await downloadFile(file);
    }
  });
});

// stub functions
function deploy() {
  return Promise.resolve({ deprecationWarnings: ["Something is old"] });
}
function cacheExists() {
  return Promise.resolve(true);
}
function listFiles() {
  return Promise.resolve([
    "file1.txt",
    "file2.txt",
    "file3.txt",
    "file4.txt",
    "file5.txt",
  ]);
}
async function downloadFile(_file: string) {
  await new Promise((resolve) => {
    setTimeout(resolve, 500);
  });
}

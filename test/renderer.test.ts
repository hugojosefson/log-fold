import { assertEquals } from "@std/assert";
import { computeFrame } from "../src/renderer/compute-frame.ts";
import {
  appendLog,
  countFolds,
  createFoldNode,
  findRunningLeaves,
  logBytes,
  startFold,
  succeedFold,
} from "../src/fold-node.ts";

Deno.test("computeFrame", async (t) => {
  await t.step("completed fold shows ✓ with duration", () => {
    const root = createFoldNode("Build");
    root.status = "success";
    root.startedAt = 1000;
    root.finishedAt = 2230;

    const frame = computeFrame(root, {
      termWidth: 80,
      termHeight: 24,
      displayCounts: new WeakMap(),
      now: 3000,
    });

    assertEquals(frame.lines.length, 1);
    const line = frame.lines[0];
    assertEquals(line.includes("✓"), true);
    assertEquals(line.includes("Build"), true);
    assertEquals(line.includes("1.2s"), true);
  });

  await t.step("warning fold shows ⚠ with duration", () => {
    const root = createFoldNode("Deploy");
    root.status = "warning";
    root.startedAt = 1000;
    root.finishedAt = 2500;

    const frame = computeFrame(root, {
      termWidth: 80,
      termHeight: 24,
      displayCounts: new WeakMap(),
      now: 3000,
    });

    assertEquals(frame.lines.length, 1);
    const line = frame.lines[0];
    assertEquals(line.includes("⚠"), true);
    assertEquals(line.includes("Deploy"), true);
  });

  await t.step("failed fold shows ✗ with ERROR", () => {
    const root = createFoldNode("Test");
    root.status = "fail";
    root.error = new Error("test failure");
    root.startedAt = 1000;
    root.finishedAt = 2000;

    const frame = computeFrame(root, {
      termWidth: 80,
      termHeight: 24,
      displayCounts: new WeakMap(),
      now: 3000,
    });

    assertEquals(frame.lines.length, 1);
    const line = frame.lines[0];
    assertEquals(line.includes("✗"), true);
    assertEquals(line.includes("ERROR"), true);
    assertEquals(line.includes("Test"), true);
  });

  await t.step("skipped fold shows ⊘ without duration", () => {
    const root = createFoldNode("Cache");
    root.status = "skipped";
    root.startedAt = 1000;
    root.finishedAt = 1001;

    const frame = computeFrame(root, {
      termWidth: 80,
      termHeight: 24,
      displayCounts: new WeakMap(),
      now: 3000,
    });

    assertEquals(frame.lines.length, 1);
    const line = frame.lines[0];
    assertEquals(line.includes("⊘"), true);
    assertEquals(line.includes("Cache"), true);
  });

  await t.step("running fold shows spinner and expands children", () => {
    const root = createFoldNode("Build");
    startFold(root);

    const child1 = createFoldNode("Install", root);
    child1.status = "success";
    child1.startedAt = 1000;
    child1.finishedAt = 2000;

    const child2 = createFoldNode("Compile", root);
    startFold(child2);

    const frame = computeFrame(root, {
      termWidth: 80,
      termHeight: 24,
      displayCounts: new WeakMap(),
      now: 1500,
    });

    // Root + 2 children = at least 3 lines
    assertEquals(frame.lines.length >= 3, true);
    // Root should show progress
    assertEquals(frame.lines[0].includes("(1/3)"), true);
  });

  await t.step("pending fold not shown", () => {
    const root = createFoldNode("Build");
    startFold(root);

    const _child = createFoldNode("Pending child", root);
    // status is "pending" by default

    const frame = computeFrame(root, {
      termWidth: 80,
      termHeight: 24,
      displayCounts: new WeakMap(),
      now: 1000,
    });

    // Root is shown, but pending child is not
    assertEquals(frame.lines.length, 1);
  });

  await t.step(
    "title-less fold not rendered, children at parent depth",
    () => {
      const root = createFoldNode("Build");
      startFold(root);

      // Title-less structural fold
      const structural = createFoldNode(undefined, root);
      structural.status = "running";
      structural.startedAt = 1000;

      const child = createFoldNode("Actual work", structural);
      child.status = "success";
      child.startedAt = 1000;
      child.finishedAt = 2000;

      const frame = computeFrame(root, {
        termWidth: 80,
        termHeight: 24,
        displayCounts: new WeakMap(),
        now: 1500,
      });

      // Root + child visible, structural not visible
      // "Actual work" should be at depth 1 (2 spaces indent)
      const childLine = frame.lines.find((l) => l.includes("Actual work"));
      assertEquals(childLine !== undefined, true);
      assertEquals(childLine!.startsWith("  "), true);
    },
  );

  await t.step("log tail window shown for running leaf", () => {
    const root = createFoldNode("Build");
    startFold(root);

    appendLog(root, "line 1");
    appendLog(root, "line 2");
    appendLog(root, "line 3");

    const frame = computeFrame(root, {
      termWidth: 80,
      termHeight: 24,
      displayCounts: new WeakMap(),
      now: 1000,
    });

    // Fold line + tail lines + blank separator
    assertEquals(frame.lines.length > 1, true);
    const tailLines = frame.lines.filter((l) => l.includes("│"));
    assertEquals(tailLines.length, 3);
  });

  await t.step("log tail respects composedFlatMap", () => {
    const root = createFoldNode("Build", undefined, {
      filter: (line: string) => !line.includes("SECRET"),
    });
    startFold(root);

    appendLog(root, "visible line");
    appendLog(root, "SECRET token: abc123");
    appendLog(root, "another visible");

    const frame = computeFrame(root, {
      termWidth: 80,
      termHeight: 24,
      displayCounts: new WeakMap(),
      now: 1000,
    });

    // Should not include SECRET line in display
    const hasSecret = frame.lines.some((l) => l.includes("SECRET"));
    assertEquals(hasSecret, false);
    // Should include visible lines
    const hasVisible = frame.lines.some((l) => l.includes("visible line"));
    assertEquals(hasVisible, true);
  });

  await t.step("empty tree produces empty frame", () => {
    const root = createFoldNode("Root");
    // Pending status — not shown

    const frame = computeFrame(root, {
      termWidth: 80,
      termHeight: 24,
      displayCounts: new WeakMap(),
      now: 1000,
    });

    assertEquals(frame.lines.length, 0);
  });

  await t.step("deep nesting has correct indentation", () => {
    const root = createFoldNode("L0");
    startFold(root);

    const l1 = createFoldNode("L1", root);
    startFold(l1);

    const l2 = createFoldNode("L2", l1);
    l2.status = "success";
    l2.startedAt = 1000;
    l2.finishedAt = 2000;

    const frame = computeFrame(root, {
      termWidth: 80,
      termHeight: 24,
      displayCounts: new WeakMap(),
      now: 1500,
    });

    // L0 at depth 0, L1 at depth 1 (2 spaces), L2 at depth 2 (4 spaces)
    const l2Line = frame.lines.find((l) => l.includes("L2"));
    assertEquals(l2Line !== undefined, true);
    assertEquals(l2Line!.startsWith("    "), true);
  });

  await t.step("concurrent running siblings both expanded", () => {
    const root = createFoldNode("CI");
    startFold(root);

    const compile = createFoldNode("Compile", root);
    startFold(compile);

    const lint = createFoldNode("Lint", root);
    startFold(lint);

    const frame = computeFrame(root, {
      termWidth: 80,
      termHeight: 24,
      displayCounts: new WeakMap(),
      now: 1000,
    });

    // Root + compile + lint = 3 lines
    assertEquals(frame.lines.length, 3);
    const hasCompile = frame.lines.some((l) => l.includes("Compile"));
    const hasLint = frame.lines.some((l) => l.includes("Lint"));
    assertEquals(hasCompile, true);
    assertEquals(hasLint, true);
  });
});

Deno.test("fold-node helpers", async (t) => {
  await t.step("findRunningLeaves finds concurrent leaves", () => {
    const root = createFoldNode("Root");
    startFold(root);

    const a = createFoldNode("A", root);
    startFold(a);

    const b = createFoldNode("B", root);
    startFold(b);

    const leaves = findRunningLeaves(root);
    assertEquals(leaves.length, 2);
    assertEquals(leaves.includes(a), true);
    assertEquals(leaves.includes(b), true);
  });

  await t.step("countFolds excludes title-less folds", () => {
    const root = createFoldNode("Root");
    startFold(root);

    const structural = createFoldNode(undefined, root);
    startFold(structural);

    const child = createFoldNode("Child", structural);
    succeedFold(child);
    child.startedAt = 1000;

    const { total, completed } = countFolds(root);
    assertEquals(total, 2); // Root + Child (structural excluded)
    assertEquals(completed, 1); // Only Child completed
  });

  await t.step("logBytes sums line lengths", () => {
    const node = createFoldNode("Test");
    appendLog(node, "hello"); // 5
    appendLog(node, "world!"); // 6
    assertEquals(logBytes(node), 11);
  });
});

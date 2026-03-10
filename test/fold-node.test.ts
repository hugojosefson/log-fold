import { assertEquals } from "@std/assert";
import {
  ancestorChain,
  appendLog,
  countFolds,
  createFoldNode,
  durationMillis,
  failFold,
  findRunningLeaves,
  logBytes,
  setTitle,
  startFold,
  succeedFold,
  tailLogLines,
  walkTree,
} from "../src/fold-node.ts";

Deno.test("createFoldNode", async (t) => {
  await t.step("correct defaults: pending, no children, no logs", () => {
    const node = createFoldNode("Test");
    assertEquals(node.title, "Test");
    assertEquals(node.status, "pending");
    assertEquals(node.children.length, 0);
    assertEquals(node.logLines.length, 0);
    assertEquals(node.error, undefined);
    assertEquals(node.startedAt, undefined);
    assertEquals(node.finishedAt, undefined);
    assertEquals(node.parent, undefined);
    assertEquals(node.tailLines, 6);
    // composedFlatMap is identity by default
    assertEquals(node.composedFlatMap("hello"), ["hello"]);
  });

  await t.step("with parent: appended to parent's children", () => {
    const parent = createFoldNode("Parent");
    const child = createFoldNode("Child", parent);
    assertEquals(parent.children.length, 1);
    assertEquals(parent.children[0], child);
    assertEquals(child.parent, parent);
  });

  await t.step("with foldOptions: composedFlatMap stored on node", () => {
    const node = createFoldNode("Test", undefined, {
      map: (line: string) => line.toUpperCase(),
    });
    assertEquals(node.composedFlatMap("hello"), ["HELLO"]);
  });

  await t.step(
    "with parent composedFlatMap: child map+filter composed with parent",
    () => {
      const parent = createFoldNode("Parent", undefined, {
        filter: (line: string) => !line.includes("SECRET"),
      });

      const child = createFoldNode("Child", parent, {
        map: (line: string) => line.replace(/\/home\/user/g, "~"),
      });

      // Input that maps then gets filtered by parent
      assertEquals(
        child.composedFlatMap("/home/user/token: SECRET_abc"),
        [],
      );

      // Input that maps and passes parent filter
      assertEquals(
        child.composedFlatMap("/home/user/src/main.ts"),
        ["~/src/main.ts"],
      );
    },
  );

  await t.step(
    "with both map and filter: local map → local filter → parent composedFlatMap",
    () => {
      const parent = createFoldNode("Parent", undefined, {
        map: (line: string) => `[parent] ${line}`,
      });

      const child = createFoldNode("Child", parent, {
        map: (line: string) => line.toUpperCase(),
        filter: (line: string) => line.length < 20,
      });

      // Short line passes filter after map
      assertEquals(child.composedFlatMap("hi"), ["[parent] HI"]);

      // Long line filtered out after map
      assertEquals(
        child.composedFlatMap("this is a very long line that exceeds"),
        [],
      );
    },
  );

  await t.step("filter only (no map): filter applied then parent", () => {
    const parent = createFoldNode("Parent", undefined, {
      map: (line: string) => `[P] ${line}`,
    });

    const child = createFoldNode("Child", parent, {
      filter: (line: string) => line !== "skip",
    });

    assertEquals(child.composedFlatMap("keep"), ["[P] keep"]);
    assertEquals(child.composedFlatMap("skip"), []);
  });

  await t.step(
    "tailLines/spinner inheritance: inherits from nearest ancestor",
    () => {
      const root = createFoldNode("Root", undefined, { tailLines: 10 });
      const middle = createFoldNode("Middle", root);
      const leaf = createFoldNode("Leaf", middle);

      assertEquals(root.tailLines, 10);
      assertEquals(middle.tailLines, 10);
      assertEquals(leaf.tailLines, 10);

      // Child with explicit tailLines overrides
      const override = createFoldNode("Override", root, { tailLines: 3 });
      assertEquals(override.tailLines, 3);

      // Grandchild of override inherits its value
      const grandchild = createFoldNode("Grand", override);
      assertEquals(grandchild.tailLines, 3);
    },
  );

  await t.step("spinner inheritance: inherits from nearest ancestor", () => {
    const customSpinner = { interval: 100, frames: ["A", "B"] };
    const root = createFoldNode("Root", undefined, {
      spinner: customSpinner,
    });
    const child = createFoldNode("Child", root);

    assertEquals(child.spinner, customSpinner);
    assertEquals(child.spinner.interval, 100);
    assertEquals(child.spinner.frames, ["A", "B"]);
  });
});

Deno.test("startFold", async (t) => {
  await t.step("status → running, startedAt set", () => {
    const node = createFoldNode("Test");
    const before = Date.now();
    startFold(node);
    const after = Date.now();

    assertEquals(node.status, "running");
    assertEquals(typeof node.startedAt, "number");
    assertEquals(node.startedAt! >= before, true);
    assertEquals(node.startedAt! <= after, true);
  });
});

Deno.test("succeedFold", async (t) => {
  await t.step("status → success, finishedAt set", () => {
    const node = createFoldNode("Test");
    startFold(node);
    const before = Date.now();
    succeedFold(node);
    const after = Date.now();

    assertEquals(node.status, "success");
    assertEquals(typeof node.finishedAt, "number");
    assertEquals(node.finishedAt! >= before, true);
    assertEquals(node.finishedAt! <= after, true);
  });
});

Deno.test("failFold", async (t) => {
  await t.step("status → fail, error stored, finishedAt set", () => {
    const node = createFoldNode("Test");
    startFold(node);
    const err = new Error("oops");
    const before = Date.now();
    failFold(node, err);
    const after = Date.now();

    assertEquals(node.status, "fail");
    assertEquals(node.error, err);
    assertEquals(typeof node.finishedAt, "number");
    assertEquals(node.finishedAt! >= before, true);
    assertEquals(node.finishedAt! <= after, true);
  });

  await t.step("failFold without error: error is undefined", () => {
    const node = createFoldNode("Test");
    startFold(node);
    failFold(node);

    assertEquals(node.status, "fail");
    assertEquals(node.error, undefined);
  });
});

Deno.test("setTitle", async (t) => {
  await t.step("updates node title in-place", () => {
    const node = createFoldNode("Original");
    assertEquals(node.title, "Original");
    setTitle(node, "Updated");
    assertEquals(node.title, "Updated");
  });
});

Deno.test("appendLog", async (t) => {
  await t.step("pushes a single line to logLines[] (no splitting)", () => {
    const node = createFoldNode("Test");
    appendLog(node, "line 1");
    appendLog(node, "line 2\nwith newline");

    assertEquals(node.logLines.length, 2);
    assertEquals(node.logLines[0], "line 1");
    // appendLog does NOT split — that's log()'s job
    assertEquals(node.logLines[1], "line 2\nwith newline");
  });
});

Deno.test("tailLogLines", async (t) => {
  await t.step("returns last N lines", () => {
    const node = createFoldNode("Test");
    appendLog(node, "a");
    appendLog(node, "b");
    appendLog(node, "c");
    appendLog(node, "d");
    appendLog(node, "e");

    const tail = tailLogLines(node, 3);
    assertEquals(tail, ["c", "d", "e"]);
  });

  await t.step("handles N > total", () => {
    const node = createFoldNode("Test");
    appendLog(node, "a");
    appendLog(node, "b");

    const tail = tailLogLines(node, 10);
    assertEquals(tail, ["a", "b"]);
  });

  await t.step("returns empty array for no logs", () => {
    const node = createFoldNode("Test");
    const tail = tailLogLines(node, 5);
    assertEquals(tail, []);
  });
});

Deno.test("durationMillis", async (t) => {
  await t.step("returns undefined if not started", () => {
    const node = createFoldNode("Test");
    assertEquals(durationMillis(node), undefined);
  });

  await t.step("returns elapsed ms for running fold", () => {
    const node = createFoldNode("Test");
    node.startedAt = Date.now() - 500;

    const ms = durationMillis(node);
    assertEquals(typeof ms, "number");
    assertEquals(ms! >= 400, true);
    assertEquals(ms! < 2000, true);
  });

  await t.step("returns exact duration for completed fold", () => {
    const node = createFoldNode("Test");
    node.startedAt = 1000;
    node.finishedAt = 2500;

    assertEquals(durationMillis(node), 1500);
  });
});

Deno.test("walkTree", async (t) => {
  await t.step("correct DFS order and depth values", () => {
    const root = createFoldNode("Root");
    const a = createFoldNode("A", root);
    const a1 = createFoldNode("A1", a);
    const b = createFoldNode("B", root);

    const walked = [...walkTree(root)];

    assertEquals(walked.length, 4);
    assertEquals(walked[0], { node: root, depth: 0 });
    assertEquals(walked[1], { node: a, depth: 1 });
    assertEquals(walked[2], { node: a1, depth: 2 });
    assertEquals(walked[3], { node: b, depth: 1 });
  });

  await t.step("single node yields just that node at depth 0", () => {
    const root = createFoldNode("Only");
    const walked = [...walkTree(root)];
    assertEquals(walked.length, 1);
    assertEquals(walked[0], { node: root, depth: 0 });
  });
});

Deno.test("findRunningLeaves", async (t) => {
  await t.step("multiple concurrent running leaves", () => {
    const root = createFoldNode("Root");
    startFold(root);

    const a = createFoldNode("A", root);
    startFold(a);

    const b = createFoldNode("B", root);
    startFold(b);

    const c = createFoldNode("C", root);
    startFold(c);

    const leaves = findRunningLeaves(root);
    assertEquals(leaves.length, 3);
    assertEquals(leaves.includes(a), true);
    assertEquals(leaves.includes(b), true);
    assertEquals(leaves.includes(c), true);
  });

  await t.step("node with running children is not a leaf", () => {
    const root = createFoldNode("Root");
    startFold(root);

    const child = createFoldNode("Child", root);
    startFold(child);

    const grandchild = createFoldNode("Grandchild", child);
    startFold(grandchild);

    const leaves = findRunningLeaves(root);
    // Only grandchild is a leaf; root and child have running children
    assertEquals(leaves.length, 1);
    assertEquals(leaves[0], grandchild);
  });

  await t.step(
    "completed children don't prevent parent from being leaf",
    () => {
      const root = createFoldNode("Root");
      startFold(root);

      const child = createFoldNode("Child", root);
      startFold(child);
      succeedFold(child);

      const leaves = findRunningLeaves(root);
      // root is running with no running children → it's a leaf
      assertEquals(leaves.length, 1);
      assertEquals(leaves[0], root);
    },
  );
});

Deno.test("ancestorChain", async (t) => {
  await t.step("correct root-to-node path", () => {
    const root = createFoldNode("Root");
    const mid = createFoldNode("Mid", root);
    const leaf = createFoldNode("Leaf", mid);

    const chain = ancestorChain(leaf);
    assertEquals(chain.length, 3);
    assertEquals(chain[0], root);
    assertEquals(chain[1], mid);
    assertEquals(chain[2], leaf);
  });

  await t.step("root node returns single-element chain", () => {
    const root = createFoldNode("Root");
    const chain = ancestorChain(root);
    assertEquals(chain.length, 1);
    assertEquals(chain[0], root);
  });
});

Deno.test("countFolds", async (t) => {
  await t.step("correct total and completed counts", () => {
    const root = createFoldNode("Root");
    startFold(root);

    const a = createFoldNode("A", root);
    startFold(a);
    succeedFold(a);

    const b = createFoldNode("B", root);
    startFold(b);
    failFold(b, new Error("fail"));

    const c = createFoldNode("C", root);
    startFold(c);
    // still running

    const d = createFoldNode("D", root);
    // pending

    const { total, completed } = countFolds(root);
    assertEquals(total, 5); // Root, A, B, C, D
    assertEquals(completed, 2); // A (success), B (fail)

    // Suppress unused variable warnings
    void c;
    void d;
  });

  await t.step("title-less folds excluded from counts", () => {
    const root = createFoldNode("Root");
    startFold(root);

    const structural = createFoldNode(undefined, root);
    startFold(structural);

    const child = createFoldNode("Child", structural);
    startFold(child);
    succeedFold(child);

    const { total, completed } = countFolds(root);
    assertEquals(total, 2); // Root + Child (structural excluded)
    assertEquals(completed, 1); // Child
  });

  await t.step("warning and skipped count as completed", () => {
    const root = createFoldNode("Root");
    startFold(root);

    const warned = createFoldNode("Warned", root);
    startFold(warned);
    warned.status = "warning";
    warned.finishedAt = Date.now();

    const skipped = createFoldNode("Skipped", root);
    startFold(skipped);
    skipped.status = "skipped";
    skipped.finishedAt = Date.now();

    const { total, completed } = countFolds(root);
    assertEquals(total, 3); // Root, Warned, Skipped
    assertEquals(completed, 2); // Warned + Skipped
  });
});

Deno.test("logBytes", async (t) => {
  await t.step("correct byte count", () => {
    const node = createFoldNode("Test");
    appendLog(node, "hello"); // 5
    appendLog(node, "world!"); // 6
    appendLog(node, ""); // 0

    assertEquals(logBytes(node), 11);
  });

  await t.step("zero for empty log", () => {
    const node = createFoldNode("Test");
    assertEquals(logBytes(node), 0);
  });
});

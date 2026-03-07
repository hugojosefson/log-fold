import { assertEquals, assertRejects } from "@std/assert";
import {
  log,
  logTask,
  setCurrentTaskSkipped,
  setCurrentTaskTitle,
  setCurrentTaskWarning,
} from "../src/context.ts";
import { storage } from "../src/storage.ts";

/** Create a mock writable stream that captures output. */
function createMockOutput(): {
  stream: { write(s: string): boolean };
  lines: string[];
} {
  const lines: string[] = [];
  return {
    stream: {
      write(s: string): boolean {
        lines.push(s);
        return true;
      },
    },
    lines,
  };
}

Deno.test("context", async (t) => {
  await t.step(
    "logTask() outside any context auto-inits a session",
    async () => {
      const mock = createMockOutput();
      const result = await logTask("Auto-init", {
        mode: "plain",
        output: mock.stream,
      }, () => {
        return 42;
      });
      assertEquals(result, 42);
      // The plain renderer should have written something
      assertEquals(mock.lines.length > 0, true);
    },
  );

  await t.step("nested logTask() calls create correct hierarchy", async () => {
    const mock = createMockOutput();
    await logTask("Root", { mode: "plain", output: mock.stream }, async () => {
      await logTask("Child", async () => {
        await logTask("Grandchild", () => {
          // Verify we're inside nested context
          const store = storage.getStore();
          assertEquals(store !== undefined, true);
          assertEquals(store!.node!.title, "Grandchild");
          assertEquals(store!.node!.parent!.title, "Child");
          assertEquals(store!.node!.parent!.parent!.title, "Root");
        });
      });
    });
  });

  await t.step(
    "Promise.all with multiple logTask() → separate branches",
    async () => {
      const mock = createMockOutput();
      await logTask(
        "Root",
        { mode: "plain", output: mock.stream },
        async () => {
          const parentStore = storage.getStore()!;
          const root = parentStore.node!;

          await Promise.all([
            logTask("Branch A", () => {
              const store = storage.getStore()!;
              assertEquals(store.node!.title, "Branch A");
              assertEquals(store.node!.parent, root);
            }),
            logTask("Branch B", () => {
              const store = storage.getStore()!;
              assertEquals(store.node!.title, "Branch B");
              assertEquals(store.node!.parent, root);
            }),
          ]);

          assertEquals(root.children.length, 2);
          assertEquals(root.children[0].title, "Branch A");
          assertEquals(root.children[1].title, "Branch B");
        },
      );
    },
  );

  await t.step(
    "log() goes to the correct task in concurrent context",
    async () => {
      const mock = createMockOutput();
      await logTask(
        "Root",
        { mode: "plain", output: mock.stream },
        async () => {
          await Promise.all([
            logTask("Task A", () => {
              log("message from A");
              const store = storage.getStore()!;
              assertEquals(
                store.node!.logLines.includes("message from A"),
                true,
              );
            }),
            logTask("Task B", () => {
              log("message from B");
              const store = storage.getStore()!;
              assertEquals(
                store.node!.logLines.includes("message from B"),
                true,
              );
            }),
          ]);
        },
      );
    },
  );

  await t.step(
    "logTask() with options at top level configures the session",
    async () => {
      const mock = createMockOutput();
      await logTask(
        "Configured",
        { mode: "plain", output: mock.stream, tailLines: 3 },
        () => {
          const store = storage.getStore()!;
          assertEquals(store.node!.tailLines, 3);
        },
      );
    },
  );

  await t.step(
    "logTask() with session options at nested level throws",
    async () => {
      const mock = createMockOutput();
      await assertRejects(
        async () => {
          await logTask(
            "Root",
            { mode: "plain", output: mock.stream },
            async () => {
              await logTask(
                "Nested",
                { mode: "tty" } as Record<string, unknown>,
                () => {},
              );
            },
          );
        },
        Error,
        "Session options",
      );
    },
  );

  await t.step(
    "logTask() with per-task options (map/filter) at nested level works",
    async () => {
      const mock = createMockOutput();
      await logTask(
        "Root",
        { mode: "plain", output: mock.stream },
        async () => {
          await logTask(
            "Child",
            { map: (line: string) => line.toUpperCase() },
            () => {
              const store = storage.getStore()!;
              // composedFlatMap should apply the map
              assertEquals(store.node!.composedFlatMap("hello"), ["HELLO"]);
            },
          );
        },
      );
    },
  );

  await t.step(
    "map/filter compose: local map → local filter → parent composedFlatMap",
    async () => {
      const mock = createMockOutput();
      await logTask(
        "Root",
        {
          mode: "plain",
          output: mock.stream,
          filter: (line: string) => !line.includes("SECRET"),
        },
        async () => {
          await logTask(
            "Child",
            {
              map: (line: string) => line.replace(/\/home\/user/g, "~"),
            },
            () => {
              const store = storage.getStore()!;
              const node = store.node!;

              // Maps then parent filters out
              assertEquals(
                node.composedFlatMap("/home/user/token: SECRET_abc"),
                [],
              );
              // Maps and passes parent filter
              assertEquals(
                node.composedFlatMap("/home/user/src/main.ts"),
                ["~/src/main.ts"],
              );
            },
          );
        },
      );
    },
  );

  await t.step(
    "map/filter apply to both tail window display and error dumps",
    async () => {
      const mock = createMockOutput();
      try {
        await logTask(
          "Root",
          {
            mode: "plain",
            output: mock.stream,
            filter: (line: string) => !line.includes("SECRET"),
          },
          async () => {
            await logTask("Failing", () => {
              log("normal line");
              log("SECRET_token_123");
              throw new Error("boom");
            });
          },
        );
      } catch {
        // Expected
      }

      // Check that SECRET was NOT in the plain renderer output
      const outputText = mock.lines.join("");
      assertEquals(outputText.includes("SECRET"), false);
      assertEquals(outputText.includes("normal line"), true);
    },
  );

  await t.step(
    "original lines always preserved in logLines[] regardless of map/filter",
    async () => {
      const mock = createMockOutput();
      await logTask(
        "Root",
        {
          mode: "plain",
          output: mock.stream,
          map: (line: string) => line.toUpperCase(),
          filter: (line: string) => line !== "HIDDEN",
        },
        () => {
          log("hello");
          log("hidden");

          const store = storage.getStore()!;
          const node = store.node!;
          // Raw lines preserved as-is
          assertEquals(node.logLines[0], "hello");
          assertEquals(node.logLines[1], "hidden");
        },
      );
    },
  );

  await t.step(
    "setCurrentTaskWarning() sets task status to warning",
    async () => {
      const mock = createMockOutput();
      await logTask("Warned", { mode: "plain", output: mock.stream }, () => {
        setCurrentTaskWarning();

        const store = storage.getStore()!;
        assertEquals(store.node!.status, "warning");
      });

      // After completion, status should still be warning (not overridden to success)
      const output = mock.lines.join("");
      assertEquals(output.includes("⚠"), true);
    },
  );

  await t.step(
    "setCurrentTaskSkipped() sets task status to skipped",
    async () => {
      const mock = createMockOutput();
      await logTask("Skipped", { mode: "plain", output: mock.stream }, () => {
        setCurrentTaskSkipped();

        const store = storage.getStore()!;
        assertEquals(store.node!.status, "skipped");
      });

      const output = mock.lines.join("");
      assertEquals(output.includes("⊘"), true);
    },
  );

  await t.step("setCurrentTaskTitle() updates task title", async () => {
    const mock = createMockOutput();
    await logTask("Original", { mode: "plain", output: mock.stream }, () => {
      setCurrentTaskTitle("Updated");

      const store = storage.getStore()!;
      assertEquals(store.node!.title, "Updated");
    });
  });

  await t.step(
    "logTask(fn) — title-less overload creates structural-only task",
    async () => {
      const mock = createMockOutput();
      await logTask(
        "Root",
        { mode: "plain", output: mock.stream },
        async () => {
          await logTask(() => {
            const store = storage.getStore()!;
            assertEquals(store.node!.title, undefined);
          });
        },
      );
    },
  );

  await t.step(
    "logTask(options, fn) — title-less overload with options",
    async () => {
      const mock = createMockOutput();
      await logTask(
        "Root",
        { mode: "plain", output: mock.stream },
        async () => {
          await logTask(
            { tailLines: 2 },
            () => {
              const store = storage.getStore()!;
              assertEquals(store.node!.title, undefined);
              assertEquals(store.node!.tailLines, 2);
            },
          );
        },
      );
    },
  );

  await t.step(
    "title-less task children nest correctly under nearest titled ancestor",
    async () => {
      const mock = createMockOutput();
      await logTask(
        "Root",
        { mode: "plain", output: mock.stream },
        async () => {
          const rootStore = storage.getStore()!;
          const rootNode = rootStore.node!;

          await logTask(async () => {
            // Inside a title-less task
            const structuralStore = storage.getStore()!;
            const structuralNode = structuralStore.node!;
            assertEquals(structuralNode.title, undefined);
            assertEquals(structuralNode.parent, rootNode);

            await logTask("Visible Child", () => {
              const store = storage.getStore()!;
              assertEquals(store.node!.title, "Visible Child");
              // Parent is the structural node
              assertEquals(store.node!.parent, structuralNode);
              // Grandparent is root
              assertEquals(store.node!.parent!.parent, rootNode);
            });
          });

          // Structural task is a child of root
          assertEquals(rootNode.children.length, 1);
          assertEquals(rootNode.children[0].title, undefined);
          // Visible child is nested under structural
          assertEquals(rootNode.children[0].children.length, 1);
          assertEquals(rootNode.children[0].children[0].title, "Visible Child");
        },
      );
    },
  );
});
Deno.test(
  "log() outside any context falls back to process.stderr.write()",
  () => {
    // log() accesses process.env.LOG_FOLD_STRICT, needs --allow-env on the test task
    log("test line outside context");
    // If we get here without error, the fallback worked
  },
);

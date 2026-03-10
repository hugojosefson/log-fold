import { assertEquals, assertRejects } from "@std/assert";
import {
  log,
  logFold,
  setCurrentFoldSkipped,
  setCurrentFoldTitle,
  setCurrentFoldWarning,
} from "../src/context.ts";
import { storage } from "../src/storage.ts";
import { createMockOutput } from "./create-mock-output.ts";

Deno.test("context", async (t) => {
  await t.step(
    "logFold() outside any context auto-inits a session",
    async () => {
      const output = createMockOutput();
      const result = await logFold("Auto-init", {
        mode: "plain",
        output,
      }, () => {
        return 42;
      });
      assertEquals(result, 42);
      // The plain renderer should have written something
      assertEquals(output.lines.length > 0, true);
    },
  );

  await t.step("nested logFold() calls create correct hierarchy", async () => {
    const output = createMockOutput();
    await logFold("Root", { mode: "plain", output }, async () => {
      await logFold("Child", async () => {
        await logFold("Grandchild", () => {
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
    "Promise.all with multiple logFold() → separate branches",
    async () => {
      const output = createMockOutput();
      await logFold(
        "Root",
        { mode: "plain", output },
        async () => {
          const parentStore = storage.getStore()!;
          const root = parentStore.node!;

          await Promise.all([
            logFold("Branch A", () => {
              const store = storage.getStore()!;
              assertEquals(store.node!.title, "Branch A");
              assertEquals(store.node!.parent, root);
            }),
            logFold("Branch B", () => {
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
    "log() goes to the correct fold in concurrent context",
    async () => {
      const output = createMockOutput();
      await logFold(
        "Root",
        { mode: "plain", output },
        async () => {
          await Promise.all([
            logFold("Fold A", () => {
              log("message from A");
              const store = storage.getStore()!;
              assertEquals(
                store.node!.logLines.includes("message from A"),
                true,
              );
            }),
            logFold("Fold B", () => {
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
    "logFold() with options at top level configures the session",
    async () => {
      const output = createMockOutput();
      await logFold(
        "Configured",
        { mode: "plain", output, tailLines: 3 },
        () => {
          const store = storage.getStore()!;
          assertEquals(store.node!.tailLines, 3);
        },
      );
    },
  );

  await t.step(
    "logFold() with session options at nested level throws",
    async () => {
      const output = createMockOutput();
      await assertRejects(
        async () => {
          await logFold(
            "Root",
            { mode: "plain", output },
            async () => {
              await logFold(
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
    "logFold() with per-fold options (map/filter) at nested level works",
    async () => {
      const output = createMockOutput();
      await logFold(
        "Root",
        { mode: "plain", output },
        async () => {
          await logFold(
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
      const output = createMockOutput();
      await logFold(
        "Root",
        {
          mode: "plain",
          output,
          filter: (line: string) => !line.includes("SECRET"),
        },
        async () => {
          await logFold(
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
      const output = createMockOutput();
      try {
        await logFold(
          "Root",
          {
            mode: "plain",
            output,
            filter: (line: string) => !line.includes("SECRET"),
          },
          async () => {
            await logFold("Failing", () => {
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
      const outputText = output.lines.join("");
      assertEquals(outputText.includes("SECRET"), false);
      assertEquals(outputText.includes("normal line"), true);
    },
  );

  await t.step(
    "original lines always preserved in logLines[] regardless of map/filter",
    async () => {
      const output = createMockOutput();
      await logFold(
        "Root",
        {
          mode: "plain",
          output,
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
    "setCurrentFoldWarning() sets fold status to warning",
    async () => {
      const output = createMockOutput();
      await logFold("Warned", { mode: "plain", output }, () => {
        setCurrentFoldWarning();

        const store = storage.getStore()!;
        assertEquals(store.node!.status, "warning");
      });

      // After completion, status should still be warning (not overridden to success)
      assertEquals(output.lines.some((line) => line.includes("⚠")), true);
    },
  );

  await t.step(
    "setCurrentFoldSkipped() sets fold status to skipped",
    async () => {
      const output = createMockOutput();
      await logFold("Skipped", { mode: "plain", output }, () => {
        setCurrentFoldSkipped();

        const store = storage.getStore()!;
        assertEquals(store.node!.status, "skipped");
      });

      // After completion, status should still be skipped (not overridden to success)
      assertEquals(output.lines.some((line) => line.includes("⊘")), true);
    },
  );

  await t.step("setCurrentFoldTitle() updates fold title", async () => {
    const output = createMockOutput();
    await logFold("Original", { mode: "plain", output }, () => {
      setCurrentFoldTitle("Updated");

      const store = storage.getStore()!;
      assertEquals(store.node!.title, "Updated");
    });
  });

  await t.step(
    "logFold(fn) — title-less overload creates structural-only fold",
    async () => {
      const output = createMockOutput();
      await logFold(
        "Root",
        { mode: "plain", output },
        async () => {
          await logFold(() => {
            const store = storage.getStore()!;
            assertEquals(store.node!.title, undefined);
          });
        },
      );
    },
  );

  await t.step(
    "logFold(options, fn) — title-less overload with options",
    async () => {
      const output = createMockOutput();
      await logFold(
        "Root",
        { mode: "plain", output },
        async () => {
          await logFold(
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
    "title-less fold children nest correctly under nearest titled ancestor",
    async () => {
      const output = createMockOutput();
      await logFold(
        "Root",
        { mode: "plain", output },
        async () => {
          const rootStore = storage.getStore()!;
          const rootNode = rootStore.node!;

          await logFold(async () => {
            // Inside a title-less fold
            const structuralStore = storage.getStore()!;
            const structuralNode = structuralStore.node!;
            assertEquals(structuralNode.title, undefined);
            assertEquals(structuralNode.parent, rootNode);

            await logFold("Visible Child", () => {
              const store = storage.getStore()!;
              assertEquals(store.node!.title, "Visible Child");
              // Parent is the structural node
              assertEquals(store.node!.parent, structuralNode);
              // Grandparent is root
              assertEquals(store.node!.parent!.parent, rootNode);
            });
          });

          // Structural fold is a child of root
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
    // log() accesses process.env.LOG_FOLD_STRICT, needs --allow-env on the test fold
    log("test line outside context");
    // If we get here without error, the fallback worked
  },
);

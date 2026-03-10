import { assertEquals, assertRejects } from "@std/assert";
import { log, logFold } from "../mod.ts";
import type { WriteStreamLike } from "../src/renderer/write-stream-like.ts";

/** Create a mock writable stream that collects output. */
function createMockOutput(): WriteStreamLike & { lines: string[] } {
  const lines: string[] = [];
  return {
    write(s: string): boolean {
      lines.push(s);
      return true;
    },
    lines,
  };
}

Deno.test({
  name: "log-fold integration",
  sanitizeOps: false,
  fn: async (t) => {
    await t.step("sequential folds run and complete", async () => {
      const output = createMockOutput();
      await logFold("Root", { mode: "plain" as const, output }, async () => {
        await logFold("Step 1", () => {
          log("doing step 1");
        });
        await logFold("Step 2", () => {
          log("doing step 2");
        });
      });

      const allOutput = output.lines.join("");
      // Both folds started and completed
      assertEquals(
        allOutput.includes("Step 1") && allOutput.includes("✓"),
        true,
      );
      assertEquals(allOutput.includes("Step 2"), true);
      assertEquals(allOutput.includes("doing step 1"), true);
      assertEquals(allOutput.includes("doing step 2"), true);
    });

    await t.step("concurrent folds via Promise.all", async () => {
      const output = createMockOutput();
      await logFold("Root", { mode: "plain" as const, output }, async () => {
        await Promise.all([
          logFold("Fold A", () => {
            log("running A");
          }),
          logFold("Fold B", () => {
            log("running B");
          }),
        ]);
      });

      const allOutput = output.lines.join("");
      assertEquals(allOutput.includes("Fold A"), true);
      assertEquals(allOutput.includes("Fold B"), true);
      assertEquals(allOutput.includes("running A"), true);
      assertEquals(allOutput.includes("running B"), true);
    });

    await t.step(
      "error: fold fails, error captured, full log available",
      async () => {
        const output = createMockOutput();
        await assertRejects(
          async () => {
            await logFold(
              "Root",
              { mode: "plain" as const, output },
              async () => {
                await logFold("Failing", () => {
                  log("before error");
                  log("more output");
                  throw new Error("test failure");
                });
              },
            );
          },
          Error,
          "test failure",
        );

        const allOutput = output.lines.join("");
        // Failed fold marked with ✗
        assertEquals(allOutput.includes("✗"), true);
        assertEquals(allOutput.includes("ERROR"), true);
        // Error dump includes the log lines (after composedFlatMap)
        assertEquals(allOutput.includes("before error"), true);
      },
    );

    await t.step("nested error propagates to parent", async () => {
      const output = createMockOutput();
      await assertRejects(
        async () => {
          await logFold(
            "Root",
            { mode: "plain" as const, output },
            async () => {
              await logFold("Parent", async () => {
                await logFold("Child", () => {
                  throw new Error("deep error");
                });
              });
            },
          );
        },
        Error,
        "deep error",
      );

      const allOutput = output.lines.join("");
      // Both parent and child show as failed
      assertEquals(allOutput.includes("✗"), true);
    });

    await t.step(
      "error dump applies composedFlatMap (secrets redacted)",
      async () => {
        const output = createMockOutput();
        await assertRejects(
          async () => {
            await logFold(
              "Root",
              {
                mode: "plain" as const,
                output,
                filter: (line: string) => !line.includes("SECRET"),
              },
              () => {
                log("visible line");
                log("SECRET token: abc123");
                log("another visible");
                throw new Error("crash");
              },
            );
          },
          Error,
          "crash",
        );

        const allOutput = output.lines.join("");
        // SECRET line should not appear anywhere (filtered by composedFlatMap)
        assertEquals(allOutput.includes("SECRET"), false);
        // visible lines should appear
        assertEquals(allOutput.includes("visible line"), true);
        assertEquals(allOutput.includes("another visible"), true);
      },
    );

    await t.step(
      "error dump preserves all lines that pass composedFlatMap",
      async () => {
        const output = createMockOutput();
        await assertRejects(
          async () => {
            await logFold(
              "Root",
              {
                mode: "plain" as const,
                output,
                map: (line: string) => line.replace(/\/home\/user/g, "~"),
              },
              () => {
                log("/home/user/src/main.ts");
                log("normal line");
                throw new Error("crash");
              },
            );
          },
          Error,
          "crash",
        );

        const allOutput = output.lines.join("");
        // Mapped line should appear in the dump
        assertEquals(allOutput.includes("~/src/main.ts"), true);
        // Original path should not appear (was mapped)
        assertEquals(allOutput.includes("/home/user/src/main.ts"), false);
        // Normal line should appear
        assertEquals(allOutput.includes("normal line"), true);
      },
    );

    await t.step(
      "concurrent error via Promise.all: orphaned sibling remains running",
      async () => {
        const output = createMockOutput();
        // Track timer for cleanup when Promise.all rejects
        let timerId: ReturnType<typeof setTimeout> | undefined;
        await assertRejects(
          async () => {
            await logFold(
              "Root",
              { mode: "plain" as const, output },
              async () => {
                await Promise.all([
                  logFold("Fast fail", () => {
                    throw new Error("fast error");
                  }),
                  logFold("Slow sibling", async () => {
                    // This fold starts but never gets to complete because
                    // Promise.all rejects on first failure
                    await new Promise((resolve) => {
                      timerId = setTimeout(resolve, 100);
                    });
                    log("should not reach here");
                  }),
                ]);
              },
            );
          },
          Error,
          "fast error",
        );
        // Clean up orphaned timer to avoid leak detection
        if (timerId !== undefined) {
          clearTimeout(timerId);
        }

        // The test passes if the error propagates correctly
        // Orphaned sibling folds remain in running status (per design)
        const allOutput = output.lines.join("");
        assertEquals(allOutput.includes("Fast fail"), true);
      },
    );

    await t.step(
      "Promise.allSettled: all branches complete before parent handles errors",
      async () => {
        const output = createMockOutput();
        const results = await logFold(
          "Root",
          { mode: "plain" as const, output },
          async () => {
            return await Promise.allSettled([
              logFold("Succeeder", () => {
                log("success output");
                return "ok";
              }),
              logFold("Failer", () => {
                log("fail output");
                throw new Error("planned failure");
              }),
            ]);
          },
        );

        // Both folds completed
        assertEquals(results.length, 2);
        assertEquals(results[0].status, "fulfilled");
        assertEquals(results[1].status, "rejected");

        const allOutput = output.lines.join("");
        // Both folds' output visible
        assertEquals(allOutput.includes("success output"), true);
        assertEquals(allOutput.includes("fail output"), true);
      },
    );
  },
});

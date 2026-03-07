import { assertEquals, assertRejects } from "@std/assert";
import { logTask } from "../mod.ts";
import type { WriteStreamLike } from "../src/renderer/write-stream-like.ts";
import { runCommand } from "../src/run-command.ts";

/** Create a mock writable stream that collects output. */
function mockStream(): WriteStreamLike & { lines: string[] } {
  const lines: string[] = [];
  return {
    write(s: string): boolean {
      lines.push(s);
      return true;
    },
    lines,
  };
}

Deno.test("runCommand", async (t) => {
  await t.step("echo hello: log contains 'hello'", async () => {
    const output = mockStream();
    const result = await logTask(
      "Root",
      { mode: "plain" as const, output },
      async () => {
        return await runCommand(["echo", "hello"]);
      },
    );

    assertEquals(result.code, 0);
    assertEquals(result.stdout.includes("hello"), true);

    const allOutput = output.lines.join("");
    assertEquals(allOutput.includes("hello"), true);
  });

  await t.step("failing command: task fails", async () => {
    const output = mockStream();
    await assertRejects(
      async () => {
        await logTask(
          "Root",
          { mode: "plain" as const, output },
          async () => {
            return await runCommand(["false"]);
          },
        );
      },
      Error,
      "Command failed",
    );
  });

  await t.step("stdout and stderr both captured", async () => {
    const output = mockStream();
    const result = await logTask(
      "Root",
      { mode: "plain" as const, output },
      async () => {
        // echo to stdout; redirect stderr message via sh -c
        return await runCommand([
          "sh",
          "-c",
          "echo stdout-text && echo stderr-text >&2",
        ]);
      },
    );

    // stdout is in return value
    assertEquals(result.stdout.includes("stdout-text"), true);

    // Both stdout and stderr appear in log output
    const allOutput = output.lines.join("");
    assertEquals(allOutput.includes("stdout-text"), true);
    assertEquals(allOutput.includes("stderr-text"), true);
  });

  await t.step("auto-nests under current task", async () => {
    const output = mockStream();
    await logTask(
      "Parent",
      { mode: "plain" as const, output },
      async () => {
        await runCommand(["echo", "nested"]);
      },
    );

    const allOutput = output.lines.join("");
    // The runCommand creates a sub-task with the command as title
    // It should appear nested under Parent in the plain renderer output
    assertEquals(allOutput.includes("Parent"), true);
    assertEquals(allOutput.includes("echo nested"), true);
    assertEquals(allOutput.includes("nested"), true);
  });
});

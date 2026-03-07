import { assertEquals } from "@std/assert";
import { Readable } from "node:stream";
import { logFromStream, logTask } from "../mod.ts";
import type { WriteStreamLike } from "../src/renderer/write-stream-like.ts";

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

/** Create a Node.js Readable from an array of strings, emitting them as line-delimited bytes. */
function readableFromLines(lines: string[]): Readable {
  const content = lines.join("\n");
  const encoder = new TextEncoder();
  return Readable.from([encoder.encode(content)]);
}

/** Create a web ReadableStream<Uint8Array> from text. */
function webStreamFromText(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

/** Async generator that yields strings. */
async function* asyncGen(
  items: string[],
): AsyncGenerator<string, void, unknown> {
  for (const item of items) {
    yield item;
  }
}

Deno.test("logFromStream", async (t) => {
  await t.step(
    "Node.js Readable lines split correctly, all collected",
    async () => {
      const output = mockStream();
      const result = await logTask(
        "test",
        { mode: "plain" as const, output },
        async () => {
          const readable = readableFromLines([
            "line one",
            "line two",
            "line three",
          ]);
          return await logFromStream(readable);
        },
      );

      assertEquals(result, "line one\nline two\nline three");
    },
  );

  await t.step(
    "Web ReadableStream<Uint8Array> converted and split correctly",
    async () => {
      const output = mockStream();
      const result = await logTask(
        "test",
        { mode: "plain" as const, output },
        async () => {
          const ws = webStreamFromText("alpha\nbeta\ngamma");
          return await logFromStream(ws);
        },
      );

      assertEquals(result, "alpha\nbeta\ngamma");
    },
  );

  await t.step(
    "StreamPair: both piped to log(), only stdout in return value",
    async () => {
      const output = mockStream();
      const result = await logTask(
        "test",
        { mode: "plain" as const, output },
        async () => {
          const pair = {
            stdout: readableFromLines(["stdout-a", "stdout-b"]),
            stderr: readableFromLines(["stderr-x"]),
          };
          return await logFromStream(pair);
        },
      );

      // Return value contains only stdout
      assertEquals(result, "stdout-a\nstdout-b");

      // stderr was piped to log() — check output contains stderr lines
      const allOutput = output.lines.join("");
      assertEquals(allOutput.includes("stderr-x"), true);
    },
  );

  await t.step(
    "StreamPair with only stderr returns empty string, stderr still piped",
    async () => {
      const output = mockStream();
      const result = await logTask(
        "test",
        { mode: "plain" as const, output },
        async () => {
          const pair = {
            stderr: readableFromLines(["err-line-1", "err-line-2"]),
          };
          return await logFromStream(pair);
        },
      );

      // No stdout → empty string
      assertEquals(result, "");

      // stderr was still piped to log()
      const allOutput = output.lines.join("");
      assertEquals(allOutput.includes("err-line-1"), true);
    },
  );

  await t.step(
    "AsyncIterable<string>: each yielded string passed to log(), multi-line yields split correctly",
    async () => {
      const output = mockStream();
      const result = await logTask(
        "test",
        { mode: "plain" as const, output },
        async () => {
          return await logFromStream(asyncGen(["hello", "multi\nline"]));
        },
      );

      // The async iterable yields "hello" and "multi\nline"
      // logFromStream collects pre-split strings, joined and trimmed
      // Result includes both yields joined
      assertEquals(result, "hello\nmulti\nline");
    },
  );

  await t.step(
    "Array of streams processed concurrently, all lines collected",
    async () => {
      const output = mockStream();
      const result = await logTask(
        "test",
        { mode: "plain" as const, output },
        async () => {
          const streams = [
            readableFromLines(["stream1-a", "stream1-b"]),
            readableFromLines(["stream2-x"]),
          ];
          return await logFromStream(streams);
        },
      );

      // All lines from both streams collected
      assertEquals(result.includes("stream1-a"), true);
      assertEquals(result.includes("stream1-b"), true);
      assertEquals(result.includes("stream2-x"), true);
    },
  );

  await t.step(
    "input detection priority: Node.js Readable not misidentified as AsyncIterable",
    async () => {
      const output = mockStream();
      // Node.js Readable has Symbol.asyncIterator, but should be detected as Readable (pipe-based)
      const result = await logTask(
        "test",
        { mode: "plain" as const, output },
        async () => {
          const readable = readableFromLines(["detected-as-readable"]);
          return await logFromStream(readable);
        },
      );

      // If misidentified as AsyncIterable, raw byte chunks would be yielded
      // instead of line-split strings. Correct detection splits lines.
      assertEquals(result, "detected-as-readable");
    },
  );

  await t.step(
    "concurrent streams on StreamPair: lines arrive without corruption",
    async () => {
      const output = mockStream();
      const result = await logTask(
        "test",
        { mode: "plain" as const, output },
        async () => {
          // Create concurrent stdout/stderr with distinct content
          const pair = {
            stdout: readableFromLines(["out-1", "out-2", "out-3"]),
            stderr: readableFromLines(["err-1", "err-2"]),
          };
          return await logFromStream(pair);
        },
      );

      // stdout lines in return value (no corruption from stderr interleaving)
      assertEquals(result, "out-1\nout-2\nout-3");

      // All lines (stdout + stderr) appear in the output without corruption
      const allOutput = output.lines.join("");
      assertEquals(allOutput.includes("out-1"), true);
      assertEquals(allOutput.includes("err-1"), true);
    },
  );

  await t.step("empty stream returns empty string", async () => {
    const output = mockStream();
    const result = await logTask(
      "test",
      { mode: "plain" as const, output },
      async () => {
        const readable = readableFromLines([]);
        return await logFromStream(readable);
      },
    );

    assertEquals(result, "");
  });
});

Deno.test(
  "logFromStream outside task context: falls back to process.stderr via log()",
  async () => {
    // logFromStream outside a task context should still work
    // (log() falls back to process.stderr)
    // It still collects and returns lines
    const readable = readableFromLines(["fallback-line"]);
    const result = await logFromStream(readable);
    assertEquals(result, "fallback-line");
  },
);

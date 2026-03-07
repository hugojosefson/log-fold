import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { log } from "./context.ts";

/** A Node.js Readable or a web ReadableStream<Uint8Array>. */
export type AnyReadable = Readable | ReadableStream<Uint8Array>;

/** An object with optional stdout and/or stderr streams. */
export type StreamPair = {
  stdout?: AnyReadable | undefined;
  stderr?: AnyReadable | undefined;
};

/** What logFromStream accepts. */
export type LogFromStreamInput =
  | AnyReadable
  | AnyReadable[]
  | StreamPair
  | AsyncIterable<string>;

/**
 * Pipe one or more streams into the current task's log.
 * Reads all streams concurrently; lines go to log() in event-loop arrival order.
 *
 * Collects lines locally (not from node.logLines) so that concurrent log()
 * calls from other code don't contaminate the return value.
 *
 * For StreamPair inputs, only stdout lines are collected for the return value.
 * Stderr lines are piped to log() for display but excluded from the returned string.
 *
 * Returns collected lines joined with "\n" and .trim()'d.
 */
export async function logFromStream(
  input: LogFromStreamInput,
): Promise<string> {
  const collected: string[] = [];

  // 1. Array → process each concurrently, collect all lines
  if (Array.isArray(input)) {
    await Promise.all(
      input.map((stream) => pipeAnyReadable(stream, collected)),
    );
    return collected.join("\n").trim();
  }

  // 2. StreamPair: has .stdout or .stderr AND input itself is NOT a stream
  if (isStreamPair(input)) {
    await Promise.all([
      pipeAnyReadable(input.stdout, collected),
      pipeAnyReadable(input.stderr),
    ]);
    return collected.join("\n").trim();
  }

  // 3. Web ReadableStream (has .getReader())
  if (hasGetReader(input)) {
    await pipeAnyReadable(input, collected);
    return collected.join("\n").trim();
  }

  // 4. Node.js Readable (has .pipe())
  if (hasPipe(input)) {
    await pipeAnyReadable(input, collected);
    return collected.join("\n").trim();
  }

  // 5. AsyncIterable<string>
  if (hasAsyncIterator(input)) {
    for await (const line of input) {
      log(line);
      collected.push(line);
    }
    return collected.join("\n").trim();
  }

  throw new Error(`logFromStream: unrecognized input type: ${input}`);
}

/** Pipe any single AnyReadable stream, collecting lines into any supplied array. */
function pipeAnyReadable(
  stream: AnyReadable | undefined,
  collected?: string[],
): Promise<void> {
  if (!stream) {
    return Promise.resolve();
  }
  const readable = toReadable(stream);
  return pipeReadable(readable, collected);
}

/**
 * Pipe a single Node.js Readable into log(), collecting lines into any provided array.
 */
function pipeReadable(
  readable: Readable,
  collected?: string[],
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const rl = createInterface({ input: readable });
    rl.on("line", (line) => {
      log(line);
      collected?.push(line);
    });
    rl.on("close", resolve);
    rl.on("error", reject);
  });
}

/** Check if an object has a .pipe() method (Node.js Readable). */
function hasPipe(input: unknown): input is Readable {
  return typeof (input as Record<string, unknown>).pipe === "function";
}

/** Check if an object has a .getReader() method (web ReadableStream). */
function hasGetReader(
  input: unknown,
): input is ReadableStream<Uint8Array> {
  return typeof (input as Record<string, unknown>).getReader === "function";
}

/** Check if an object has Symbol.asyncIterator. */
function hasAsyncIterator(
  input: unknown,
): input is AsyncIterable<string> {
  return typeof (input as Record<symbol, unknown>)[Symbol.asyncIterator] ===
    "function";
}

/** Check if the input is a StreamPair (has .stdout or .stderr, but is not itself a stream). */
function isStreamPair(input: unknown): input is StreamPair {
  const obj = input as Record<string, unknown>;
  const hasStreams = "stdout" in obj || "stderr" in obj;
  if (!hasStreams) {
    return false;
  }
  // Exclude objects that are themselves streams
  if (hasPipe(input) || hasGetReader(input)) {
    return false;
  }
  return true;
}

/** Convert a web ReadableStream to a Node.js Readable. */
function toNodeReadable(
  webStream: ReadableStream<Uint8Array>,
): Readable {
  // Readable.fromWeb expects a web ReadableStream
  return Readable.fromWeb(webStream as Parameters<typeof Readable.fromWeb>[0]);
}

/** Convert an AnyReadable to a Node.js Readable. */
function toReadable(stream: AnyReadable): Readable {
  if (hasPipe(stream)) {
    return stream;
  }
  return toNodeReadable(stream as ReadableStream<Uint8Array>);
}

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

/** Convert a web ReadableStream to a Node.js Readable. */
function toNodeReadable(
  webStream: ReadableStream<Uint8Array>,
): Readable {
  // Readable.fromWeb expects a web ReadableStream
  return Readable.fromWeb(webStream as Parameters<typeof Readable.fromWeb>[0]);
}

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
      input.map((stream) => pipeSingleStream(stream, collected)),
    );
    return collected.join("\n").trim();
  }

  // 2. StreamPair: has .stdout or .stderr AND input itself is NOT a stream
  if (isStreamPair(input)) {
    const promises: Promise<void>[] = [];
    const pair = input as StreamPair;
    if (pair.stdout) {
      const readable = toReadable(pair.stdout);
      promises.push(pipeReadable(readable, collected));
    }
    if (pair.stderr) {
      const readable = toReadable(pair.stderr);
      promises.push(pipeReadable(readable));
    }
    await Promise.all(promises);
    return collected.join("\n").trim();
  }

  // 3. Web ReadableStream (has .getReader())
  if (hasGetReader(input)) {
    const readable = toNodeReadable(input);
    await pipeReadable(readable, collected);
    return collected.join("\n").trim();
  }

  // 4. Node.js Readable (has .pipe())
  if (hasPipe(input)) {
    await pipeReadable(input, collected);
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

  throw new Error("logFromStream: unrecognized input type");
}

/** Check if the input is a StreamPair (has .stdout or .stderr, but is not itself a stream). */
function isStreamPair(input: unknown): input is StreamPair {
  const obj = input as Record<string, unknown>;
  const hasStreams = "stdout" in obj || "stderr" in obj;
  if (!hasStreams) return false;
  // Exclude objects that are themselves streams
  if (hasPipe(input) || hasGetReader(input)) return false;
  return true;
}

/** Convert an AnyReadable to a Node.js Readable. */
function toReadable(stream: AnyReadable): Readable {
  if (hasPipe(stream)) return stream;
  return toNodeReadable(stream as ReadableStream<Uint8Array>);
}

/** Pipe a single AnyReadable stream, collecting lines. */
function pipeSingleStream(
  stream: AnyReadable,
  collected: string[],
): Promise<void> {
  const readable = toReadable(stream);
  return pipeReadable(readable, collected);
}

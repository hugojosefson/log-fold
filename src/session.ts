import process from "node:process";
import type { WriteStream } from "node:tty";
import { createPlainRenderer } from "./renderer/plain-renderer.ts";
import type { Renderer } from "./renderer/renderer.ts";
import { createTtyRenderer } from "./renderer/tty-renderer.ts";
import type { WriteStreamLike } from "./renderer/write-stream-like.ts";
import type { TaskNode } from "./task-node.ts";

// Re-export types from task-node.ts for convenience
export type { Spinner, TaskOptions } from "./task-node.ts";

/** Session configuration options. Only apply at the top-level logTask() call. */
export type SessionOptions = {
  /** Force TTY or plain mode. Default: "auto" (detect via isTTY). */
  mode?: "tty" | "plain" | "auto";
  /** Render tick interval in ms. Default: 150. */
  tickInterval?: number;
  /**
   * Output stream. Default: process.stderr.
   * When mode is "tty", must be a tty.WriteStream (for cursor methods).
   * When mode is "plain", any Writable with write() works.
   */
  output?: WriteStream | WriteStreamLike;
};

export const SESSION_OPTIONS_KEYS: (keyof SessionOptions)[] = [
  "mode",
  "tickInterval",
  "output",
] as const;

/** Check if a stream has the required TTY WriteStream methods. */
function isTtyWriteStream(
  stream: unknown,
): stream is WriteStream {
  return (
    typeof stream === "object" &&
    stream !== null &&
    "cursorTo" in stream &&
    "moveCursor" in stream &&
    "clearLine" in stream &&
    "clearScreenDown" in stream &&
    "isTTY" in stream
  );
}

/** Internal Session class — owns the task tree and renderer. */
export class Session {
  root!: TaskNode;
  readonly renderer: Renderer;
  readonly output: WriteStream | WriteStreamLike;

  constructor(options?: SessionOptions) {
    const output = options?.output ?? process.stderr;
    const mode = options?.mode ?? "auto";
    const tickInterval = options?.tickInterval ?? 150;

    this.output = output;

    if (mode === "tty" || (mode === "auto" && isTtyWriteStream(output))) {
      // TTY mode requires a WriteStream with cursor methods
      if (!isTtyWriteStream(output)) {
        throw new Error(
          "TTY mode requires a tty.WriteStream with cursorTo, moveCursor, " +
            "clearLine, and clearScreenDown methods (e.g., process.stderr). " +
            "Use mode: 'plain' for non-TTY output streams.",
        );
      }
      this.renderer = createTtyRenderer(output, tickInterval);
    } else {
      this.renderer = createPlainRenderer(output);
    }
  }
}

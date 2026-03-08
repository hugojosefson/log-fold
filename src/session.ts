import process from "node:process";
import type { WriteStream } from "node:tty";
import { createPlainRenderer } from "./renderer/plain-renderer.ts";
import type { Renderer } from "./renderer/renderer.ts";
import { createTtyRenderer } from "./renderer/tty-renderer.ts";
import type { WriteStreamLike } from "./renderer/write-stream-like.ts";
import type { TaskNode } from "./task-node.ts";

export type Mode = "tty" | "plain" | "auto";

/** Session configuration options. Only apply at the top-level logTask() call. */
export type SessionOptions = {
  /** Attempt to force TTY or plain mode. Default: "auto" (detect via isTTY). */
  mode?: Mode;
  /** Render tick interval in ms. Default: 150. */
  tickInterval?: number;
  /**
   * Output stream. Default: process.stderr.
   * When mode is "tty", must be a tty.WriteStream (for cursor methods), otherwise "plain" will be used instead.
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

function shouldUseTty(
  mode: Mode,
  output: WriteStream | WriteStreamLike,
): output is WriteStream {
  if (mode === "auto" || mode === "tty") {
    if (isTtyWriteStream(output)) {
      return true;
    }
  }
  return false;
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

    this.renderer = shouldUseTty(mode, output)
      ? createTtyRenderer(output, tickInterval)
      : createPlainRenderer(output);
  }
}

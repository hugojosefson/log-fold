import type { WriteStreamLike } from "../src/renderer/write-stream-like.ts";

/** Create a mock output that captures output. */
export function createMockOutput(): WriteStreamLike & { lines: string[] } {
  const lines: string[] = [];
  return {
    write(s: string): boolean {
      lines.push(s);
      return true;
    },
    lines,
  };
}

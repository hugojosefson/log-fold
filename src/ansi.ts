/**
 * Minimal ANSI escape sequences for terminal cursor control and screen manipulation.
 *
 * This is intentionally small — only what's needed for frame-based re-rendering.
 * A full VT100 emulator for parsing subprocess output would plug in separately.
 */

const ESC = "\x1b[";

/** Move cursor up by `n` lines. */
export function cursorUp(n: number): string {
  return n > 0 ? `${ESC}${n}A` : "";
}

/** Move cursor to column 0 of the current line. */
export const cursorColumn0: string = `${ESC}0G`;

/** Erase from cursor to end of screen. */
export const eraseDown: string = `${ESC}J`;

/** Erase the entire current line. */
export const eraseLine: string = `${ESC}2K`;

/** Hide the cursor. */
export const hideCursor: string = `${ESC}?25l`;

/** Show the cursor. */
export const showCursor: string = `${ESC}?25h`;

const encoder = new TextEncoder();

/** Write a string directly to a writable stream (sync-compatible via Uint8Array). */
export function writeSync(
  s: string,
  writer: { writeSync(p: Uint8Array): number } = Deno.stdout,
): void {
  writer.writeSync(encoder.encode(s));
}

// AsyncLocalStorage convenience functions (primary API)
export { log, logFold } from "./src/context.ts";
export {
  setCurrentFoldSkipped,
  setCurrentFoldTitle,
  setCurrentFoldWarning,
} from "./src/context.ts";

// Stream piping
export { logFromStream } from "./src/log-from-stream.ts";
export type {
  AnyReadable,
  LogFromStreamInput,
  StreamPair,
} from "./src/log-from-stream.ts";

// Subprocess wrapper
export { runCommand } from "./src/run-command.ts";
export type {
  CommandArray,
  RunCommandOptions,
  RunCommandResult,
} from "./src/run-command.ts";

// Types
export type { SessionOptions } from "./src/session.ts";
export type { FoldOptions, Spinner } from "./src/fold-node.ts";
export type { FoldNode, FoldStatus } from "./src/fold-node.ts";

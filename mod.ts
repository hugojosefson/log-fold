// AsyncLocalStorage convenience functions (primary API)
export { log, logTask } from "./src/context.ts";
export {
  setCurrentTaskSkipped,
  setCurrentTaskTitle,
  setCurrentTaskWarning,
} from "./src/context.ts";

// Stream piping
export { logFromStream } from "./src/log-from-stream.ts";
export type {
  AnyReadable,
  LogFromStreamInput,
  StreamPair,
} from "./src/log-from-stream.ts";

// Types
export type { SessionOptions } from "./src/session.ts";
export type { Spinner, TaskOptions } from "./src/task-node.ts";
export type { TaskNode, TaskStatus } from "./src/task-node.ts";

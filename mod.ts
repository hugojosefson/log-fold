// AsyncLocalStorage convenience functions (primary API)
export { log, logTask } from "./src/context.ts";
export {
  setCurrentTaskSkipped,
  setCurrentTaskTitle,
  setCurrentTaskWarning,
} from "./src/context.ts";

// Types
export type { SessionOptions, Spinner, TaskOptions } from "./src/session.ts";
export type { TaskNode, TaskStatus } from "./src/task-node.ts";

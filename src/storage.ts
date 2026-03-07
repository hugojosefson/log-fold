import { AsyncLocalStorage } from "node:async_hooks";
import type { Session } from "./session.ts";
import type { TaskNode } from "./task-node.ts";

export type ContextStore = {
  session: Session;
  node: TaskNode | undefined;
};

export const storage = new AsyncLocalStorage<ContextStore>();

import { AsyncLocalStorage } from "node:async_hooks";
import type { Session } from "./session.ts";
import type { FoldNode } from "./fold-node.ts";

export type ContextStore = {
  session: Session;
  node: FoldNode | undefined;
};

export const storage = new AsyncLocalStorage<ContextStore>();

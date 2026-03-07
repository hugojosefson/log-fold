import type { TasksProgress } from "./task-node.ts";

/**
 * Formats a duration in milliseconds for display.
 *
 * Auto-scales to relevant number of digits, decimal places.
 */
export function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 1) {
    return `${s.toFixed(2)}s`;
  }
  if (s < 60) {
    return `${s.toFixed(1)}s`;
  }

  const m = Math.floor(s / 60);
  if (s < 3600) {
    return `${m}m ${Math.floor(s % 60)}s`;
  }

  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatTasksProgress(progress: TasksProgress) {
  return `${progress.completed}/${progress.total}`;
}

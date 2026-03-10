import { spawn, type SpawnOptions } from "node:child_process";
import { logTask, setCurrentTaskWarning } from "./context.ts";
import { logFromStream } from "./log-from-stream.ts";

export type CommandArray = (string | number | boolean)[];

/** Options for runCommand, extending SpawnOptions but forcing stdio. */
export type RunCommandOptions = Omit<SpawnOptions, "stdio"> & {
  /**
   * Behavior on non-zero exit code. Default: true.
   * - true: throw an Error (task fails via the enclosing logTask catch)
   * - "warn": don't throw, set the task to warning status
   * - false: don't throw, task stays success
   */
  throwOnError?: boolean | "warn";
};

/** Result of a command execution. */
export type RunCommandResult = {
  /** Exit code, or undefined if the process was killed by a signal. */
  code: number | undefined;
  /** Signal name if killed, or undefined if exited normally. */
  signal: string | undefined;
  /** Captured stdout output (lines joined with "\n", .trim()'d). */
  stdout: string;
};

/**
 * Run a command as a sub-task, piping stdout+stderr to the task's log.
 * Auto-nests under the current task context (via AsyncLocalStorage).
 *
 * Stdin is always "ignore". Commands needing stdin should use
 * spawn() + logFromStream() directly.
 */
export async function runCommand(
  command: CommandArray,
  options?: RunCommandOptions,
): Promise<RunCommandResult>;

export async function runCommand(
  title: string,
  command: CommandArray,
  options?: RunCommandOptions,
): Promise<RunCommandResult>;
export function runCommand(
  titleOrCommand: string | CommandArray,
  commandOrOptions?: CommandArray | RunCommandOptions,
  maybeOptions?: RunCommandOptions,
): Promise<RunCommandResult> {
  const { title, command, options } = resolveRunCommandArgs(
    titleOrCommand,
    commandOrOptions,
    maybeOptions,
  );
  const { throwOnError = true, ...spawnOptions } = options ?? {};

  return logTask<RunCommandResult>(title, async () => {
    const child = spawn(`${command[0]}`, command.slice(1).map((c) => `${c}`), {
      ...spawnOptions,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout = await logFromStream(child);

    const { code, signal } = await new Promise<
      { code: number | undefined; signal: string | undefined }
    >((resolve) => {
      child.on("close", (exitCode, exitSignal) => {
        resolve({
          code: exitCode ?? undefined,
          signal: exitSignal ?? undefined,
        });
      });
    });

    const result: RunCommandResult = { code, signal, stdout };

    if (code !== 0 && code !== undefined) {
      if (throwOnError === true) {
        throw new Error(`Command failed with exit code ${code}`);
      }
      if (throwOnError === "warn") {
        setCurrentTaskWarning();
      }
    }

    return result;
  });
}

function resolveRunCommandArgs(
  titleOrCommand: string | CommandArray,
  commandOrOptions?: CommandArray | RunCommandOptions,
  maybeOptions?: RunCommandOptions,
): { title: string; command: CommandArray; options?: RunCommandOptions } {
  if (Array.isArray(titleOrCommand)) {
    // runCommand(command, options?)
    const command = titleOrCommand;
    return {
      title: command.join(" "),
      command,
      options: commandOrOptions as RunCommandOptions | undefined,
    };
  }

  // runCommand(title, command, options?)
  return {
    title: titleOrCommand,
    command: commandOrOptions as CommandArray,
    options: maybeOptions,
  };
}

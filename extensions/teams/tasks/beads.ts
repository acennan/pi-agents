/**
 * Beads CLI preflight helpers.
 *
 * Teams depend on `br` being available in the target workspace before any
 * agents start claiming tasks, so TF-04 validates that contract up front.
 */

import { execFile as execFileCallback } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

/** User-facing beads setup failure. */
export class BeadsPreflightError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BeadsPreflightError";
  }
}

export const defaultCommandRunner: CommandRunner = async (
  command,
  args,
  options,
) => {
  try {
    const result = await execFile(command, args, {
      cwd: options?.cwd,
      encoding: "utf8",
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Command failed: ${command} ${args.join(" ")} (${message})`,
      { cause: err },
    );
  }
};

/**
 * Verify that `br` is installed and usable from the target workspace.
 *
 * We run a read-only query (`br ready --json`) because it checks both CLI
 * availability and that the workspace has a beads instance the team can read.
 */
export async function validateBeadsWorkspace(
  workspacePath: string,
  options: { runner?: CommandRunner } = {},
): Promise<void> {
  const runner = options.runner ?? defaultCommandRunner;
  const resolvedWorkspacePath = resolve(workspacePath);

  try {
    await runner("br", ["ready", "--json"], {
      cwd: resolvedWorkspacePath,
    });
  } catch (err: unknown) {
    throw new BeadsPreflightError(
      `Beads is not available or not initialized for workspace "${resolvedWorkspacePath}". ` +
        `Run beads setup first and verify that the \`br\` CLI works in this repository.`,
      { cause: err },
    );
  }
}

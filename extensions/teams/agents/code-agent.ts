/**
 * Standing code-agent helpers.
 *
 * TF-16 keeps the code-agent's direct beads write surface intentionally small:
 * selecting one ready task and atomically claiming it. Higher-level worktree and
 * implementation stages can build on this helper in later slices.
 */

import {
  type ClaimNextReadyBeadsTaskResult,
  type CommandRunner,
  claimNextReadyBeadsTask,
} from "../tasks/beads.ts";

export type ClaimCodeAgentTaskOptions = {
  workspacePath: string;
  agentName: string;
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
};

export async function claimCodeAgentTask(
  options: ClaimCodeAgentTaskOptions,
): Promise<ClaimNextReadyBeadsTaskResult> {
  return claimNextReadyBeadsTask(options.workspacePath, {
    runner: options.runner,
    actor: options.agentName,
    env: options.env,
  });
}

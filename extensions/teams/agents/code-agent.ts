/**
 * Standing code-agent helpers.
 *
 * TF-17 extends that flow so code agents also land in the correct lineage
 * worktree before implementation starts:
 * - brand-new tasks create `task-<id>` worktrees from `main`
 * - remedial or resumed tasks reuse the stored lineage branch/worktree
 */

import {
  type ClaimNextReadyBeadsTaskResult,
  type CommandRunner,
  claimNextReadyBeadsTask,
} from "../tasks/beads.ts";
import {
  type PrepareClaimedTaskLineageResult,
  prepareClaimedTaskLineage,
} from "../tasks/lineage.ts";

export type ClaimCodeAgentTaskOptions = {
  teamName: string;
  workspacePath: string;
  worktreeDir: string;
  agentName: string;
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
};

type UnclaimedCodeAgentTaskResult = ClaimNextReadyBeadsTaskResult & {
  task: undefined;
};

type ClaimedCodeAgentTaskResult = Omit<
  ClaimNextReadyBeadsTaskResult,
  "task"
> & {
  task: NonNullable<ClaimNextReadyBeadsTaskResult["task"]>;
} & PrepareClaimedTaskLineageResult;

export type ClaimCodeAgentTaskResult =
  | UnclaimedCodeAgentTaskResult
  | ClaimedCodeAgentTaskResult;

export async function claimCodeAgentTask(
  options: ClaimCodeAgentTaskOptions,
): Promise<ClaimCodeAgentTaskResult> {
  const claimResult = await claimNextReadyBeadsTask(options.workspacePath, {
    runner: options.runner,
    actor: options.agentName,
    env: options.env,
  });

  if (claimResult.task === undefined) {
    return {
      ...claimResult,
      task: undefined,
    };
  }

  const preparedLineage = await prepareClaimedTaskLineage({
    teamName: options.teamName,
    workspacePath: options.workspacePath,
    worktreeDir: options.worktreeDir,
    task: claimResult.task,
    runner: options.runner,
  });

  return {
    ...claimResult,
    ...preparedLineage,
  };
}

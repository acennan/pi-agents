/**
 * High-level lineage helpers.
 *
 * These helpers keep the beads linkage contract (`--parent`) aligned with the
 * team-owned lineage state used to reuse worktrees and branches across
 * remedial tasks.
 *
 * Beads currently stores one dependency row per `(issue_id, depends_on_id)`
 * pair, so a remedial task cannot simultaneously point at the same source task
 * via both `parent-child` and `discovered-from`.
 */

import { resolve } from "node:path";
import {
  BEADS_DEPENDENCY_TYPE_DISCOVERED_FROM,
  BEADS_DEPENDENCY_TYPE_PARENT_CHILD,
  type BeadsTask,
  type CommandRunner,
  createRemedialBeadsTask,
} from "./beads.ts";
import {
  attachTaskToLineage,
  getLineageRecordForTask,
  incrementLineageReviewCycle,
  type TaskLineageRecord,
  upsertLineageRecord,
} from "./lineage-state.ts";

export type InitializeTaskLineageOptions = {
  teamName: string;
  taskId: string;
  worktreePath: string;
  branchName: string;
  reviewCycleCount?: number;
};

export type CreateRemedialTaskLineageOptions = {
  teamName: string;
  workspacePath: string;
  originalTaskId: string;
  title: string;
  description?: string;
  priority?: number;
  issueType?: string;
  assignee?: string;
  labels?: readonly string[];
  actor?: string;
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
};

export type CreateRemedialTaskLineageResult = {
  task: BeadsTask;
  lineage: TaskLineageRecord;
};

export class TeamLineageError extends Error {
  readonly code: "lineage-update-failed" | "missing-lineage";

  constructor(
    code: TeamLineageError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TeamLineageError";
    this.code = code;
  }
}

export function lineageBranchName(taskId: string): string {
  return `task-${taskId}`;
}

export function lineageWorktreePath(
  worktreeDir: string,
  rootTaskId: string,
): string {
  return resolve(worktreeDir, lineageBranchName(rootTaskId));
}

export function getRemedialSourceTaskId(task: BeadsTask): string | undefined {
  const discoveredFromTaskId = task.dependencies.find(
    (dependency) =>
      dependency.dependencyType === BEADS_DEPENDENCY_TYPE_DISCOVERED_FROM,
  )?.id;
  if (discoveredFromTaskId !== undefined) {
    return discoveredFromTaskId;
  }

  const parentTaskId =
    task.parentTaskId ??
    task.dependencies.find(
      (dependency) =>
        dependency.dependencyType === BEADS_DEPENDENCY_TYPE_PARENT_CHILD,
    )?.id;
  if (parentTaskId !== undefined) {
    return parentTaskId;
  }

  return undefined;
}

export function getDiscoveredFromTaskId(task: BeadsTask): string | undefined {
  return getRemedialSourceTaskId(task);
}

export function isRemedialBeadsTask(task: BeadsTask): boolean {
  return getRemedialSourceTaskId(task) !== undefined;
}

export async function initializeTaskLineage(
  options: InitializeTaskLineageOptions,
): Promise<TaskLineageRecord> {
  return upsertLineageRecord(options.teamName, {
    rootTaskId: options.taskId,
    taskIds: [options.taskId],
    worktreePath: resolve(options.worktreePath),
    branchName: options.branchName,
    reviewCycleCount: options.reviewCycleCount ?? 0,
  });
}

export async function getTaskLineage(
  teamName: string,
  taskId: string,
): Promise<TaskLineageRecord | undefined> {
  return getLineageRecordForTask(teamName, taskId);
}

export async function registerRemedialTaskLineage(
  teamName: string,
  originalTaskId: string,
  remedialTaskId: string,
): Promise<TaskLineageRecord> {
  return attachTaskToLineage(teamName, originalTaskId, remedialTaskId);
}

export async function incrementTaskLineageReviewCycle(
  teamName: string,
  taskId: string,
  amount = 1,
): Promise<TaskLineageRecord> {
  return incrementLineageReviewCycle(teamName, taskId, amount);
}

export async function createRemedialTaskLineage(
  options: CreateRemedialTaskLineageOptions,
): Promise<CreateRemedialTaskLineageResult> {
  const existingLineage = await getLineageRecordForTask(
    options.teamName,
    options.originalTaskId,
  );
  if (existingLineage === undefined) {
    throw new TeamLineageError(
      "missing-lineage",
      `Cannot create remedial task for "${options.originalTaskId}" without an existing lineage record`,
    );
  }

  const task = await createRemedialBeadsTask(options.workspacePath, {
    runner: options.runner,
    actor: options.actor,
    env: options.env,
    originalTaskId: options.originalTaskId,
    title: options.title,
    description: options.description,
    priority: options.priority,
    issueType: options.issueType,
    assignee: options.assignee,
    labels: options.labels,
  });

  try {
    const lineage = await registerRemedialTaskLineage(
      options.teamName,
      options.originalTaskId,
      task.id,
    );

    return {
      task,
      lineage,
    };
  } catch (err: unknown) {
    throw new TeamLineageError(
      "lineage-update-failed",
      `Created remedial beads task "${task.id}" but failed to update lineage state`,
      { cause: err },
    );
  }
}

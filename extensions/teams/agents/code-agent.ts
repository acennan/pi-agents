/**
 * Standing code-agent helpers.
 *
 * TF-17 extends that flow so code agents also land in the correct lineage
 * worktree before implementation starts:
 * - brand-new tasks create `task-<id>` worktrees from `main`
 * - remedial or resumed tasks reuse the stored lineage branch/worktree
 */

import { resolve } from "node:path";
import {
  type ClaimNextReadyBeadsTaskResult,
  type CommandRunner,
  claimNextReadyBeadsTask,
  defaultCommandRunner,
} from "../tasks/beads.ts";
import {
  type PrepareClaimedTaskLineageResult,
  prepareClaimedTaskLineage,
} from "../tasks/lineage.ts";
import {
  defaultTaskSummaryMarkdown,
  ensureTaskSummary,
  writeTaskSummary,
} from "../tasks/summaries.ts";
import { appendLeaderMailboxEntry } from "./mailbox.ts";

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

export type CodeAgentSessionLike = {
  agent: {
    reset: () => void;
    state: {
      messages: unknown[];
    };
  };
};

export type CodeAgentCompletionReport = {
  taskId: string;
  agentName: string;
  branchName: string;
  worktreePath: string;
  commitId: string;
  touchedFiles: string[];
  summaryPath: string;
  completedAt: string;
};

export type CompleteCodeAgentTaskOptions = {
  teamName: string;
  agentName: string;
  taskId: string;
  branchName: string;
  worktreePath: string;
  session: CodeAgentSessionLike;
  summaryMarkdown?: string;
  commitMessage?: string;
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
  now?: () => Date;
};

export type CompleteCodeAgentTaskResult = CodeAgentCompletionReport & {
  subject: string;
};

export class CodeAgentTaskError extends Error {
  readonly code:
    | "commit-failed"
    | "invalid-completion-report"
    | "nothing-to-commit"
    | "report-failed";

  constructor(
    code: CodeAgentTaskError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodeAgentTaskError";
    this.code = code;
  }
}

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

export async function completeCodeAgentTask(
  options: CompleteCodeAgentTaskOptions,
): Promise<CompleteCodeAgentTaskResult> {
  const runner = options.runner ?? defaultCommandRunner;
  const worktreePath = resolve(options.worktreePath);

  const commitId = await commitCodeAgentChanges({
    taskId: options.taskId,
    worktreePath,
    commitMessage: options.commitMessage,
    runner,
  });
  const touchedFiles = await readCommittedTouchedFiles(worktreePath, runner);
  const summaryPath =
    options.summaryMarkdown === undefined
      ? await ensureTaskSummary(
          options.teamName,
          options.taskId,
          defaultTaskSummaryMarkdown(options.taskId),
        )
      : await writeTaskSummary(
          options.teamName,
          options.taskId,
          options.summaryMarkdown,
        );
  const completedAt = (options.now ?? (() => new Date()))().toISOString();
  const subject = codeAgentCompletionSubject(options.taskId);
  const report: CodeAgentCompletionReport = {
    taskId: options.taskId,
    agentName: options.agentName,
    branchName: options.branchName,
    worktreePath,
    commitId,
    touchedFiles,
    summaryPath,
    completedAt,
  };

  try {
    await appendLeaderMailboxEntry(
      options.teamName,
      {
        timestamp: completedAt,
        sender: options.agentName,
        subject,
        message: JSON.stringify(report),
      },
      {
        env: options.env,
      },
    );
  } catch (error: unknown) {
    throw new CodeAgentTaskError(
      "report-failed",
      `Failed to report completion for task "${options.taskId}" to the leader inbox`,
      { cause: error },
    );
  }

  resetCodeAgentSession(options.session);

  return {
    ...report,
    subject,
  };
}

export function codeAgentCompletionSubject(taskId: string): string {
  return `task-${taskId}-coding-complete`;
}

export function parseCodeAgentCompletionReport(
  message: string,
): CodeAgentCompletionReport {
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(message) as unknown;
  } catch (error: unknown) {
    throw new CodeAgentTaskError(
      "invalid-completion-report",
      "Code-agent completion message was not valid JSON",
      { cause: error },
    );
  }

  if (!isJsonRecord(parsedValue)) {
    throw new CodeAgentTaskError(
      "invalid-completion-report",
      "Code-agent completion message must be a JSON object",
    );
  }

  return {
    taskId: readRequiredString(parsedValue, "taskId"),
    agentName: readRequiredString(parsedValue, "agentName"),
    branchName: readRequiredString(parsedValue, "branchName"),
    worktreePath: readRequiredString(parsedValue, "worktreePath"),
    commitId: readRequiredString(parsedValue, "commitId"),
    touchedFiles: readStringArray(parsedValue, "touchedFiles"),
    summaryPath: readRequiredString(parsedValue, "summaryPath"),
    completedAt: readRequiredString(parsedValue, "completedAt"),
  };
}

export function resetCodeAgentSession(session: CodeAgentSessionLike): void {
  session.agent.reset();

  if (session.agent.state.messages.length > 0) {
    session.agent.state.messages = [];
  }
}

async function commitCodeAgentChanges(options: {
  taskId: string;
  worktreePath: string;
  commitMessage?: string;
  runner: CommandRunner;
}): Promise<string> {
  const commitMessage =
    options.commitMessage ?? `feat: implement ${options.taskId}`;

  await runGit(options.runner, options.worktreePath, ["add", "--all"]);

  const statusResult = await runGit(options.runner, options.worktreePath, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (statusResult.stdout.trim().length === 0) {
    throw new CodeAgentTaskError(
      "nothing-to-commit",
      `Task "${options.taskId}" has no worktree changes to commit`,
    );
  }

  try {
    await runGit(options.runner, options.worktreePath, [
      "commit",
      "-m",
      commitMessage,
    ]);
  } catch (error: unknown) {
    throw new CodeAgentTaskError(
      "commit-failed",
      `Failed to commit task "${options.taskId}" in worktree "${options.worktreePath}"`,
      { cause: error },
    );
  }

  const headResult = await runGit(options.runner, options.worktreePath, [
    "rev-parse",
    "HEAD",
  ]);
  return headResult.stdout.trim();
}

async function readCommittedTouchedFiles(
  worktreePath: string,
  runner: CommandRunner,
): Promise<string[]> {
  const showResult = await runGit(runner, worktreePath, [
    "show",
    "--pretty=format:",
    "--name-only",
    "HEAD",
  ]);

  return showResult.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function runGit(
  runner: CommandRunner,
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return runner("git", args, { cwd });
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(
  value: Record<string, unknown>,
  fieldName: string,
): string {
  const field = value[fieldName];
  if (typeof field !== "string" || field.trim().length === 0) {
    throw new CodeAgentTaskError(
      "invalid-completion-report",
      `Code-agent completion message field "${fieldName}" must be a non-empty string`,
    );
  }

  return field;
}

function readStringArray(
  value: Record<string, unknown>,
  fieldName: string,
): string[] {
  const field = value[fieldName];
  if (
    !Array.isArray(field) ||
    field.some((entry) => typeof entry !== "string")
  ) {
    throw new CodeAgentTaskError(
      "invalid-completion-report",
      `Code-agent completion message field "${fieldName}" must be a string array`,
    );
  }

  return [...field];
}

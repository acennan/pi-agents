import { resolve } from "node:path";
import type { CommandRunner } from "../tasks/beads.ts";
import { defaultCommandRunner } from "../tasks/beads.ts";
import { appendTaskSummary } from "../tasks/summaries.ts";
import type { CodeAgentCompletionReport } from "./code-agent.ts";
import { appendLeaderMailboxEntry } from "./mailbox.ts";

export type SimplifyAgentSessionLike = {
  followUp: (message: string) => Promise<unknown>;
};

export type SimplifyAgentCompletionReport = {
  taskId: string;
  agentName: string;
  branchName: string;
  worktreePath: string;
  commitId: string;
  touchedFiles: string[];
  summaryPath: string;
  completedAt: string;
  changed: boolean;
};

export type CompleteSimplifyAgentTaskOptions = {
  teamName: string;
  agentName: string;
  completion: CodeAgentCompletionReport;
  session: SimplifyAgentSessionLike;
  commitMessage?: string;
  runner?: CommandRunner;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  summaryMarkdown?: string;
};

export type CompleteSimplifyAgentTaskResult = SimplifyAgentCompletionReport & {
  subject: string;
};

export class SimplifyAgentTaskError extends Error {
  readonly code:
    | "commit-failed"
    | "invalid-completion-report"
    | "report-failed";

  constructor(
    code: SimplifyAgentTaskError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SimplifyAgentTaskError";
    this.code = code;
  }
}

export async function completeSimplifyAgentTask(
  options: CompleteSimplifyAgentTaskOptions,
): Promise<CompleteSimplifyAgentTaskResult> {
  const runner = options.runner ?? defaultCommandRunner;
  const worktreePath = resolve(options.completion.worktreePath);

  await options.session.followUp(
    buildSimplifyPrompt({
      taskId: options.completion.taskId,
      branchName: options.completion.branchName,
      worktreePath,
      touchedFiles: options.completion.touchedFiles,
    }),
  );

  const commitResult = await commitSimplifyChanges({
    taskId: options.completion.taskId,
    worktreePath,
    commitMessage: options.commitMessage,
    runner,
    previousCommitId: options.completion.commitId,
  });
  const touchedFiles = commitResult.changed
    ? mergeTouchedFiles(
        options.completion.touchedFiles,
        await readCommittedTouchedFiles(worktreePath, runner),
      )
    : [...options.completion.touchedFiles];
  const completedAt = (options.now ?? (() => new Date()))().toISOString();
  const summaryPath = await appendTaskSummary(
    options.teamName,
    options.completion.taskId,
    options.summaryMarkdown ??
      defaultSimplifySummaryMarkdown({
        agentName: options.agentName,
        changed: commitResult.changed,
        commitId: commitResult.commitId,
        touchedFiles,
      }),
  );
  const subject = simplifyAgentCompletionSubject(options.completion.taskId);
  const report: SimplifyAgentCompletionReport = {
    taskId: options.completion.taskId,
    agentName: options.agentName,
    branchName: options.completion.branchName,
    worktreePath,
    commitId: commitResult.commitId,
    touchedFiles,
    summaryPath,
    completedAt,
    changed: commitResult.changed,
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
    throw new SimplifyAgentTaskError(
      "report-failed",
      `Failed to report simplify completion for task "${options.completion.taskId}" to the leader inbox`,
      { cause: error },
    );
  }

  return {
    ...report,
    subject,
  };
}

export function simplifyAgentCompletionSubject(taskId: string): string {
  return `task-${taskId}-simplify-complete`;
}

export function parseSimplifyAgentCompletionReport(
  message: string,
): SimplifyAgentCompletionReport {
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(message) as unknown;
  } catch (error: unknown) {
    throw new SimplifyAgentTaskError(
      "invalid-completion-report",
      "Simplify-agent completion message was not valid JSON",
      { cause: error },
    );
  }

  if (!isJsonRecord(parsedValue)) {
    throw new SimplifyAgentTaskError(
      "invalid-completion-report",
      "Simplify-agent completion message must be a JSON object",
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
    changed: readRequiredBoolean(parsedValue, "changed"),
  };
}

function buildSimplifyPrompt(options: {
  taskId: string;
  branchName: string;
  worktreePath: string;
  touchedFiles: readonly string[];
}): string {
  const fileList =
    options.touchedFiles.length === 0
      ? "- none supplied"
      : options.touchedFiles.map((file) => `- ${file}`).join("\n");

  return [
    `Run a code simplification pass for task "${options.taskId}" in worktree "${options.worktreePath}".`,
    "",
    "Apply the code-simplifier skill to the touched files below.",
    "Preserve behaviour exactly. Improve clarity and maintainability only where it is useful.",
    "Do not create commits or summary files yourself.",
    `Branch: ${options.branchName}`,
    "",
    "Touched files:",
    fileList,
  ].join("\n");
}

function defaultSimplifySummaryMarkdown(options: {
  agentName: string;
  changed: boolean;
  commitId: string;
  touchedFiles: readonly string[];
}): string {
  const fileLines =
    options.touchedFiles.length === 0
      ? ["- none"]
      : options.touchedFiles.map((file) => `- ${file}`);

  return [
    `## Simplify (${options.agentName})`,
    "",
    options.changed
      ? `Committed simplification updates in ${options.commitId}.`
      : "No simplify changes were required after reviewing the touched files.",
    "",
    "Processed files:",
    ...fileLines,
  ].join("\n");
}

async function commitSimplifyChanges(options: {
  taskId: string;
  worktreePath: string;
  commitMessage?: string;
  runner: CommandRunner;
  previousCommitId: string;
}): Promise<{ commitId: string; changed: boolean }> {
  const commitMessage =
    options.commitMessage ?? `refactor: simplify ${options.taskId}`;

  await runGit(options.runner, options.worktreePath, ["add", "--all"]);

  const statusResult = await runGit(options.runner, options.worktreePath, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (statusResult.stdout.trim().length === 0) {
    return {
      commitId: options.previousCommitId,
      changed: false,
    };
  }

  try {
    await runGit(options.runner, options.worktreePath, [
      "commit",
      "-m",
      commitMessage,
    ]);
  } catch (error: unknown) {
    throw new SimplifyAgentTaskError(
      "commit-failed",
      `Failed to commit simplify changes for task "${options.taskId}" in worktree "${options.worktreePath}"`,
      { cause: error },
    );
  }

  const headResult = await runGit(options.runner, options.worktreePath, [
    "rev-parse",
    "HEAD",
  ]);
  return {
    commitId: headResult.stdout.trim(),
    changed: true,
  };
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

function mergeTouchedFiles(
  initialFiles: readonly string[],
  updatedFiles: readonly string[],
): string[] {
  return [...new Set([...initialFiles, ...updatedFiles])];
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
  const resolved = value[fieldName];
  if (typeof resolved === "string" && resolved.trim().length > 0) {
    return resolved;
  }

  throw new SimplifyAgentTaskError(
    "invalid-completion-report",
    `Simplify-agent completion field "${fieldName}" must be a non-empty string`,
  );
}

function readRequiredBoolean(
  value: Record<string, unknown>,
  fieldName: string,
): boolean {
  const resolved = value[fieldName];
  if (typeof resolved === "boolean") {
    return resolved;
  }

  throw new SimplifyAgentTaskError(
    "invalid-completion-report",
    `Simplify-agent completion field "${fieldName}" must be a boolean`,
  );
}

function readStringArray(
  value: Record<string, unknown>,
  fieldName: string,
): string[] {
  const resolved = value[fieldName];
  if (
    Array.isArray(resolved) &&
    resolved.every((entry) => typeof entry === "string")
  ) {
    return [...resolved];
  }

  throw new SimplifyAgentTaskError(
    "invalid-completion-report",
    `Simplify-agent completion field "${fieldName}" must be an array of strings`,
  );
}

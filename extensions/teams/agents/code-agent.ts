/**
 * Standing code-agent helpers.
 *
 * The code agent is driven entirely by its system prompt (code-prompt.md).
 * This module provides only the types and parsing used by the leader to
 * process completion reports sent by the agent via the mailbox skill.
 */

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

export class CodeAgentTaskError extends Error {
  readonly code: "invalid-completion-report";

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

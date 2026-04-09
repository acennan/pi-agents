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

export class SimplifyAgentTaskError extends Error {
  readonly code: "invalid-completion-report";

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

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { teamDir } from "../storage/team-home.ts";

export function teamSummariesDir(teamName: string): string {
  return join(teamDir(teamName), "summaries");
}

export function taskSummaryPath(teamName: string, taskId: string): string {
  return join(
    teamSummariesDir(teamName),
    `task-${validateTaskSummaryId(taskId)}-summary.md`,
  );
}

export function defaultTaskSummaryMarkdown(taskId: string): string {
  return `# Task ${taskId} Summary\n\n`;
}

export async function ensureTaskSummary(
  teamName: string,
  taskId: string,
  initialMarkdown = defaultTaskSummaryMarkdown(taskId),
): Promise<string> {
  const path = taskSummaryPath(teamName, taskId);
  await mkdir(dirname(path), { recursive: true });

  try {
    await readFile(path, "utf8");
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      throw error;
    }

    await writeTaskSummary(teamName, taskId, initialMarkdown);
  }

  return path;
}

export async function writeTaskSummary(
  teamName: string,
  taskId: string,
  markdown: string,
): Promise<string> {
  const path = taskSummaryPath(teamName, taskId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, markdown, "utf8");
  return path;
}

export async function appendTaskSummary(
  teamName: string,
  taskId: string,
  markdown: string,
): Promise<string> {
  const path = await ensureTaskSummary(teamName, taskId);
  const existing = await readFile(path, "utf8");
  const separator = existing.trim().length === 0 ? "" : "\n\n";
  await writeFile(path, `${existing}${separator}${markdown}`, "utf8");
  return path;
}

export async function readTaskSummary(
  teamName: string,
  taskId: string,
): Promise<string | undefined> {
  const path = taskSummaryPath(teamName, taskId);

  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return undefined;
    }

    throw error;
  }
}

function validateTaskSummaryId(taskId: string): string {
  const trimmedTaskId = taskId.trim();
  if (
    trimmedTaskId.length === 0 ||
    trimmedTaskId !== taskId ||
    /[/\\]|\.\./u.test(trimmedTaskId)
  ) {
    throw new Error(`Task id "${taskId}" is invalid for a summary path`);
  }

  return trimmedTaskId;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

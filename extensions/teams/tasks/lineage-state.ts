/**
 * Team-owned lineage state.
 *
 * Beads models task relationships, but does not carry workflow-specific lineage
 * data like resolved worktree paths, branch names, or review cycle counters.
 * That data lives under `~/.pi/teams/<team-name>/state/lineages.json`.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withFileLock } from "../storage/locks.ts";
import { teamStateDir } from "../storage/team-home.ts";

const LINEAGE_STATE_VERSION = 1;

export type TaskLineageRecord = {
  rootTaskId: string;
  taskIds: string[];
  worktreePath: string;
  branchName: string;
  reviewCycleCount: number;
};

export type TaskLineageState = {
  version: typeof LINEAGE_STATE_VERSION;
  lineages: TaskLineageRecord[];
};

export class LineageStateError extends Error {
  readonly code:
    | "invalid-state"
    | "read-failed"
    | "record-not-found"
    | "task-already-linked"
    | "write-failed";

  constructor(
    code: LineageStateError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LineageStateError";
    this.code = code;
  }
}

export function lineageStatePath(teamName: string): string {
  return join(teamStateDir(teamName), "lineages.json");
}

export async function listLineageRecords(
  teamName: string,
): Promise<TaskLineageRecord[]> {
  const state = await readLineageState(teamName);
  return state.lineages;
}

export async function getLineageRecordForTask(
  teamName: string,
  taskId: string,
): Promise<TaskLineageRecord | undefined> {
  const records = await listLineageRecords(teamName);
  return records.find((record) => record.taskIds.includes(taskId));
}

export async function getLineageRecordForRootTask(
  teamName: string,
  rootTaskId: string,
): Promise<TaskLineageRecord | undefined> {
  const records = await listLineageRecords(teamName);
  return records.find((record) => record.rootTaskId === rootTaskId);
}

export async function upsertLineageRecord(
  teamName: string,
  record: TaskLineageRecord,
): Promise<TaskLineageRecord> {
  const normalizedRecord = normalizeTaskLineageRecord(record, "record");

  return mutateLineageState(teamName, (state) => {
    const nextLineages = state.lineages.filter(
      (entry) => entry.rootTaskId !== normalizedRecord.rootTaskId,
    );
    nextLineages.push(normalizedRecord);
    assertNoCrossLineageConflicts(nextLineages);

    return {
      state: {
        version: LINEAGE_STATE_VERSION,
        lineages: nextLineages,
      },
      result: normalizedRecord,
    };
  });
}

export async function attachTaskToLineage(
  teamName: string,
  existingTaskId: string,
  newTaskId: string,
): Promise<TaskLineageRecord> {
  return mutateLineageState(teamName, (state) => {
    const index = state.lineages.findIndex((record) =>
      record.taskIds.includes(existingTaskId),
    );
    if (index < 0) {
      throw new LineageStateError(
        "record-not-found",
        `No lineage record exists for task "${existingTaskId}"`,
      );
    }

    const currentRecord = state.lineages[index];
    if (currentRecord === undefined) {
      throw new LineageStateError(
        "record-not-found",
        `No lineage record exists for task "${existingTaskId}"`,
      );
    }

    const nextRecord = normalizeTaskLineageRecord(
      {
        ...currentRecord,
        taskIds: [...currentRecord.taskIds, newTaskId],
      },
      `lineages[${index}]`,
    );

    const nextLineages = [...state.lineages];
    nextLineages[index] = nextRecord;
    assertNoCrossLineageConflicts(nextLineages);

    return {
      state: {
        version: LINEAGE_STATE_VERSION,
        lineages: nextLineages,
      },
      result: nextRecord,
    };
  });
}

export async function incrementLineageReviewCycle(
  teamName: string,
  taskId: string,
  amount = 1,
): Promise<TaskLineageRecord> {
  if (!Number.isInteger(amount) || amount < 1) {
    throw new LineageStateError(
      "invalid-state",
      `Lineage review cycle increment must be a positive integer. Received: ${amount}`,
    );
  }

  return mutateLineageState(teamName, (state) => {
    const index = state.lineages.findIndex((record) =>
      record.taskIds.includes(taskId),
    );
    if (index < 0) {
      throw new LineageStateError(
        "record-not-found",
        `No lineage record exists for task "${taskId}"`,
      );
    }

    const currentRecord = state.lineages[index];
    if (currentRecord === undefined) {
      throw new LineageStateError(
        "record-not-found",
        `No lineage record exists for task "${taskId}"`,
      );
    }

    const nextRecord = normalizeTaskLineageRecord(
      {
        ...currentRecord,
        reviewCycleCount: currentRecord.reviewCycleCount + amount,
      },
      `lineages[${index}]`,
    );

    const nextLineages = [...state.lineages];
    nextLineages[index] = nextRecord;

    return {
      state: {
        version: LINEAGE_STATE_VERSION,
        lineages: nextLineages,
      },
      result: nextRecord,
    };
  });
}

async function readLineageState(teamName: string): Promise<TaskLineageState> {
  const path = lineageStatePath(teamName);
  await ensureLineageStatePath(path);

  return withFileLock(path, async () => readLineageStateUnlocked(path));
}

async function readLineageStateUnlocked(
  path: string,
): Promise<TaskLineageState> {
  try {
    const raw = await readStateText(path);
    if (raw.trim().length === 0) {
      return emptyLineageState();
    }

    return normalizeTaskLineageState(JSON.parse(raw), path);
  } catch (err: unknown) {
    if (err instanceof LineageStateError) {
      throw err;
    }

    if (err instanceof SyntaxError) {
      throw new LineageStateError(
        "invalid-state",
        `Lineage state file "${path}" is not valid JSON`,
        { cause: err },
      );
    }

    throw new LineageStateError(
      "read-failed",
      `Failed to read lineage state file "${path}"`,
      { cause: err },
    );
  }
}

async function mutateLineageState<TResult>(
  teamName: string,
  callback: (
    state: TaskLineageState,
  ) =>
    | { state: TaskLineageState; result: TResult }
    | Promise<{ state: TaskLineageState; result: TResult }>,
): Promise<TResult> {
  const path = lineageStatePath(teamName);
  await ensureLineageStatePath(path);

  return withFileLock(path, async () => {
    const currentState = await readLineageStateUnlocked(path);
    const mutation = await callback(currentState);
    const nextState = normalizeTaskLineageState(mutation.state, path);

    try {
      await writeFile(path, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
    } catch (err: unknown) {
      throw new LineageStateError(
        "write-failed",
        `Failed to write lineage state file "${path}"`,
        { cause: err },
      );
    }

    return mutation.result;
  });
}

async function ensureLineageStatePath(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, "", "utf8");
}

async function readStateText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err: unknown) {
    if (isMissingFileError(err)) {
      return "";
    }

    throw err;
  }
}

function normalizeTaskLineageState(
  value: unknown,
  path: string,
): TaskLineageState {
  if (!isJsonRecord(value)) {
    throw new LineageStateError(
      "invalid-state",
      `Expected lineage state file "${path}" to contain an object`,
    );
  }

  const version = value.version;
  if (version !== LINEAGE_STATE_VERSION) {
    throw new LineageStateError(
      "invalid-state",
      `Expected lineage state file "${path}" to have version ${LINEAGE_STATE_VERSION}`,
    );
  }

  const lineages = value.lineages;
  if (!Array.isArray(lineages)) {
    throw new LineageStateError(
      "invalid-state",
      `Expected lineage state file "${path}" to contain a lineages array`,
    );
  }

  const normalizedLineages = lineages.map((record, index) =>
    normalizeTaskLineageRecord(record, `${path}.lineages[${index}]`),
  );
  assertNoCrossLineageConflicts(normalizedLineages);

  return {
    version: LINEAGE_STATE_VERSION,
    lineages: normalizedLineages,
  };
}

function normalizeTaskLineageRecord(
  value: unknown,
  path: string,
): TaskLineageRecord {
  if (!isJsonRecord(value)) {
    throw new LineageStateError(
      "invalid-state",
      `Expected ${path} to be an object`,
    );
  }

  const rootTaskId = readRequiredString(value, "rootTaskId", path);
  const taskIds = readRequiredTaskIds(value, path, rootTaskId);
  const worktreePath = resolve(readRequiredString(value, "worktreePath", path));
  const branchName = readRequiredString(value, "branchName", path);
  const reviewCycleCount = readRequiredNonNegativeInteger(
    value,
    "reviewCycleCount",
    path,
  );

  return {
    rootTaskId,
    taskIds,
    worktreePath,
    branchName,
    reviewCycleCount,
  };
}

function readRequiredTaskIds(
  record: Record<string, unknown>,
  path: string,
  rootTaskId: string,
): string[] {
  const value = record.taskIds;
  if (!Array.isArray(value) || value.length === 0) {
    throw new LineageStateError(
      "invalid-state",
      `Expected ${path}.taskIds to be a non-empty string array`,
    );
  }

  const seen = new Set<string>();
  const normalizedTaskIds: string[] = [];

  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new LineageStateError(
        "invalid-state",
        `Expected ${path}.taskIds to contain only non-empty strings`,
      );
    }

    if (!seen.has(entry)) {
      seen.add(entry);
      normalizedTaskIds.push(entry);
    }
  }

  if (!seen.has(rootTaskId)) {
    throw new LineageStateError(
      "invalid-state",
      `Expected ${path}.taskIds to include root task id "${rootTaskId}"`,
    );
  }

  return normalizedTaskIds;
}

function readRequiredString(
  record: Record<string, unknown>,
  fieldName: string,
  path: string,
): string {
  const value = record[fieldName];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new LineageStateError(
      "invalid-state",
      `Expected ${path}.${fieldName} to be a non-empty string`,
    );
  }

  return value;
}

function readRequiredNonNegativeInteger(
  record: Record<string, unknown>,
  fieldName: string,
  path: string,
): number {
  const value = record[fieldName];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new LineageStateError(
      "invalid-state",
      `Expected ${path}.${fieldName} to be a non-negative integer`,
    );
  }

  return value;
}

function assertNoCrossLineageConflicts(records: readonly TaskLineageRecord[]) {
  const taskToRoot = new Map<string, string>();

  for (const record of records) {
    for (const taskId of record.taskIds) {
      const existingRootTaskId = taskToRoot.get(taskId);
      if (
        existingRootTaskId !== undefined &&
        existingRootTaskId !== record.rootTaskId
      ) {
        throw new LineageStateError(
          "task-already-linked",
          `Task "${taskId}" is already linked to lineage root "${existingRootTaskId}"`,
        );
      }

      taskToRoot.set(taskId, record.rootTaskId);
    }
  }
}

function emptyLineageState(): TaskLineageState {
  return {
    version: LINEAGE_STATE_VERSION,
    lineages: [],
  };
}

function isMissingFileError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

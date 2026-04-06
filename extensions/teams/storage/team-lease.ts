/**
 * Active-team runtime lease management.
 *
 * The runtime lease is a leader-owned `runtime-lock.json` record stored under
 * the team directory. It is intentionally separate from beads task state so a
 * leader session can prevent accidental double-attachment even when no task
 * mutation is happening.
 *
 * Stale lease recovery is deliberately narrow:
 * - clean stop removes the lease explicitly
 * - pause preserves the lease
 * - only validated restart/delete flows may clear a stale lease
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "./locks.ts";
import { teamDir } from "./team-home.ts";

export type RuntimeLockRecord = {
  sessionId: string;
  pid: number;
  createdAt: string;
};

export type RuntimeLockState = "active" | "stale";

export type RuntimeLockInspection = {
  record: RuntimeLockRecord;
  state: RuntimeLockState;
};

export type ProcessAliveChecker = (pid: number) => boolean | Promise<boolean>;

export type CreateRuntimeLockRecordOptions = {
  pid?: number;
  createdAt?: string;
};

export type ClaimRuntimeLockOptions = {
  allowStaleRecovery?: boolean;
  processAlive?: ProcessAliveChecker;
};

export type ClaimRuntimeLockResult =
  | "claimed"
  | "already-owned"
  | "recovered-stale";

export type InspectRuntimeLockOptions = {
  processAlive?: ProcessAliveChecker;
};

export class TeamLeaseError extends Error {
  readonly code:
    | "lease-active"
    | "lease-stale"
    | "lease-invalid"
    | "lease-write-failed"
    | "lease-remove-failed";

  constructor(
    code: TeamLeaseError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TeamLeaseError";
    this.code = code;
  }
}

export function runtimeLockPath(teamName: string): string {
  return join(teamDir(teamName), "runtime-lock.json");
}

export function createRuntimeLockRecord(
  sessionId = defaultSessionId(),
  options: CreateRuntimeLockRecordOptions = {},
): RuntimeLockRecord {
  return {
    sessionId,
    pid: options.pid ?? process.pid,
    createdAt: options.createdAt ?? new Date().toISOString(),
  };
}

export async function readRuntimeLock(
  teamName: string,
): Promise<RuntimeLockRecord | undefined> {
  return readRuntimeLockFromPath(runtimeLockPath(teamName));
}

export async function inspectRuntimeLock(
  teamName: string,
  options: InspectRuntimeLockOptions = {},
): Promise<RuntimeLockInspection | undefined> {
  const record = await readRuntimeLock(teamName);
  if (record === undefined) {
    return undefined;
  }

  return {
    record,
    state: (await isRuntimeLockActive(record, options.processAlive))
      ? "active"
      : "stale",
  };
}

export async function writeRuntimeLock(
  teamName: string,
  record: RuntimeLockRecord,
): Promise<void> {
  validateRuntimeLockRecord(record);

  await withRuntimeLockMutation(teamName, async () => {
    await writeRuntimeLockToPath(runtimeLockPath(teamName), record);
  });
}

export async function claimRuntimeLock(
  teamName: string,
  record: RuntimeLockRecord,
  options: ClaimRuntimeLockOptions = {},
): Promise<ClaimRuntimeLockResult> {
  validateRuntimeLockRecord(record);

  return withRuntimeLockMutation(teamName, async () => {
    const path = runtimeLockPath(teamName);
    const existingRecord = await readRuntimeLockFromPath(path);

    if (existingRecord === undefined) {
      await writeRuntimeLockToPath(path, record);
      return "claimed";
    }

    return handleExistingLock(existingRecord, teamName, record, options);
  });
}

async function handleExistingLock(
  existingRecord: RuntimeLockRecord,
  teamName: string,
  record: RuntimeLockRecord,
  options: ClaimRuntimeLockOptions,
): Promise<ClaimRuntimeLockResult> {
  const existingState = (await isRuntimeLockActive(
    existingRecord,
    options.processAlive,
  ))
    ? "active"
    : "stale";

  if (
    existingRecord.sessionId === record.sessionId &&
    existingRecord.pid === record.pid
  ) {
    return existingState === "active" ? "already-owned" : "recovered-stale";
  }

  if (existingState === "active") {
    throw new TeamLeaseError(
      "lease-active",
      `Team "${teamName}" is already controlled by session "${existingRecord.sessionId}" (pid ${existingRecord.pid})`,
    );
  }

  if (!options.allowStaleRecovery) {
    throw new TeamLeaseError(
      "lease-stale",
      `Team "${teamName}" has a stale runtime lock from session "${existingRecord.sessionId}" (pid ${existingRecord.pid}). Only restart/delete recovery may clear it.`,
    );
  }

  await writeRuntimeLockToPath(runtimeLockPath(teamName), record);
  return "recovered-stale";
}

export async function clearStaleRuntimeLock(
  teamName: string,
  options: InspectRuntimeLockOptions = {},
): Promise<boolean> {
  return withRuntimeLockMutation(teamName, async () => {
    const path = runtimeLockPath(teamName);
    const record = await readRuntimeLockFromPath(path);

    if (record === undefined) {
      return false;
    }

    if (await isRuntimeLockActive(record, options.processAlive)) {
      throw new TeamLeaseError(
        "lease-active",
        `Team "${teamName}" is already controlled by session "${record.sessionId}" (pid ${record.pid})`,
      );
    }

    await removeRuntimeLockFromPath(path);
    return true;
  });
}

export async function removeRuntimeLock(teamName: string): Promise<boolean> {
  return withRuntimeLockMutation(teamName, async () => {
    const path = runtimeLockPath(teamName);
    const record = await readRuntimeLockFromPath(path);
    if (record === undefined) {
      return false;
    }

    await removeRuntimeLockFromPath(path);
    return true;
  });
}

async function isRuntimeLockActive(
  record: RuntimeLockRecord,
  processAlive: ProcessAliveChecker = defaultProcessAliveChecker,
): Promise<boolean> {
  return await processAlive(record.pid);
}

function defaultSessionId(): string {
  return `leader-${process.pid}-${Date.now()}`;
}

async function withRuntimeLockMutation<T>(
  teamName: string,
  callback: () => Promise<T>,
): Promise<T> {
  const directory = teamDir(teamName);
  await mkdir(directory, { recursive: true });

  return withFileLock(directory, callback, {
    lockfilePath: `${runtimeLockPath(teamName)}.lock`,
  });
}

async function readRuntimeLockFromPath(
  path: string,
): Promise<RuntimeLockRecord | undefined> {
  let rawContent: string;
  try {
    rawContent = await readFile(path, "utf8");
  } catch (err: unknown) {
    if (isMissingFileError(err)) {
      return undefined;
    }

    throw new TeamLeaseError(
      "lease-invalid",
      `Failed to read runtime lock at "${path}"`,
      { cause: err },
    );
  }

  if (rawContent.trim().length === 0) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent) as unknown;
  } catch (err: unknown) {
    throw new TeamLeaseError(
      "lease-invalid",
      `Runtime lock at "${path}" contains invalid JSON`,
      { cause: err },
    );
  }

  if (!isRuntimeLockRecord(parsed)) {
    throw new TeamLeaseError(
      "lease-invalid",
      `Runtime lock at "${path}" is missing required fields`,
    );
  }

  return parsed;
}

async function writeRuntimeLockToPath(
  path: string,
  record: RuntimeLockRecord,
): Promise<void> {
  try {
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  } catch (err: unknown) {
    throw new TeamLeaseError(
      "lease-write-failed",
      `Failed to write runtime lock at "${path}"`,
      { cause: err },
    );
  }
}

async function removeRuntimeLockFromPath(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch (err: unknown) {
    throw new TeamLeaseError(
      "lease-remove-failed",
      `Failed to remove runtime lock at "${path}"`,
      { cause: err },
    );
  }
}

function validateRuntimeLockRecord(record: RuntimeLockRecord): void {
  if (!isRuntimeLockRecord(record)) {
    throw new TeamLeaseError(
      "lease-invalid",
      "Runtime lock record is missing required fields",
    );
  }
}

function isRuntimeLockRecord(value: unknown): value is RuntimeLockRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.sessionId === "string" &&
    candidate.sessionId.trim().length > 0 &&
    typeof candidate.pid === "number" &&
    Number.isInteger(candidate.pid) &&
    candidate.pid > 0 &&
    typeof candidate.createdAt === "string" &&
    !Number.isNaN(Date.parse(candidate.createdAt))
  );
}

function isMissingFileError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

function defaultProcessAliveChecker(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (isErrnoException(err)) {
      if (err.code === "EPERM") {
        return true;
      }
      if (err.code === "ESRCH") {
        return false;
      }
    }

    throw err;
  }
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

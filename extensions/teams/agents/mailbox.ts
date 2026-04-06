/**
 * Shared mailbox helpers for leader and child runtimes.
 *
 * Mailboxes are append-only JSONL inboxes paired with cursor JSON files. A
 * receiver polls its inbox, translates each pending entry into local SDK queue
 * operations, and only then advances the cursor while holding the inbox lock.
 *
 * This design gives the leader and all agent roles one auditable transport
 * mechanism and avoids losing messages when a poll fails part-way through.
 */

import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type JsonValue, readJsonlEntries } from "../storage/jsonl.ts";
import {
  mailboxLockOptions,
  type SharedLockOptions,
  withFileLock,
} from "../storage/locks.ts";
import { teamDir } from "../storage/team-home.ts";

export const LEADER_MAILBOX_OWNER = "leader";
export const DEFAULT_TEAM_MAILBOX_POLL_SECS = 5;

export type MailboxEntry = {
  timestamp: string;
  sender: string;
  receiver: string;
  subject: string;
  message: string;
};

export type NewMailboxEntry = {
  timestamp?: string;
  sender: string;
  receiver: string;
  subject: string;
  message: string;
};

export type NewTeamMailboxEntry = Omit<NewMailboxEntry, "receiver"> & {
  receiver?: string;
};

export type MailboxCursor = {
  nextIndex: number;
  updatedAt: string;
};

export type MailboxOperationOptions = Omit<SharedLockOptions, "retries"> & {
  env?: NodeJS.ProcessEnv;
};

export type MailboxEntryHandler = (
  entry: MailboxEntry,
  context: { index: number },
) => Promise<void>;

export type ConsumeMailboxOptions = {
  inboxPath: string;
  cursorPath: string;
  handleEntry: MailboxEntryHandler;
} & MailboxOperationOptions;

export type ConsumeMailboxResult = {
  entries: MailboxEntry[];
  cursor: MailboxCursor;
  processedCount: number;
};

export type MailboxPollOptions = ConsumeMailboxOptions & {
  intervalSecs?: number;
  startImmediate?: boolean;
  onError?: (error: unknown) => Promise<void> | void;
  setTimeoutImpl?: typeof globalThis.setTimeout;
  clearTimeoutImpl?: typeof globalThis.clearTimeout;
};

export type MailboxPollController = {
  stop: () => void;
  pollNow: () => Promise<ConsumeMailboxResult>;
};

export class MailboxStorageError extends Error {
  readonly code:
    | "cursor-read-failed"
    | "cursor-write-failed"
    | "invalid-cursor"
    | "invalid-mailbox-entry"
    | "invalid-mailbox-owner"
    | "mailbox-write-failed"
    | "receiver-mismatch";

  constructor(
    code: MailboxStorageError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MailboxStorageError";
    this.code = code;
  }
}

export function teamMailboxesDir(teamName: string): string {
  return join(teamDir(teamName), "mailboxes");
}

export function teamMailboxInboxPath(
  teamName: string,
  ownerName: string,
): string {
  return join(
    teamMailboxesDir(teamName),
    `${validateMailboxOwnerName(ownerName)}-inbox.jsonl`,
  );
}

export function teamMailboxCursorPath(
  teamName: string,
  ownerName: string,
): string {
  return join(
    teamMailboxesDir(teamName),
    `${validateMailboxOwnerName(ownerName)}-cursor.json`,
  );
}

export function leaderInboxPath(teamName: string): string {
  return teamMailboxInboxPath(teamName, LEADER_MAILBOX_OWNER);
}

export function leaderCursorPath(teamName: string): string {
  return teamMailboxCursorPath(teamName, LEADER_MAILBOX_OWNER);
}

export function getMailboxPollIntervalSecs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const rawValue = env.PI_TEAM_MAILBOX_POLL_SECS;
  if (rawValue === undefined) {
    return DEFAULT_TEAM_MAILBOX_POLL_SECS;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsedValue) || parsedValue < 1) {
    return DEFAULT_TEAM_MAILBOX_POLL_SECS;
  }

  return parsedValue;
}

export async function ensureMailboxFiles(
  inboxPath: string,
  cursorPath: string,
): Promise<void> {
  await ensureMailboxInbox(inboxPath);
  await ensureMailboxCursor(cursorPath);
}

export async function ensureTeamMailbox(
  teamName: string,
  ownerName: string,
): Promise<void> {
  await ensureMailboxFiles(
    teamMailboxInboxPath(teamName, ownerName),
    teamMailboxCursorPath(teamName, ownerName),
  );
}

export async function removeMailboxFiles(
  inboxPath: string,
  cursorPath: string,
): Promise<void> {
  await Promise.all([
    rm(inboxPath, { force: true }),
    rm(cursorPath, { force: true }),
  ]);
}

export async function removeTeamMailbox(
  teamName: string,
  ownerName: string,
): Promise<void> {
  await removeMailboxFiles(
    teamMailboxInboxPath(teamName, ownerName),
    teamMailboxCursorPath(teamName, ownerName),
  );
}

export async function appendMailboxEntry(
  inboxPath: string,
  entry: NewMailboxEntry,
  options: MailboxOperationOptions = {},
): Promise<MailboxEntry> {
  const fullEntry = normalizeMailboxEntry({
    timestamp: entry.timestamp ?? new Date().toISOString(),
    sender: entry.sender,
    receiver: entry.receiver,
    subject: entry.subject,
    message: entry.message,
  });

  await withMailboxInboxLock(
    inboxPath,
    async () => {
      await appendMailboxLine(inboxPath, fullEntry);
    },
    options,
  );

  return fullEntry;
}

export async function appendTeamMailboxEntry(
  teamName: string,
  ownerName: string,
  entry: NewTeamMailboxEntry,
  options: MailboxOperationOptions = {},
): Promise<MailboxEntry> {
  const normalizedOwnerName = validateMailboxOwnerName(ownerName);
  const receiver = entry.receiver ?? normalizedOwnerName;

  if (receiver !== normalizedOwnerName) {
    throw new MailboxStorageError(
      "receiver-mismatch",
      `Mailbox entry receiver "${receiver}" does not match inbox owner "${normalizedOwnerName}"`,
    );
  }

  return appendMailboxEntry(
    teamMailboxInboxPath(teamName, normalizedOwnerName),
    {
      ...entry,
      receiver,
    },
    options,
  );
}

export async function appendLeaderMailboxEntry(
  teamName: string,
  entry: NewTeamMailboxEntry,
  options: MailboxOperationOptions = {},
): Promise<MailboxEntry> {
  return appendTeamMailboxEntry(teamName, LEADER_MAILBOX_OWNER, entry, options);
}

export async function readMailboxEntries(
  inboxPath: string,
): Promise<MailboxEntry[]> {
  const entries = await readJsonlEntries<JsonValue>(inboxPath);
  return entries.map((entry, index) =>
    toMailboxEntry(inboxPath, entry, index + 1),
  );
}

export async function readMailboxCursor(
  cursorPath: string,
): Promise<MailboxCursor> {
  let rawContent: string;

  try {
    rawContent = await readFile(cursorPath, "utf8");
  } catch (err: unknown) {
    if (isMissingFileError(err)) {
      return createInitialMailboxCursor();
    }

    throw new MailboxStorageError(
      "cursor-read-failed",
      `Failed to read mailbox cursor from "${cursorPath}"`,
      { cause: err },
    );
  }

  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(rawContent) as unknown;
  } catch (err: unknown) {
    throw new MailboxStorageError(
      "invalid-cursor",
      `Mailbox cursor at "${cursorPath}" is not valid JSON`,
      { cause: err },
    );
  }

  return toMailboxCursor(cursorPath, parsedValue);
}

export async function writeMailboxCursor(
  cursorPath: string,
  cursor: MailboxCursor,
): Promise<void> {
  const normalizedCursor = toMailboxCursor(cursorPath, cursor);

  await mkdir(dirname(cursorPath), { recursive: true });

  try {
    await writeFile(
      cursorPath,
      `${JSON.stringify(normalizedCursor)}\n`,
      "utf8",
    );
  } catch (err: unknown) {
    throw new MailboxStorageError(
      "cursor-write-failed",
      `Failed to write mailbox cursor to "${cursorPath}"`,
      { cause: err },
    );
  }
}

export async function consumeMailboxEntries(
  options: ConsumeMailboxOptions,
): Promise<ConsumeMailboxResult> {
  return withMailboxInboxLock(
    options.inboxPath,
    () => processMailboxUnderLock(options),
    options,
  );
}

async function processMailboxUnderLock(
  options: Pick<ConsumeMailboxOptions, "inboxPath" | "cursorPath" | "handleEntry">,
): Promise<ConsumeMailboxResult> {
  await ensureMailboxFiles(options.inboxPath, options.cursorPath);

  const entries = await readMailboxEntries(options.inboxPath);
  const cursor = await readMailboxCursor(options.cursorPath);

  if (cursor.nextIndex > entries.length) {
    throw new MailboxStorageError(
      "invalid-cursor",
      `Mailbox cursor at "${options.cursorPath}" points past the end of inbox "${options.inboxPath}"`,
    );
  }

  const processedEntries: MailboxEntry[] = [];
  let nextIndex = cursor.nextIndex;
  let updatedAt = cursor.updatedAt;

  while (nextIndex < entries.length) {
    const entry = entries[nextIndex];
    if (entry === undefined) {
      break;
    }

    await options.handleEntry(entry, { index: nextIndex });
    processedEntries.push(entry);
    nextIndex += 1;
    updatedAt = new Date().toISOString();
    await writeMailboxCursor(options.cursorPath, {
      nextIndex,
      updatedAt,
    });
  }

  return {
    entries: processedEntries,
    cursor: {
      nextIndex,
      updatedAt,
    },
    processedCount: processedEntries.length,
  };
}

export async function consumeTeamMailboxEntries(
  teamName: string,
  ownerName: string,
  handleEntry: MailboxEntryHandler,
  options: MailboxOperationOptions = {},
): Promise<ConsumeMailboxResult> {
  return consumeMailboxEntries({
    inboxPath: teamMailboxInboxPath(teamName, ownerName),
    cursorPath: teamMailboxCursorPath(teamName, ownerName),
    handleEntry,
    ...options,
  });
}

export async function consumeLeaderMailboxEntries(
  teamName: string,
  handleEntry: MailboxEntryHandler,
  options: MailboxOperationOptions = {},
): Promise<ConsumeMailboxResult> {
  return consumeTeamMailboxEntries(
    teamName,
    LEADER_MAILBOX_OWNER,
    handleEntry,
    options,
  );
}

export function startMailboxPolling(
  options: MailboxPollOptions,
): MailboxPollController {
  const intervalMs =
    (options.intervalSecs ?? getMailboxPollIntervalSecs(options.env)) * 1000;
  const setTimeoutImpl = options.setTimeoutImpl ?? globalThis.setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl ?? globalThis.clearTimeout;

  let stopped = false;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let inFlight: Promise<ConsumeMailboxResult> | undefined;

  const scheduleNextPoll = (): void => {
    if (stopped) {
      return;
    }

    timer = setTimeoutImpl(() => {
      void runScheduledPoll();
    }, intervalMs);
  };

  const clearScheduledPoll = (): void => {
    if (timer === undefined) {
      return;
    }

    clearTimeoutImpl(timer);
    timer = undefined;
  };

  const pollNow = async (): Promise<ConsumeMailboxResult> => {
    if (inFlight !== undefined) {
      return inFlight;
    }

    clearScheduledPoll();

    const currentPoll = consumeMailboxEntries(options);
    inFlight = currentPoll;

    try {
      return await currentPoll;
    } catch (error: unknown) {
      await options.onError?.(error);
      throw error;
    } finally {
      if (inFlight === currentPoll) {
        inFlight = undefined;
      }

      if (!stopped) {
        scheduleNextPoll();
      }
    }
  };

  const runScheduledPoll = async (): Promise<void> => {
    try {
      await pollNow();
    } catch {
      // `onError` already observed the failure; keep the poll loop alive.
    }
  };

  if (options.startImmediate ?? true) {
    void runScheduledPoll();
  } else {
    scheduleNextPoll();
  }

  return {
    stop: () => {
      stopped = true;
      clearScheduledPoll();
    },
    pollNow,
  };
}

function resolveMailboxLockOptions(
  options: MailboxOperationOptions,
): SharedLockOptions {
  const { env, ...lockOptions } = options;
  return mailboxLockOptions(env, lockOptions);
}

async function withMailboxInboxLock<T>(
  inboxPath: string,
  callback: () => Promise<T>,
  options: MailboxOperationOptions = {},
): Promise<T> {
  // Both appenders and consumers lock the inbox path directly so they contend
  // on the exact same proper-lockfile key and cannot bypass each other.
  const lockOptions = resolveMailboxLockOptions(options);

  const attemptLock = async (): Promise<T> => {
    await ensureMailboxInbox(inboxPath);

    return withFileLock(
      inboxPath,
      async () => {
        await ensureMailboxInbox(inboxPath);
        return callback();
      },
      lockOptions,
    );
  };

  try {
    return await attemptLock();
  } catch (error: unknown) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }

  return attemptLock();
}

async function appendMailboxLine(
  inboxPath: string,
  entry: MailboxEntry,
): Promise<void> {
  try {
    await appendFile(
      inboxPath,
      `${JSON.stringify(entry as JsonValue)}\n`,
      "utf8",
    );
  } catch (error: unknown) {
    throw new MailboxStorageError(
      "mailbox-write-failed",
      `Failed to append mailbox entry to "${inboxPath}"`,
      { cause: error },
    );
  }
}

function createInitialMailboxCursor(): MailboxCursor {
  return {
    nextIndex: 0,
    updatedAt: new Date().toISOString(),
  };
}

async function ensureMailboxInbox(inboxPath: string): Promise<void> {
  await mkdir(dirname(inboxPath), { recursive: true });
  await appendFile(inboxPath, "", "utf8");
}

async function ensureMailboxCursor(cursorPath: string): Promise<void> {
  await mkdir(dirname(cursorPath), { recursive: true });

  try {
    await readFile(cursorPath, "utf8");
  } catch (err: unknown) {
    if (isMissingFileError(err)) {
      await writeMailboxCursor(cursorPath, createInitialMailboxCursor());
      return;
    }

    // Intentionally do not auto-repair malformed existing cursor files here.
    // Resetting to the initial cursor would silently re-deliver already
    // acknowledged messages, which is worse than surfacing corruption for
    // explicit operator-driven recovery.
    throw new MailboxStorageError(
      "cursor-read-failed",
      `Failed to ensure mailbox cursor at "${cursorPath}"`,
      { cause: err },
    );
  }
}

function validateMailboxOwnerName(ownerName: string): string {
  const trimmedOwnerName = ownerName.trim();
  if (trimmedOwnerName.length === 0 || trimmedOwnerName !== ownerName) {
    throw new MailboxStorageError(
      "invalid-mailbox-owner",
      `Mailbox owner name "${ownerName}" is invalid`,
    );
  }

  if (!/^[A-Za-z0-9_-]+$/.test(trimmedOwnerName)) {
    throw new MailboxStorageError(
      "invalid-mailbox-owner",
      `Mailbox owner name "${ownerName}" must contain only letters, numbers, underscores, and hyphens`,
    );
  }

  return trimmedOwnerName;
}

function toMailboxEntry(
  inboxPath: string,
  value: JsonValue,
  lineNumber: number,
): MailboxEntry {
  if (!isJsonObject(value)) {
    throw new MailboxStorageError(
      "invalid-mailbox-entry",
      `Invalid mailbox entry in "${inboxPath}" at line ${lineNumber}: expected an object`,
    );
  }

  return normalizeMailboxEntry({
    timestamp: value.timestamp,
    sender: value.sender,
    receiver: value.receiver,
    subject: value.subject,
    message: value.message,
  });
}

function normalizeMailboxEntry(value: {
  timestamp: unknown;
  sender: unknown;
  receiver: unknown;
  subject: unknown;
  message: unknown;
}): MailboxEntry {
  return {
    timestamp: requireNonEmptyString(value.timestamp, "timestamp"),
    sender: requireNonEmptyString(value.sender, "sender"),
    receiver: requireNonEmptyString(value.receiver, "receiver"),
    subject: requireNonEmptyString(value.subject, "subject"),
    message: requireString(value.message, "message"),
  };
}

function toMailboxCursor(path: string, value: unknown): MailboxCursor {
  if (!isObject(value)) {
    throw new MailboxStorageError(
      "invalid-cursor",
      `Mailbox cursor at "${path}" must be an object`,
    );
  }

  return {
    nextIndex: requireNonNegativeInteger(value.nextIndex, path, "nextIndex"),
    updatedAt: requireNonEmptyString(value.updatedAt, "updatedAt", path, true),
  };
}

function requireNonEmptyString(
  value: unknown,
  fieldName: string,
  path = "mailbox entry",
  cursorField = false,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MailboxStorageError(
      cursorField ? "invalid-cursor" : "invalid-mailbox-entry",
      `Invalid ${path}: ${fieldName} must be a non-empty string`,
    );
  }

  return value;
}

function requireNonNegativeInteger(
  value: unknown,
  path: string,
  fieldName: string,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new MailboxStorageError(
      "invalid-cursor",
      `Mailbox cursor at "${path}" must include a non-negative integer ${fieldName}`,
    );
  }

  return value;
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new MailboxStorageError(
      "invalid-mailbox-entry",
      `Invalid mailbox entry: ${fieldName} must be a string`,
    );
  }

  return value;
}

function isJsonObject(
  value: JsonValue,
): value is Exclude<JsonValue, string | number | boolean | null | JsonValue[]> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

function isMissingPathError(error: unknown): boolean {
  if (isMissingFileError(error)) {
    return true;
  }

  if (error instanceof AggregateError) {
    return error.errors.some((entry) => isMissingPathError(entry));
  }

  if (error instanceof Error && "cause" in error) {
    return isMissingPathError(error.cause);
  }

  return false;
}

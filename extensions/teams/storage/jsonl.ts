/**
 * Shared JSONL storage helpers.
 *
 * JSONL is used for append-only mailboxes and event logs. Writers are wrapped
 * in the shared locking helper so concurrent appends stay safe across leader
 * and agent processes.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type SharedLockOptions, withFileLock } from "./locks.ts";

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type JsonlMutationOptions = SharedLockOptions;

export const DEFAULT_JSONL_LOCK_RETRIES = {
  retries: 25,
  factor: 1,
  minTimeout: 10,
  maxTimeout: 10,
  randomize: false,
} as const;

export class JsonlStorageError extends Error {
  readonly code:
    | "jsonl-parse-failed"
    | "jsonl-read-failed"
    | "jsonl-write-failed";

  constructor(
    code: JsonlStorageError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "JsonlStorageError";
    this.code = code;
  }
}

export type LockedJsonlFile<T extends JsonValue> = {
  readEntries: () => Promise<T[]>;
  appendEntry: (entry: T) => Promise<void>;
  overwriteEntries: (entries: readonly T[]) => Promise<void>;
};

export async function appendJsonlEntry<T extends JsonValue>(
  path: string,
  entry: T,
  options: JsonlMutationOptions = {},
): Promise<void> {
  await withLockedJsonlFile(path, (file) => file.appendEntry(entry), options);
}

export async function overwriteJsonlEntries<T extends JsonValue>(
  path: string,
  entries: readonly T[],
  options: JsonlMutationOptions = {},
): Promise<void> {
  await withLockedJsonlFile(
    path,
    (file) => file.overwriteEntries(entries),
    options,
  );
}

export async function readJsonlEntries<T extends JsonValue>(
  path: string,
): Promise<T[]> {
  const rawContent = await readJsonlText(path);
  if (rawContent.trim().length === 0) {
    return [];
  }

  return rawContent
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => parseJsonlLine<T>(path, line, index + 1));
}

export async function withLockedJsonlFile<T extends JsonValue, TResult>(
  path: string,
  callback: (file: LockedJsonlFile<T>) => Promise<TResult>,
  options: JsonlMutationOptions = {},
): Promise<TResult> {
  await ensureJsonlPath(path);

  return withFileLock(
    path,
    async () => {
      const file: LockedJsonlFile<T> = {
        readEntries: async () => readJsonlEntries<T>(path),
        appendEntry: async (entry) => appendJsonlLine(path, entry),
        overwriteEntries: async (entries) => overwriteJsonlText(path, entries),
      };

      return callback(file);
    },
    normalizeJsonlMutationOptions(options),
  );
}

async function ensureJsonlPath(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, "", "utf8");
}

async function appendJsonlLine<T extends JsonValue>(
  path: string,
  entry: T,
): Promise<void> {
  try {
    await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (err: unknown) {
    throw new JsonlStorageError(
      "jsonl-write-failed",
      `Failed to append JSONL entry to "${path}"`,
      { cause: err },
    );
  }
}

async function overwriteJsonlText<T extends JsonValue>(
  path: string,
  entries: readonly T[],
): Promise<void> {
  const content = entries.map((entry) => JSON.stringify(entry)).join("\n");

  try {
    await writeFile(path, content.length > 0 ? `${content}\n` : "", "utf8");
  } catch (err: unknown) {
    throw new JsonlStorageError(
      "jsonl-write-failed",
      `Failed to overwrite JSONL entries in "${path}"`,
      { cause: err },
    );
  }
}

async function readJsonlText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err: unknown) {
    if (isMissingFileError(err)) {
      return "";
    }

    const message = err instanceof Error ? err.message : String(err);
    throw new JsonlStorageError(
      "jsonl-read-failed",
      `Failed to read JSONL file "${path}": ${message}`,
      { cause: err },
    );
  }
}

function isMissingFileError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

function normalizeJsonlMutationOptions(
  options: JsonlMutationOptions,
): JsonlMutationOptions {
  if (options.retries !== undefined) {
    return options;
  }

  return {
    ...options,
    retries: DEFAULT_JSONL_LOCK_RETRIES,
  };
}

function parseJsonlLine<T extends JsonValue>(
  path: string,
  line: string,
  lineNumber: number,
): T {
  try {
    return JSON.parse(line) as T;
  } catch (err: unknown) {
    throw new JsonlStorageError(
      "jsonl-parse-failed",
      `Invalid JSONL in "${path}" at line ${lineNumber}`,
      { cause: err },
    );
  }
}

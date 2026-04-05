/**
 * Team event-log helpers.
 *
 * The leader appends timestamped events to an append-only JSONL file under the
 * team home directory so operators can inspect the audit trail later.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  appendJsonlEntry,
  type JsonlMutationOptions,
  type JsonObject,
  type JsonValue,
  readJsonlEntries,
} from "./jsonl.ts";
import { teamDir } from "./team-home.ts";

export type EventLogEntry = {
  timestamp: string;
  type: string;
  message?: string;
  details?: JsonObject;
};

export type NewEventLogEntry = {
  timestamp?: string;
  type: string;
  message?: string;
  details?: JsonObject;
};

export class EventLogStorageError extends Error {
  readonly code: "event-log-parse-failed";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EventLogStorageError";
    this.code = "event-log-parse-failed";
  }
}

export function teamLogsDir(teamName: string): string {
  return join(teamDir(teamName), "logs");
}

export function teamEventLogPath(teamName: string): string {
  return join(teamLogsDir(teamName), "events.jsonl");
}

export async function appendEventLogEntry(
  path: string,
  entry: NewEventLogEntry,
  options: JsonlMutationOptions = {},
): Promise<EventLogEntry> {
  const fullEntry: EventLogEntry = {
    timestamp: entry.timestamp ?? new Date().toISOString(),
    type: entry.type,
    ...(entry.message !== undefined && { message: entry.message }),
    ...(entry.details !== undefined && { details: entry.details }),
  };

  await appendJsonlEntry(path, fullEntry as JsonValue, options);
  return fullEntry;
}

export async function appendTeamEventLogEntry(
  teamName: string,
  entry: NewEventLogEntry,
  options: JsonlMutationOptions = {},
): Promise<EventLogEntry> {
  const logsDir = teamLogsDir(teamName);
  await mkdir(logsDir, { recursive: true });
  return appendEventLogEntry(teamEventLogPath(teamName), entry, options);
}

export async function readEventLogEntries(
  path: string,
): Promise<EventLogEntry[]> {
  const entries = await readJsonlEntries<JsonValue>(path);
  return entries.map((entry, index) => toEventLogEntry(path, entry, index + 1));
}

function toEventLogEntry(
  path: string,
  value: JsonValue,
  lineNumber: number,
): EventLogEntry {
  if (!isJsonObject(value)) {
    throw new EventLogStorageError(
      `Invalid event-log entry in "${path}" at line ${lineNumber}: expected an object`,
    );
  }

  const timestamp = value.timestamp;
  const type = value.type;
  const message = value.message;
  const details = value.details;

  if (typeof timestamp !== "string" || typeof type !== "string") {
    throw new EventLogStorageError(
      `Invalid event-log entry in "${path}" at line ${lineNumber}: missing timestamp or type`,
    );
  }

  if (message !== undefined && typeof message !== "string") {
    throw new EventLogStorageError(
      `Invalid event-log entry in "${path}" at line ${lineNumber}: message must be a string when present`,
    );
  }

  if (details !== undefined && !isJsonObject(details)) {
    throw new EventLogStorageError(
      `Invalid event-log entry in "${path}" at line ${lineNumber}: details must be an object when present`,
    );
  }

  return {
    timestamp,
    type,
    ...(message !== undefined && { message }),
    ...(details !== undefined && { details }),
  };
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

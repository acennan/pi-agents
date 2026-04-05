import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendEventLogEntry,
  appendTeamEventLogEntry,
  type EventLogStorageError,
  readEventLogEntries,
  teamEventLogPath,
  teamLogsDir,
} from "../storage/event-log.ts";

const TEST_ROOT = join(tmpdir(), "pi-teams-event-log-test-tmp");

beforeEach(async () => {
  process.env.PI_TEAMS_ROOT = TEST_ROOT;
  await mkdir(TEST_ROOT, { recursive: true });
});

afterEach(async () => {
  delete process.env.PI_TEAMS_ROOT;
  await rm(TEST_ROOT, { recursive: true, force: true });
});

describe("event log helpers", () => {
  it("creates the team logs directory lazily when appending events", async () => {
    const entry = await appendTeamEventLogEntry("alpha", {
      type: "team-created",
      message: "Created team alpha",
      details: { leader: "leader-1" },
    });

    expect(existsSync(teamLogsDir("alpha"))).toBe(true);
    expect(existsSync(teamEventLogPath("alpha"))).toBe(true);
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("round-trips appended event-log entries", async () => {
    const logPath = join(TEST_ROOT, "custom-events.jsonl");

    await appendEventLogEntry(logPath, {
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "task-assigned",
      details: { taskId: "pi-agents-123" },
    });
    await appendEventLogEntry(logPath, {
      timestamp: "2026-01-01T00:01:00.000Z",
      type: "task-complete",
      message: "Completed successfully",
    });

    await expect(readEventLogEntries(logPath)).resolves.toEqual([
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "task-assigned",
        details: { taskId: "pi-agents-123" },
      },
      {
        timestamp: "2026-01-01T00:01:00.000Z",
        type: "task-complete",
        message: "Completed successfully",
      },
    ]);
  });

  it("throws a typed error for invalid event-log entries", async () => {
    const logPath = join(TEST_ROOT, "invalid-events.jsonl");

    await writeFile(
      logPath,
      `${JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "ok" })}\n${JSON.stringify({ timestamp: "2026-01-01T00:01:00.000Z", type: "bad", message: 123 })}\n`,
      "utf8",
    );

    await expect(readEventLogEntries(logPath)).rejects.toMatchObject({
      name: "EventLogStorageError",
      code: "event-log-parse-failed",
    } satisfies Pick<EventLogStorageError, "name" | "code">);
  });
});

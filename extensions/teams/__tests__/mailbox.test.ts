import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendLeaderMailboxEntry,
  appendTeamMailboxEntry,
  consumeLeaderMailboxEntries,
  consumeTeamMailboxEntries,
  DEFAULT_TEAM_MAILBOX_POLL_SECS,
  ensureTeamMailbox,
  getMailboxPollIntervalSecs,
  leaderCursorPath,
  leaderInboxPath,
  type MailboxStorageError,
  readMailboxCursor,
  readMailboxEntries,
  removeTeamMailbox,
  startMailboxPolling,
  teamMailboxCursorPath,
  teamMailboxesDir,
  teamMailboxInboxPath,
} from "../agents/mailbox.ts";

const TEST_ROOT = join(tmpdir(), "pi-teams-mailbox-test-tmp");

describe("mailbox helpers", () => {
  beforeEach(async () => {
    process.env.PI_TEAMS_ROOT = TEST_ROOT;
    await mkdir(TEST_ROOT, { recursive: true });
  });

  afterEach(async () => {
    delete process.env.PI_TEAMS_ROOT;
    await rm(TEST_ROOT, { recursive: true, force: true });
  });

  it("builds the documented inbox and cursor paths for agents and the leader", () => {
    expect(teamMailboxesDir("alpha")).toBe(
      join(TEST_ROOT, "alpha", "mailboxes"),
    );
    expect(teamMailboxInboxPath("alpha", "code-1")).toBe(
      join(TEST_ROOT, "alpha", "mailboxes", "code-1-inbox.jsonl"),
    );
    expect(teamMailboxCursorPath("alpha", "code-1")).toBe(
      join(TEST_ROOT, "alpha", "mailboxes", "code-1-cursor.json"),
    );
    expect(leaderInboxPath("alpha")).toBe(
      join(TEST_ROOT, "alpha", "mailboxes", "leader-inbox.jsonl"),
    );
    expect(leaderCursorPath("alpha")).toBe(
      join(TEST_ROOT, "alpha", "mailboxes", "leader-cursor.json"),
    );
  });

  it("creates inbox and cursor files for a team mailbox", async () => {
    await ensureTeamMailbox("alpha", "code-1");

    expect(existsSync(teamMailboxInboxPath("alpha", "code-1"))).toBe(true);
    expect(existsSync(teamMailboxCursorPath("alpha", "code-1"))).toBe(true);
    await expect(
      readMailboxCursor(teamMailboxCursorPath("alpha", "code-1")),
    ).resolves.toMatchObject({
      nextIndex: 0,
    });
  });

  it("appends and reads leader mailbox entries with the leader receiver filled automatically", async () => {
    const entry = await appendLeaderMailboxEntry("alpha", {
      sender: "code-1",
      subject: "task-complete",
      message: "Completed pi-agents-123",
    });

    expect(entry.receiver).toBe("leader");
    await expect(readMailboxEntries(leaderInboxPath("alpha"))).resolves.toEqual(
      [
        {
          timestamp: entry.timestamp,
          sender: "code-1",
          receiver: "leader",
          subject: "task-complete",
          message: "Completed pi-agents-123",
        },
      ],
    );
  });

  it("rejects writing an entry to the wrong inbox", async () => {
    await expect(
      appendTeamMailboxEntry("alpha", "code-1", {
        sender: "leader",
        receiver: "leader",
        subject: "queued-work",
        message: "Do thing",
      }),
    ).rejects.toMatchObject({
      name: "MailboxStorageError",
      code: "receiver-mismatch",
    } satisfies Pick<MailboxStorageError, "name" | "code">);
  });

  it("consumes pending entries once and advances the cursor", async () => {
    await appendTeamMailboxEntry("alpha", "code-1", {
      sender: "leader",
      subject: "queued-work",
      message: "Task A",
    });
    await appendTeamMailboxEntry("alpha", "code-1", {
      sender: "leader",
      subject: "steer",
      message: "Focus on tests",
    });

    const handledSubjects: string[] = [];
    const firstResult = await consumeTeamMailboxEntries(
      "alpha",
      "code-1",
      async (entry) => {
        handledSubjects.push(entry.subject);
      },
    );

    expect(firstResult.processedCount).toBe(2);
    expect(firstResult.cursor.nextIndex).toBe(2);
    expect(handledSubjects).toEqual(["queued-work", "steer"]);

    const secondResult = await consumeTeamMailboxEntries(
      "alpha",
      "code-1",
      async () => {},
    );

    expect(secondResult.processedCount).toBe(0);
    expect(secondResult.cursor.nextIndex).toBe(2);
  });

  it("does not lose messages or reprocess already-acknowledged ones after a partial failure", async () => {
    for (const subject of ["one", "two", "three"]) {
      await appendLeaderMailboxEntry("alpha", {
        sender: "code-1",
        subject,
        message: `message-${subject}`,
      });
    }

    const firstAttempt: string[] = [];
    await expect(
      consumeLeaderMailboxEntries("alpha", async (entry) => {
        firstAttempt.push(entry.subject);
        if (entry.subject === "two") {
          throw new Error("stop after second message");
        }
      }),
    ).rejects.toThrow("stop after second message");

    expect(firstAttempt).toEqual(["one", "two"]);

    const retryAttempt: string[] = [];
    const retryResult = await consumeLeaderMailboxEntries(
      "alpha",
      async (entry) => {
        retryAttempt.push(entry.subject);
      },
    );

    expect(retryAttempt).toEqual(["two", "three"]);
    expect(retryResult.processedCount).toBe(2);
    await expect(
      readMailboxCursor(leaderCursorPath("alpha")),
    ).resolves.toMatchObject({
      nextIndex: 3,
    });
  });

  it("serializes concurrent appends to the same inbox", async () => {
    await Promise.all([
      appendLeaderMailboxEntry("alpha", {
        sender: "code-1",
        subject: "subject-1",
        message: "message-1",
      }),
      appendLeaderMailboxEntry("alpha", {
        sender: "code-2",
        subject: "subject-2",
        message: "message-2",
      }),
    ]);

    const entries = await readMailboxEntries(leaderInboxPath("alpha"));

    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.subject))).toEqual(
      new Set(["subject-1", "subject-2"]),
    );
  });

  it("uses the shared polling helper for repeated mailbox consumption", async () => {
    let scheduledCount = 0;
    let clearedCount = 0;
    const setTimeoutImpl = ((
      _callback: Parameters<typeof globalThis.setTimeout>[0],
      _delay?: number,
    ) => {
      scheduledCount += 1;
      return 1 as unknown as ReturnType<typeof globalThis.setTimeout>;
    }) as typeof globalThis.setTimeout;
    const clearTimeoutImpl = ((
      _timeoutId: ReturnType<typeof globalThis.setTimeout>,
    ) => {
      clearedCount += 1;
    }) as typeof globalThis.clearTimeout;
    const handledSubjects: string[] = [];

    await appendLeaderMailboxEntry("alpha", {
      sender: "code-1",
      subject: "task-complete",
      message: "done",
    });

    const poller = startMailboxPolling({
      inboxPath: leaderInboxPath("alpha"),
      cursorPath: leaderCursorPath("alpha"),
      handleEntry: async (entry) => {
        handledSubjects.push(entry.subject);
      },
      startImmediate: false,
      intervalSecs: 2,
      setTimeoutImpl,
      clearTimeoutImpl,
    });

    await poller.pollNow();
    poller.stop();

    expect(handledSubjects).toEqual(["task-complete"]);
    expect(scheduledCount).toBeGreaterThan(0);
    expect(clearedCount).toBeGreaterThan(0);
  });

  it("starts polling immediately and reports scheduled errors via onError", async () => {
    let handledCount = 0;

    await appendLeaderMailboxEntry("alpha", {
      sender: "code-1",
      subject: "task-failed",
      message: "boom",
    });

    const observedError = await new Promise<unknown>((resolve) => {
      const poller = startMailboxPolling({
        inboxPath: leaderInboxPath("alpha"),
        cursorPath: leaderCursorPath("alpha"),
        handleEntry: async () => {
          handledCount += 1;
          throw new Error("scheduled failure");
        },
        intervalSecs: 2,
        onError: (error) => {
          poller.stop();
          resolve(error);
        },
      });
    });

    expect(handledCount).toBe(1);
    expect(observedError).toBeInstanceOf(Error);
    expect((observedError as Error).message).toBe("scheduled failure");
  });

  it("uses the documented mailbox polling interval defaults", () => {
    expect(getMailboxPollIntervalSecs({})).toBe(DEFAULT_TEAM_MAILBOX_POLL_SECS);
    expect(getMailboxPollIntervalSecs({ PI_TEAM_MAILBOX_POLL_SECS: "9" })).toBe(
      9,
    );
    expect(getMailboxPollIntervalSecs({ PI_TEAM_MAILBOX_POLL_SECS: "0" })).toBe(
      DEFAULT_TEAM_MAILBOX_POLL_SECS,
    );
  });

  it("removes inbox and cursor files for cleaned-up sub-agents", async () => {
    await ensureTeamMailbox("alpha", "review-1");

    await removeTeamMailbox("alpha", "review-1");

    expect(existsSync(teamMailboxInboxPath("alpha", "review-1"))).toBe(false);
    expect(existsSync(teamMailboxCursorPath("alpha", "review-1"))).toBe(false);
  });
});

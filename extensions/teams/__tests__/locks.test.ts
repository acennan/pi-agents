import { existsSync } from "node:fs";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireFileLock,
  DEFAULT_MAILBOX_LOCK_ATTEMPTS,
  forceReleaseFileLock,
  getMailboxLockAttempts,
  isFileLocked,
  mailboxLockOptions,
  withFileLock,
} from "../storage/locks.ts";

const TEST_ROOT = join(tmpdir(), "pi-teams-locks-test-tmp");

describe("storage locks", () => {
  beforeEach(async () => {
    await mkdir(TEST_ROOT, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_ROOT, { recursive: true, force: true });
  });

  it("uses the documented mailbox retry defaults", () => {
    expect(getMailboxLockAttempts({})).toBe(DEFAULT_MAILBOX_LOCK_ATTEMPTS);
    expect(getMailboxLockAttempts({ PI_MAILBOX_LOCK_ATTEMPTS: "7" })).toBe(7);
    expect(getMailboxLockAttempts({ PI_MAILBOX_LOCK_ATTEMPTS: "0" })).toBe(
      DEFAULT_MAILBOX_LOCK_ATTEMPTS,
    );

    const options = mailboxLockOptions({ PI_MAILBOX_LOCK_ATTEMPTS: "3" });
    expect(options.retries).toMatchObject({
      retries: 3,
      minTimeout: 5000,
      maxTimeout: 5000,
      factor: 1,
      randomize: false,
    });
  });

  it("reports lock state while a file is locked", async () => {
    const targetPath = join(TEST_ROOT, "status.json");
    await writeFile(targetPath, "{}", "utf8");

    await withFileLock(targetPath, async () => {
      await expect(isFileLocked(targetPath)).resolves.toBe(true);
    });

    await expect(isFileLocked(targetPath)).resolves.toBe(false);
  });

  it("treats stale locks as recoverable after the stale timeout", async () => {
    const targetPath = join(TEST_ROOT, "stale.jsonl");
    const staleLockPath = `${targetPath}.lock`;
    await writeFile(targetPath, "", "utf8");
    await mkdir(staleLockPath, { recursive: true });

    const staleTimestamp = new Date(Date.now() - 10_000);
    await utimes(staleLockPath, staleTimestamp, staleTimestamp);

    let callbackRan = false;
    await withFileLock(
      targetPath,
      async () => {
        callbackRan = true;
      },
      { staleMs: 5_000 },
    );

    expect(callbackRan).toBe(true);
    expect(existsSync(staleLockPath)).toBe(false);
  });

  it("force-releases a lock when recovery logic decides it is safe", async () => {
    const targetPath = join(TEST_ROOT, "force-release.json");
    await writeFile(targetPath, "{}", "utf8");

    const release = await acquireFileLock(targetPath);
    await expect(isFileLocked(targetPath)).resolves.toBe(true);

    await forceReleaseFileLock(targetPath);
    await expect(isFileLocked(targetPath)).resolves.toBe(false);

    await release().catch(() => undefined);
  });
});

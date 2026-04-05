import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { teamDir } from "../storage/team-home.ts";
import {
  claimRuntimeLock,
  clearStaleRuntimeLock,
  createRuntimeLockRecord,
  inspectRuntimeLock,
  readRuntimeLock,
  removeRuntimeLock,
  runtimeLockPath,
  writeRuntimeLock,
} from "../storage/team-lease.ts";

const TEST_ROOT = join(tmpdir(), "pi-teams-team-lease-test-tmp");

beforeEach(async () => {
  process.env.PI_TEAMS_ROOT = TEST_ROOT;
  await mkdir(TEST_ROOT, { recursive: true });
});

afterEach(async () => {
  delete process.env.PI_TEAMS_ROOT;
  await rm(TEST_ROOT, { recursive: true, force: true });
});

describe("team runtime lease", () => {
  it("writes runtime-lock.json with the required fields", async () => {
    await mkdir(teamDir("alpha"), { recursive: true });

    const action = await claimRuntimeLock(
      "alpha",
      createRuntimeLockRecord("session-alpha", {
        pid: 1234,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      {
        processAlive: () => true,
      },
    );

    expect(action).toBe("claimed");
    expect(existsSync(runtimeLockPath("alpha"))).toBe(true);
    await expect(readRuntimeLock("alpha")).resolves.toEqual({
      sessionId: "session-alpha",
      pid: 1234,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("reports an active runtime lock when the recorded pid is still alive", async () => {
    await mkdir(teamDir("active-team"), { recursive: true });
    await writeRuntimeLock(
      "active-team",
      createRuntimeLockRecord("active-session", {
        pid: 111,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await expect(
      inspectRuntimeLock("active-team", {
        processAlive: () => true,
      }),
    ).resolves.toMatchObject({
      state: "active",
      record: {
        sessionId: "active-session",
        pid: 111,
      },
    });
  });

  it("blocks a second leader from claiming an active runtime lock", async () => {
    await mkdir(teamDir("contended-team"), { recursive: true });
    await writeRuntimeLock(
      "contended-team",
      createRuntimeLockRecord("leader-a", {
        pid: 222,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await expect(
      claimRuntimeLock(
        "contended-team",
        createRuntimeLockRecord("leader-b", {
          pid: 333,
          createdAt: "2026-01-02T00:00:00.000Z",
        }),
        {
          processAlive: () => true,
        },
      ),
    ).rejects.toMatchObject({
      name: "TeamLeaseError",
      code: "lease-active",
    });
  });

  it("does not clear a stale lock unless the caller explicitly allows recovery", async () => {
    await mkdir(teamDir("stale-team"), { recursive: true });
    await writeRuntimeLock(
      "stale-team",
      createRuntimeLockRecord("old-session", {
        pid: 444,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await expect(
      claimRuntimeLock(
        "stale-team",
        createRuntimeLockRecord("new-session", {
          pid: 555,
          createdAt: "2026-01-02T00:00:00.000Z",
        }),
        {
          processAlive: () => false,
        },
      ),
    ).rejects.toMatchObject({
      name: "TeamLeaseError",
      code: "lease-stale",
    });
  });

  it("recovers a stale lock during an explicit recovery flow", async () => {
    await mkdir(teamDir("recoverable-team"), { recursive: true });
    await writeRuntimeLock(
      "recoverable-team",
      createRuntimeLockRecord("old-session", {
        pid: 666,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const action = await claimRuntimeLock(
      "recoverable-team",
      createRuntimeLockRecord("new-session", {
        pid: 777,
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
      {
        allowStaleRecovery: true,
        processAlive: () => false,
      },
    );

    expect(action).toBe("recovered-stale");
    await expect(readRuntimeLock("recoverable-team")).resolves.toMatchObject({
      sessionId: "new-session",
      pid: 777,
    });
  });

  it("clears a stale runtime lock only when recovery has validated it", async () => {
    await mkdir(teamDir("clearable-team"), { recursive: true });
    await writeRuntimeLock(
      "clearable-team",
      createRuntimeLockRecord("old-session", {
        pid: 888,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await expect(
      clearStaleRuntimeLock("clearable-team", {
        processAlive: () => true,
      }),
    ).rejects.toMatchObject({
      name: "TeamLeaseError",
      code: "lease-active",
    });

    await expect(
      clearStaleRuntimeLock("clearable-team", {
        processAlive: () => false,
      }),
    ).resolves.toBe(true);
    expect(existsSync(runtimeLockPath("clearable-team"))).toBe(false);
  });

  it("returns false when removing a runtime lock from a cleanly stopped team", async () => {
    await mkdir(teamDir("stopped-team"), { recursive: true });

    await expect(removeRuntimeLock("stopped-team")).resolves.toBe(false);
  });

  it("rejects invalid runtime lock records on read", async () => {
    await mkdir(teamDir("invalid-team"), { recursive: true });
    await writeFile(
      runtimeLockPath("invalid-team"),
      '{"sessionId":"x"}\n',
      "utf8",
    );

    await expect(readRuntimeLock("invalid-team")).rejects.toMatchObject({
      name: "TeamLeaseError",
      code: "lease-invalid",
    });
  });
});

import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareTeamDeletion } from "../leader/delete-team.ts";
import { teamDir } from "../storage/team-home.ts";
import { runtimeLockPath, writeRuntimeLock } from "../storage/team-lease.ts";

const TEST_ROOT = join(tmpdir(), "pi-teams-delete-team-test-tmp");

beforeEach(async () => {
  process.env.PI_TEAMS_ROOT = TEST_ROOT;
  await mkdir(TEST_ROOT, { recursive: true });
});

afterEach(async () => {
  delete process.env.PI_TEAMS_ROOT;
  await rm(TEST_ROOT, { recursive: true, force: true });
});

describe("prepareTeamDeletion", () => {
  it("returns a no-op result when no runtime lock exists", async () => {
    await mkdir(teamDir("delete-clean"), { recursive: true });

    await expect(
      prepareTeamDeletion({
        teamName: "delete-clean",
        processAlive: () => false,
      }),
    ).resolves.toEqual({
      hadRuntimeLock: false,
      clearedStaleRuntimeLock: false,
    });
  });

  it("rejects deleting a team that still has an active runtime lock", async () => {
    await mkdir(teamDir("delete-active"), { recursive: true });
    await writeRuntimeLock("delete-active", {
      sessionId: "leader-session",
      pid: 2101,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(
      prepareTeamDeletion({
        teamName: "delete-active",
        processAlive: () => true,
      }),
    ).rejects.toMatchObject({
      name: "TeamLeaseError",
      code: "lease-active",
    });
    expect(existsSync(runtimeLockPath("delete-active"))).toBe(true);
  });

  it("clears a stale runtime lock before deletion continues", async () => {
    await mkdir(teamDir("delete-stale"), { recursive: true });
    await writeRuntimeLock("delete-stale", {
      sessionId: "stale-session",
      pid: 2102,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(
      prepareTeamDeletion({
        teamName: "delete-stale",
        processAlive: () => false,
      }),
    ).resolves.toEqual({
      hadRuntimeLock: true,
      clearedStaleRuntimeLock: true,
    });
    expect(existsSync(runtimeLockPath("delete-stale"))).toBe(false);
  });
});

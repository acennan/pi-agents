import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTeam } from "../leader/create-team.ts";
import {
  readTeamSnapshot,
  sharedPromptTemplatesDir,
  TeamAlreadyExistsError,
  teamConfigPath,
  teamDir,
  teamsRootDir,
} from "../storage/team-home.ts";

// ---------------------------------------------------------------------------
// Isolate file system writes using PI_TEAMS_ROOT env var.
// ---------------------------------------------------------------------------

const TEST_ROOT = join(tmpdir(), "pi-create-team-test-tmp");

beforeEach(async () => {
  process.env.PI_TEAMS_ROOT = TEST_ROOT;
  await mkdir(TEST_ROOT, { recursive: true });
});

afterEach(async () => {
  delete process.env.PI_TEAMS_ROOT;
  await rm(TEST_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EXTENSION_SRC = resolve(__dirname, ".."); // extensions/teams/

function baseParams() {
  return {
    name: "my-team",
    workspacePath: "/repo/workspace",
    worktreeDir: "/repo/worktrees",
    model: "claude-opus-4",
    thinkingLevel: "medium",
    config: { agents: [] },
    extensionSourceDir: EXTENSION_SRC,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createTeam", () => {
  it("creates the team directory", async () => {
    await createTeam(baseParams());
    expect(existsSync(teamDir("my-team"))).toBe(true);
  });

  it("writes team-config.yaml", async () => {
    await createTeam(baseParams());
    expect(existsSync(teamConfigPath("my-team"))).toBe(true);
  });

  it("snapshot contains the correct team name", async () => {
    await createTeam(baseParams());
    const snap = await readTeamSnapshot("my-team");
    expect(snap.name).toBe("my-team");
  });

  it("resolves relative workspacePath to absolute", async () => {
    const snap = await createTeam({
      ...baseParams(),
      workspacePath: "relative/path",
    });
    expect(snap.workspacePath).toBe(resolve("relative/path"));
  });

  it("resolves relative worktreeDir to absolute", async () => {
    const snap = await createTeam({
      ...baseParams(),
      worktreeDir: "relative/worktrees",
    });
    expect(snap.worktreeDir).toBe(resolve("relative/worktrees"));
  });

  it("stores model and thinkingLevel", async () => {
    const snap = await createTeam(baseParams());
    expect(snap.model).toBe("claude-opus-4");
    expect(snap.thinkingLevel).toBe("medium");
  });

  it("stores the config snapshot", async () => {
    const config = { agents: [{ name: "code-1" }] };
    const snap = await createTeam({ ...baseParams(), config });
    expect(snap.config).toEqual(config);
  });

  it("includes configSourcePath when provided", async () => {
    const snap = await createTeam({
      ...baseParams(),
      configSourcePath: "/project/team.yaml",
    });
    expect(snap.configSourcePath).toBe(resolve("/project/team.yaml"));
  });

  it("omits configSourcePath when not provided", async () => {
    const snap = await createTeam(baseParams());
    expect(snap.configSourcePath).toBeUndefined();
  });

  it("sets createdAt to an ISO 8601 timestamp", async () => {
    const snap = await createTeam(baseParams());
    expect(snap.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("throws TeamAlreadyExistsError when the team already exists", async () => {
    await mkdir(teamDir("my-team"), { recursive: true });
    await expect(createTeam(baseParams())).rejects.toBeInstanceOf(
      TeamAlreadyExistsError,
    );
  });

  it("copies prompt templates to the shared directory", async () => {
    await createTeam(baseParams());
    const destDir = sharedPromptTemplatesDir();
    expect(existsSync(join(destDir, "code-prompt.md"))).toBe(true);
    expect(existsSync(join(destDir, "commit-prompt.md"))).toBe(true);
  });

  it("does not create the archives directory", async () => {
    await createTeam(baseParams());
    const archivesDir = join(teamsRootDir(), "archives");
    expect(existsSync(archivesDir)).toBe(false);
  });

  it("creates multiple teams with distinct names", async () => {
    await createTeam({ ...baseParams(), name: "team-alpha" });
    await createTeam({ ...baseParams(), name: "team-beta" });
    expect(existsSync(teamDir("team-alpha"))).toBe(true);
    expect(existsSync(teamDir("team-beta"))).toBe(true);
  });
});

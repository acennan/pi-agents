import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  copyBundledPromptTemplates,
  createTeamDir,
  ensureTeamsRoot,
  readTeamSnapshot,
  sharedPromptTemplatesDir,
  TeamAlreadyExistsError,
  type TeamSnapshot,
  teamConfigPath,
  teamDir,
  teamExists,
  teamsRootDir,
  writeTeamSnapshot,
} from "../storage/team-home.ts";

// ---------------------------------------------------------------------------
// Isolate file system writes using PI_TEAMS_ROOT env var.
// ---------------------------------------------------------------------------

const TEST_ROOT = join(tmpdir(), "pi-teams-test-tmp");

beforeEach(async () => {
  process.env.PI_TEAMS_ROOT = TEST_ROOT;
  await mkdir(TEST_ROOT, { recursive: true });
});

afterEach(async () => {
  delete process.env.PI_TEAMS_ROOT;
  await rm(TEST_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EXTENSION_SRC = resolve(__dirname, ".."); // extensions/teams/

function makeSnapshot(overrides: Partial<TeamSnapshot> = {}): TeamSnapshot {
  return {
    name: "test-team",
    workspacePath: "/repo/workspace",
    worktreeDir: "/repo/worktrees",
    model: "claude-opus-4",
    thinkingLevel: "medium",
    createdAt: "2026-01-01T00:00:00.000Z",
    config: { agents: [] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

describe("path helpers", () => {
  it("teamsRootDir returns the PI_TEAMS_ROOT value when set", () => {
    expect(teamsRootDir()).toBe(TEST_ROOT);
  });

  it("teamDir includes the team name under teamsRootDir", () => {
    expect(teamDir("my-team")).toBe(join(TEST_ROOT, "my-team"));
  });

  it("sharedPromptTemplatesDir is inside teamsRootDir", () => {
    expect(sharedPromptTemplatesDir()).toBe(
      join(TEST_ROOT, "prompt-templates"),
    );
  });

  it("teamConfigPath ends with team-config.yaml", () => {
    expect(teamConfigPath("my-team")).toMatch(/team-config\.yaml$/);
  });
});

// ---------------------------------------------------------------------------
// teamExists
// ---------------------------------------------------------------------------

describe("teamExists", () => {
  it("returns false when the team directory does not exist", () => {
    expect(teamExists("nonexistent")).toBe(false);
  });

  it("returns true after the team directory is created", async () => {
    await mkdir(teamDir("existing-team"), { recursive: true });
    expect(teamExists("existing-team")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ensureTeamsRoot
// ---------------------------------------------------------------------------

describe("ensureTeamsRoot", () => {
  it("creates the teams root and prompt-templates dir if absent", async () => {
    await rm(TEST_ROOT, { recursive: true, force: true });
    await ensureTeamsRoot();
    expect(existsSync(teamsRootDir())).toBe(true);
    expect(existsSync(sharedPromptTemplatesDir())).toBe(true);
  });

  it("is idempotent", async () => {
    await ensureTeamsRoot();
    await ensureTeamsRoot();
    expect(existsSync(teamsRootDir())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createTeamDir
// ---------------------------------------------------------------------------

describe("createTeamDir", () => {
  it("creates the team directory", async () => {
    await createTeamDir("alpha");
    expect(existsSync(teamDir("alpha"))).toBe(true);
  });

  it("throws TeamAlreadyExistsError when the directory already exists", async () => {
    await mkdir(teamDir("duplicate"), { recursive: true });
    await expect(createTeamDir("duplicate")).rejects.toBeInstanceOf(
      TeamAlreadyExistsError,
    );
  });

  it("TeamAlreadyExistsError carries the team name", async () => {
    await mkdir(teamDir("named-team"), { recursive: true });
    const err = await createTeamDir("named-team").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TeamAlreadyExistsError);
    expect((err as TeamAlreadyExistsError).teamName).toBe("named-team");
  });
});

// ---------------------------------------------------------------------------
// writeTeamSnapshot / readTeamSnapshot
// ---------------------------------------------------------------------------

describe("writeTeamSnapshot / readTeamSnapshot", () => {
  it("round-trips a snapshot correctly", async () => {
    await mkdir(teamDir("snap-team"), { recursive: true });
    const original = makeSnapshot({ name: "snap-team" });
    await writeTeamSnapshot(original);
    const loaded = await readTeamSnapshot("snap-team");
    expect(loaded).toEqual(original);
  });

  it("persists the YAML file at the expected path", async () => {
    await mkdir(teamDir("yaml-team"), { recursive: true });
    await writeTeamSnapshot(makeSnapshot({ name: "yaml-team" }));
    expect(existsSync(teamConfigPath("yaml-team"))).toBe(true);
  });

  it("written YAML is human-readable (contains key names)", async () => {
    await mkdir(teamDir("readable-team"), { recursive: true });
    await writeTeamSnapshot(makeSnapshot({ name: "readable-team" }));
    const raw = await readFile(teamConfigPath("readable-team"), "utf8");
    expect(raw).toContain("workspacePath");
    expect(raw).toContain("model");
  });

  it("readTeamSnapshot throws when the file does not exist", async () => {
    await expect(readTeamSnapshot("missing-team")).rejects.toThrow();
  });

  it("readTeamSnapshot throws when required fields are absent", async () => {
    await mkdir(teamDir("bad-team"), { recursive: true });
    await writeFile(teamConfigPath("bad-team"), "name: bad-team\n", "utf8");
    await expect(readTeamSnapshot("bad-team")).rejects.toThrow(
      "missing required fields",
    );
  });

  it("preserves optional configSourcePath when present", async () => {
    await mkdir(teamDir("src-team"), { recursive: true });
    const snap = makeSnapshot({
      name: "src-team",
      configSourcePath: "/path/to/config.yaml",
    });
    await writeTeamSnapshot(snap);
    const loaded = await readTeamSnapshot("src-team");
    expect(loaded.configSourcePath).toBe("/path/to/config.yaml");
  });

  it("omits configSourcePath when not provided", async () => {
    await mkdir(teamDir("no-src-team"), { recursive: true });
    const { configSourcePath: _omit, ...snap } = makeSnapshot({
      name: "no-src-team",
    });
    await writeTeamSnapshot(snap);
    const loaded = await readTeamSnapshot("no-src-team");
    expect(loaded.configSourcePath).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// copyBundledPromptTemplates
// ---------------------------------------------------------------------------

describe("copyBundledPromptTemplates", () => {
  it("copies template files to the shared prompt-templates dir", async () => {
    await ensureTeamsRoot();
    await copyBundledPromptTemplates(EXTENSION_SRC);
    expect(existsSync(join(sharedPromptTemplatesDir(), "code-prompt.md"))).toBe(
      true,
    );
  });

  it("copies all five bundled templates", async () => {
    await ensureTeamsRoot();
    await copyBundledPromptTemplates(EXTENSION_SRC);
    const dir = sharedPromptTemplatesDir();
    for (const name of [
      "code-prompt.md",
      "simplify-prompt.md",
      "review-prompt.md",
      "test-prompt.md",
      "commit-prompt.md",
    ]) {
      expect(existsSync(join(dir, name)), `${name} should exist`).toBe(true);
    }
  });

  it("does not overwrite existing customised templates", async () => {
    await ensureTeamsRoot();
    const destPath = join(sharedPromptTemplatesDir(), "code-prompt.md");
    await writeFile(destPath, "# Custom prompt\n", "utf8");
    await copyBundledPromptTemplates(EXTENSION_SRC);
    const content = await readFile(destPath, "utf8");
    expect(content).toBe("# Custom prompt\n");
  });
});

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getModels } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preflightCreateTeam } from "../leader/create-team.ts";
import { teamDir } from "../storage/team-home.ts";
import type { CommandRunner as BeadsCommandRunner } from "../tasks/beads.ts";

const TEST_ROOT = join(tmpdir(), "pi-teams-preflight-create-test-tmp");
const EXTENSION_SRC = resolve(__dirname, "..");

const SUCCESSFUL_BEADS_RUNNER: BeadsCommandRunner = async () => ({
  stdout: "[]",
  stderr: "",
});

beforeEach(async () => {
  process.env.PI_TEAMS_ROOT = TEST_ROOT;
  await mkdir(TEST_ROOT, { recursive: true });
});

afterEach(async () => {
  delete process.env.PI_TEAMS_ROOT;
  await rm(TEST_ROOT, { recursive: true, force: true });
});

function requireModel(provider: "anthropic" | "openai") {
  const [model] = getModels(provider);
  if (model === undefined) {
    throw new Error(`Expected at least one ${provider} model in test runtime`);
  }
  return model;
}

const LEADER_MODEL = requireModel("anthropic");
const AGENT_MODEL = requireModel("openai");
const AVAILABLE_MODELS = [LEADER_MODEL, AGENT_MODEL];

function makeConfig() {
  return {
    agents: [
      {
        nameTemplate: "code",
        type: "code",
        tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
        model: `${AGENT_MODEL.provider}/${AGENT_MODEL.id}`,
        thinking: "medium",
        promptTemplate: "code-prompt.md",
      },
    ],
  };
}

async function createGitRepo(name: string): Promise<string> {
  const repoDir = join(TEST_ROOT, name);
  await mkdir(repoDir, { recursive: true });

  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
  } catch {
    execFileSync("git", ["init"], { cwd: repoDir });
    execFileSync("git", ["checkout", "-b", "main"], { cwd: repoDir });
  }

  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repoDir,
  });
  execFileSync("git", ["config", "user.name", "Pi Agents Test"], {
    cwd: repoDir,
  });
  await writeFile(join(repoDir, "README.md"), "# test\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });

  return repoDir;
}

function baseParams(workspacePath: string, worktreeDir: string) {
  return {
    name: "alpha-team",
    workspacePath,
    worktreeDir,
    model: `${LEADER_MODEL.provider}/${LEADER_MODEL.id}`,
    thinkingLevel: "medium",
    config: makeConfig(),
    extensionSourceDir: EXTENSION_SRC,
    availableModels: AVAILABLE_MODELS,
    beadsRunner: SUCCESSFUL_BEADS_RUNNER,
  };
}

describe("preflightCreateTeam", () => {
  it("validates a correct create request before startup", async () => {
    const repoDir = await createGitRepo("repo-success");
    const worktreeDir = join(TEST_ROOT, "worktrees-success");

    const result = await preflightCreateTeam(baseParams(repoDir, worktreeDir));

    expect(result.workspaceRealpath).toBe(await realpath(repoDir));
    expect(result.worktreeDir).toBe(worktreeDir);
    expect(existsSync(worktreeDir)).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.config.agents[0]?.promptTemplate).toBe("code-prompt.md");
  });

  it("returns a warning when a code agent omits tools and would inherit full leader access", async () => {
    const repoDir = await createGitRepo("repo-warning-missing-tools");
    const worktreeDir = join(TEST_ROOT, "worktrees-warning-missing-tools");

    const result = await preflightCreateTeam({
      ...baseParams(repoDir, worktreeDir),
      config: {
        agents: [
          {
            nameTemplate: "code",
            type: "code",
            model: `${AGENT_MODEL.provider}/${AGENT_MODEL.id}`,
            thinking: "medium",
            promptTemplate: "code-prompt.md",
          },
        ],
      },
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/full leader access/);
  });

  it("fails when the team name already exists", async () => {
    const repoDir = await createGitRepo("repo-existing-team");
    const worktreeDir = join(TEST_ROOT, "worktrees-existing-team");
    await mkdir(teamDir("alpha-team"), { recursive: true });

    await expect(
      preflightCreateTeam(baseParams(repoDir, worktreeDir)),
    ).rejects.toMatchObject({
      name: "TeamStartupPreflightError",
      code: "team-exists",
    });
  });

  it("rejects invalid team names before touching the filesystem", async () => {
    const repoDir = await createGitRepo("repo-invalid-team-name");
    const worktreeDir = join(TEST_ROOT, "worktrees-invalid-team-name");

    await expect(
      preflightCreateTeam({
        ...baseParams(repoDir, worktreeDir),
        name: "../../tmp/pwn",
      }),
    ).rejects.toMatchObject({
      name: "TeamStartupPreflightError",
      code: "invalid-team-name",
    });
    expect(existsSync(teamDir("alpha-team"))).toBe(false);
  });

  it("fails before creating the worktree directory when the workspace is not a git repo", async () => {
    const workspaceDir = join(TEST_ROOT, "not-a-repo");
    const worktreeDir = join(TEST_ROOT, "worktrees-not-a-repo");
    await mkdir(workspaceDir, { recursive: true });

    await expect(
      preflightCreateTeam(baseParams(workspaceDir, worktreeDir)),
    ).rejects.toMatchObject({
      name: "TeamPreflightError",
      code: "workspace-not-git",
    });
    expect(existsSync(worktreeDir)).toBe(false);
  });

  it("rejects an invalid leader model", async () => {
    const repoDir = await createGitRepo("repo-invalid-model");
    const worktreeDir = join(TEST_ROOT, "worktrees-invalid-model");

    await expect(
      preflightCreateTeam({
        ...baseParams(repoDir, worktreeDir),
        model: "missing/provider-model",
      }),
    ).rejects.toThrow('Leader model "missing/provider-model" is not available');
  });

  it("rejects an invalid agent thinking level", async () => {
    const repoDir = await createGitRepo("repo-invalid-thinking");
    const worktreeDir = join(TEST_ROOT, "worktrees-invalid-thinking");

    await expect(
      preflightCreateTeam({
        ...baseParams(repoDir, worktreeDir),
        config: {
          agents: [
            {
              nameTemplate: "code",
              type: "code",
              tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
              thinking: "max",
              promptTemplate: "code-prompt.md",
            },
          ],
        },
      }),
    ).rejects.toThrow('Agent "code-1" thinking level "max" is invalid');
  });

  it("fails when beads is unavailable in the workspace", async () => {
    const repoDir = await createGitRepo("repo-beads-missing");
    const worktreeDir = join(TEST_ROOT, "worktrees-beads-missing");
    const failingBeadsRunner: BeadsCommandRunner = async () => {
      throw new Error("not found");
    };

    await expect(
      preflightCreateTeam({
        ...baseParams(repoDir, worktreeDir),
        beadsRunner: failingBeadsRunner,
      }),
    ).rejects.toThrow("Beads is not available or not initialized");
  });

  it("rejects missing prompt templates during create preflight", async () => {
    const repoDir = await createGitRepo("repo-missing-template");
    const worktreeDir = join(TEST_ROOT, "worktrees-missing-template");

    await expect(
      preflightCreateTeam({
        ...baseParams(repoDir, worktreeDir),
        config: {
          agents: [
            {
              nameTemplate: "code",
              type: "code",
              tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
              promptTemplate: "missing-template.md",
            },
          ],
        },
      }),
    ).rejects.toThrow("missing-template.md");
  });
});

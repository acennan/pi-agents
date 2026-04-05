import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getModels } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TeamPreflightError } from "../git/worktree.ts";
import { createTeam } from "../leader/create-team.ts";
import { preflightRestartTeam } from "../leader/restart-team.ts";
import {
  createTeamDir,
  type TeamSnapshot,
  writeTeamSnapshot,
} from "../storage/team-home.ts";
import type { CommandRunner as BeadsCommandRunner } from "../tasks/beads.ts";

const TEST_ROOT = join(tmpdir(), "pi-teams-restart-test-tmp");
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

function validConfig() {
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

async function createSnapshotTeam(teamName: string, repoDir: string) {
  return createTeam({
    name: teamName,
    workspacePath: repoDir,
    worktreeDir: join(TEST_ROOT, `${teamName}-worktrees`),
    model: `${LEADER_MODEL.provider}/${LEADER_MODEL.id}`,
    thinkingLevel: "medium",
    config: validConfig(),
    extensionSourceDir: EXTENSION_SRC,
  });
}

describe("preflightRestartTeam", () => {
  it("rejects restart from a different workspace realpath", async () => {
    const repoDir = await createGitRepo("repo-restart-mismatch");
    const otherRepoDir = await createGitRepo("repo-restart-other");
    await createSnapshotTeam("restart-mismatch", repoDir);

    await expect(
      preflightRestartTeam({
        teamName: "restart-mismatch",
        currentWorkspacePath: otherRepoDir,
        availableModels: AVAILABLE_MODELS,
        beadsRunner: SUCCESSFUL_BEADS_RUNNER,
      }),
    ).rejects.toBeInstanceOf(TeamPreflightError);
    await expect(
      preflightRestartTeam({
        teamName: "restart-mismatch",
        currentWorkspacePath: otherRepoDir,
        availableModels: AVAILABLE_MODELS,
        beadsRunner: SUCCESSFUL_BEADS_RUNNER,
      }),
    ).rejects.toThrow("does not match the stored team workspace");
  });

  it("accepts restart when the current workspace is a symlink to the stored repo", async () => {
    const repoDir = await createGitRepo("repo-restart-symlink");
    const snapshot = await createSnapshotTeam("restart-symlink", repoDir);
    const symlinkPath = join(TEST_ROOT, "repo-restart-symlink-link");
    await symlink(repoDir, symlinkPath);

    const result = await preflightRestartTeam({
      teamName: snapshot.name,
      currentWorkspacePath: symlinkPath,
      availableModels: AVAILABLE_MODELS,
      beadsRunner: SUCCESSFUL_BEADS_RUNNER,
    });

    expect(result.workspaceRealpath).toBe(await realpath(repoDir));
    expect(result.worktreeDir).toBe(snapshot.worktreeDir);
    expect(existsSync(snapshot.worktreeDir)).toBe(true);
  });

  it("rejects restart when the stored snapshot references a missing prompt template", async () => {
    const repoDir = await createGitRepo("repo-restart-missing-template");
    const snapshot: TeamSnapshot = {
      name: "restart-missing-template",
      workspacePath: repoDir,
      worktreeDir: join(TEST_ROOT, "restart-missing-template-worktrees"),
      model: `${LEADER_MODEL.provider}/${LEADER_MODEL.id}`,
      thinkingLevel: "medium",
      createdAt: "2026-01-01T00:00:00.000Z",
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
    };

    await createTeamDir(snapshot.name);
    await writeTeamSnapshot(snapshot);

    await expect(
      preflightRestartTeam({
        teamName: snapshot.name,
        currentWorkspacePath: repoDir,
        availableModels: AVAILABLE_MODELS,
        beadsRunner: SUCCESSFUL_BEADS_RUNNER,
      }),
    ).rejects.toThrow("missing-template.md");
  });
});

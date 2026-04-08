import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandRunner } from "../git/worktree.ts";
import {
  createTaskWorktreeFromMain,
  ensureTaskWorktree,
  type TeamWorktreeError,
} from "../git/worktree.ts";

const TEST_ROOT = join(tmpdir(), "pi-teams-worktree-test-tmp");
const WORKSPACE_PATH = join(TEST_ROOT, "workspace");

afterEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  await mkdir(WORKSPACE_PATH, { recursive: true });
});

describe("createTaskWorktreeFromMain", () => {
  it("does not treat unrelated git 'already exists' errors as worktree conflicts", async () => {
    const worktreePath = join(TEST_ROOT, "worktrees", "task-pi-agents-0");
    const runner: CommandRunner = async () => {
      throw new Error("fatal: object already exists in database");
    };

    await expect(
      createTaskWorktreeFromMain({
        workspacePath: WORKSPACE_PATH,
        worktreePath,
        branchName: "task-pi-agents-0",
        runner,
      }),
    ).rejects.toMatchObject({
      name: "TeamWorktreeError",
      code: "worktree-create-failed",
    } satisfies Partial<TeamWorktreeError>);
  });
});

describe("ensureTaskWorktree", () => {
  it("verifies the current branch when the worktree directory already exists", async () => {
    const worktreePath = join(TEST_ROOT, "worktrees", "task-pi-agents-1");
    await mkdir(worktreePath, { recursive: true });

    const calls: string[][] = [];
    const runner: CommandRunner = async (_command, args) => {
      calls.push([...args]);

      switch (args.join(" ")) {
        case "rev-parse --abbrev-ref HEAD":
          return { stdout: "task-pi-agents-1\n", stderr: "" };
        default:
          throw new Error(`Unexpected command: ${args.join(" ")}`);
      }
    };

    const result = await ensureTaskWorktree({
      workspacePath: WORKSPACE_PATH,
      worktreePath,
      branchName: "task-pi-agents-1",
      runner,
    });

    expect(result).toEqual({
      worktreePath,
      branchName: "task-pi-agents-1",
      created: false,
    });
    expect(calls).toEqual([["rev-parse", "--abbrev-ref", "HEAD"]]);
  });

  it("prunes stale git worktree registrations before retrying a restore", async () => {
    const worktreePath = join(TEST_ROOT, "worktrees", "task-pi-agents-2");
    const calls: string[][] = [];
    let addAttempts = 0;

    const runner: CommandRunner = async (_command, args) => {
      calls.push([...args]);

      switch (args.join(" ")) {
        case `worktree add ${worktreePath} task-pi-agents-2`:
          addAttempts += 1;
          if (addAttempts === 1) {
            throw new Error("fatal: 'task-pi-agents-2' is already checked out");
          }
          return { stdout: "", stderr: "" };
        case "worktree prune":
          return { stdout: "", stderr: "" };
        default:
          throw new Error(`Unexpected command: ${args.join(" ")}`);
      }
    };

    const result = await ensureTaskWorktree({
      workspacePath: WORKSPACE_PATH,
      worktreePath,
      branchName: "task-pi-agents-2",
      runner,
    });

    expect(result).toEqual({
      worktreePath,
      branchName: "task-pi-agents-2",
      created: true,
    });
    expect(calls).toEqual([
      ["worktree", "add", worktreePath, "task-pi-agents-2"],
      ["worktree", "prune"],
      ["worktree", "add", worktreePath, "task-pi-agents-2"],
    ]);
  });
});

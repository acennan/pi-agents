import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimCodeAgentTask } from "../agents/code-agent.ts";
import type { CommandRunner } from "../tasks/beads.ts";
import {
  initializeTaskLineage,
  lineageBranchName,
  lineageWorktreePath,
  registerRemedialTaskLineage,
} from "../tasks/lineage.ts";

const TEST_ROOT = join(tmpdir(), "pi-teams-code-agent-test-tmp");
const TEAM_NAME = "code-agent-team";
const WORKSPACE_PATH = "/tmp/workspace";
const WORKTREE_DIR = join(TEST_ROOT, "worktrees");

afterEach(async () => {
  delete process.env.PI_TEAMS_ROOT;
  await rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  process.env.PI_TEAMS_ROOT = TEST_ROOT;
  await mkdir(WORKTREE_DIR, { recursive: true });
});

describe("claimCodeAgentTask", () => {
  it("claims a fresh task, creates its task worktree from main, and stores lineage state", async () => {
    const calls: string[][] = [];
    const expectedWorktreePath = lineageWorktreePath(
      WORKTREE_DIR,
      "pi-agents-1",
    );
    const runner: CommandRunner = async (_command, args) => {
      calls.push([...args]);

      switch (args.join(" ")) {
        case "ready --json":
          return {
            stdout: JSON.stringify([
              {
                id: "pi-agents-1",
                title: "Task 1",
                status: "open",
                priority: 1,
                labels: [],
                dependencies: [],
              },
            ]),
            stderr: "",
          };
        case "blocked --json":
          return { stdout: "[]", stderr: "" };
        case "update --actor code-1 pi-agents-1 --claim --json":
          return {
            stdout: JSON.stringify([
              {
                id: "pi-agents-1",
                title: "Task 1",
                status: "in_progress",
                priority: 1,
                labels: [],
                dependencies: [],
              },
            ]),
            stderr: "",
          };
        case `worktree add -b task-pi-agents-1 ${expectedWorktreePath} main`:
          return { stdout: "", stderr: "" };
        default:
          throw new Error(`Unexpected command: ${args.join(" ")}`);
      }
    };

    const result = await claimCodeAgentTask({
      teamName: TEAM_NAME,
      workspacePath: WORKSPACE_PATH,
      worktreeDir: WORKTREE_DIR,
      agentName: "code-1",
      runner,
    });

    expect(result.task?.id).toBe("pi-agents-1");
    if (result.task === undefined) {
      throw new Error("Expected a claimed task");
    }

    expect(result.branchName).toBe("task-pi-agents-1");
    expect(result.worktreePath).toBe(expectedWorktreePath);
    expect(result.createdLineage).toBe(true);
    expect(result.createdWorktree).toBe(true);
    expect(result.lineage).toEqual({
      rootTaskId: "pi-agents-1",
      taskIds: ["pi-agents-1"],
      worktreePath: expectedWorktreePath,
      branchName: "task-pi-agents-1",
      reviewCycleCount: 0,
    });
    expect(calls).toEqual([
      ["ready", "--json"],
      ["blocked", "--json"],
      ["update", "--actor", "code-1", "pi-agents-1", "--claim", "--json"],
      [
        "worktree",
        "add",
        "-b",
        "task-pi-agents-1",
        expectedWorktreePath,
        "main",
      ],
    ]);
  });

  it("prefers BR_ACTOR and reuses the stored lineage worktree for remedial tasks", async () => {
    const rootTaskId = "pi-agents-2";
    const remedialTaskId = "pi-agents-2.1";
    const worktreePath = lineageWorktreePath(WORKTREE_DIR, rootTaskId);
    await initializeTaskLineage({
      teamName: TEAM_NAME,
      taskId: rootTaskId,
      worktreePath,
      branchName: lineageBranchName(rootTaskId),
      reviewCycleCount: 1,
    });
    await registerRemedialTaskLineage(TEAM_NAME, rootTaskId, remedialTaskId);
    await mkdir(worktreePath, { recursive: true });

    const calls: string[][] = [];
    const runner: CommandRunner = async (_command, args) => {
      calls.push([...args]);

      switch (args.join(" ")) {
        case "ready --json":
          return {
            stdout: JSON.stringify([
              {
                id: remedialTaskId,
                title: "Task 2 follow-up",
                status: "open",
                priority: 1,
                parent: rootTaskId,
                labels: [],
                dependencies: [
                  {
                    id: rootTaskId,
                    dependency_type: "parent-child",
                  },
                ],
              },
            ]),
            stderr: "",
          };
        case "blocked --json":
          return { stdout: "[]", stderr: "" };
        case `update --actor team-bot ${remedialTaskId} --claim --json`:
          return {
            stdout: JSON.stringify([
              {
                id: remedialTaskId,
                title: "Task 2 follow-up",
                status: "in_progress",
                priority: 1,
                parent: rootTaskId,
                labels: [],
                dependencies: [
                  {
                    id: rootTaskId,
                    dependency_type: "parent-child",
                  },
                ],
              },
            ]),
            stderr: "",
          };
        case "rev-parse --abbrev-ref HEAD":
          return { stdout: `${lineageBranchName(rootTaskId)}\n`, stderr: "" };
        default:
          throw new Error(`Unexpected command: ${args.join(" ")}`);
      }
    };

    const result = await claimCodeAgentTask({
      teamName: TEAM_NAME,
      workspacePath: WORKSPACE_PATH,
      worktreeDir: WORKTREE_DIR,
      agentName: "code-2",
      runner,
      env: {
        BR_ACTOR: "team-bot",
      },
    });

    expect(result.task?.id).toBe(remedialTaskId);
    if (result.task === undefined) {
      throw new Error("Expected a claimed task");
    }

    expect(result.branchName).toBe(lineageBranchName(rootTaskId));
    expect(result.worktreePath).toBe(worktreePath);
    expect(result.createdLineage).toBe(false);
    expect(result.createdWorktree).toBe(false);
    expect(result.lineage).toEqual({
      rootTaskId,
      taskIds: [rootTaskId, remedialTaskId],
      worktreePath,
      branchName: lineageBranchName(rootTaskId),
      reviewCycleCount: 1,
    });
    expect(calls.at(-1)).toEqual(["rev-parse", "--abbrev-ref", "HEAD"]);
  });
});

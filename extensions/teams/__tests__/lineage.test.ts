import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandRunner } from "../tasks/beads.ts";
import {
  createRemedialTaskLineage,
  getDiscoveredFromTaskId,
  getTaskLineage,
  incrementTaskLineageReviewCycle,
  initializeTaskLineage,
  isRemedialBeadsTask,
  lineageBranchName,
  lineageWorktreePath,
  prepareClaimedTaskLineage,
  type TeamLineageError,
} from "../tasks/lineage.ts";
import {
  getLineageRecordForTask,
  LineageStateError,
  lineageStatePath,
} from "../tasks/lineage-state.ts";

const TEST_ROOT = join(tmpdir(), "pi-teams-lineage-test-tmp");
const TEAM_NAME = "lineage-team";
const WORKSPACE_PATH = join(TEST_ROOT, "workspace");
const WORKTREE_ROOT = join(TEST_ROOT, "worktrees");

afterEach(async () => {
  delete process.env.PI_TEAMS_ROOT;
  await rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  process.env.PI_TEAMS_ROOT = TEST_ROOT;
  await mkdir(TEST_ROOT, { recursive: true });
  await mkdir(WORKSPACE_PATH, { recursive: true });
  await mkdir(WORKTREE_ROOT, { recursive: true });
});

describe("initializeTaskLineage/getTaskLineage", () => {
  it("stores root task lineage in team-owned state", async () => {
    const lineage = await initializeTaskLineage({
      teamName: TEAM_NAME,
      taskId: "pi-agents-101",
      worktreePath: "relative/worktrees/task-pi-agents-101",
      branchName: lineageBranchName("pi-agents-101"),
    });

    expect(lineage).toEqual({
      rootTaskId: "pi-agents-101",
      taskIds: ["pi-agents-101"],
      worktreePath: lineageWorktreePath("relative/worktrees", "pi-agents-101"),
      branchName: "task-pi-agents-101",
      reviewCycleCount: 0,
    });
    await expect(getTaskLineage(TEAM_NAME, "pi-agents-101")).resolves.toEqual(
      lineage,
    );
  });

  it("rejects invalid stored lineage state when root task id is missing from taskIds", async () => {
    await initializeTaskLineage({
      teamName: TEAM_NAME,
      taskId: "pi-agents-seed",
      worktreePath: join(WORKTREE_ROOT, "task-pi-agents-seed"),
      branchName: "task-pi-agents-seed",
    });

    await writeFile(
      lineageStatePath(TEAM_NAME),
      JSON.stringify({
        version: 1,
        lineages: [
          {
            rootTaskId: "pi-agents-bad-root",
            taskIds: ["pi-agents-other"],
            worktreePath: join(WORKTREE_ROOT, "task-pi-agents-bad-root"),
            branchName: "task-pi-agents-bad-root",
            reviewCycleCount: 0,
          },
        ],
      }),
      "utf8",
    );

    await expect(
      getLineageRecordForTask(TEAM_NAME, "pi-agents-other"),
    ).rejects.toBeInstanceOf(LineageStateError);
    await expect(
      getLineageRecordForTask(TEAM_NAME, "pi-agents-other"),
    ).rejects.toThrow(
      "Expected " +
        lineageStatePath(TEAM_NAME) +
        '.lineages[0].taskIds to include root task id "pi-agents-bad-root"',
    );
  });
});

describe("prepareClaimedTaskLineage", () => {
  it("restores a missing worktree for an existing lineage so retries and restarts stay on the same branch", async () => {
    const rootTaskId = "pi-agents-150";
    const branchName = lineageBranchName(rootTaskId);
    const worktreePath = lineageWorktreePath(WORKTREE_ROOT, rootTaskId);
    await initializeTaskLineage({
      teamName: TEAM_NAME,
      taskId: rootTaskId,
      worktreePath,
      branchName,
      reviewCycleCount: 2,
    });

    const calls: string[][] = [];
    const runner: CommandRunner = async (_command, args) => {
      calls.push([...args]);

      switch (args.join(" ")) {
        case `worktree add ${worktreePath} ${branchName}`:
          return { stdout: "", stderr: "" };
        default:
          throw new Error(`Unexpected command: ${args.join(" ")}`);
      }
    };

    const result = await prepareClaimedTaskLineage({
      teamName: TEAM_NAME,
      workspacePath: WORKSPACE_PATH,
      worktreeDir: WORKTREE_ROOT,
      task: {
        id: rootTaskId,
        title: "Original task",
        status: "in_progress",
        priority: 1,
        labels: [],
        dependencies: [],
      },
      runner,
    });

    expect(result).toEqual({
      lineage: {
        rootTaskId,
        taskIds: [rootTaskId],
        worktreePath,
        branchName,
        reviewCycleCount: 2,
      },
      worktreePath,
      branchName,
      createdLineage: false,
      createdWorktree: true,
    });
    expect(calls).toEqual([["worktree", "add", worktreePath, branchName]]);
  });

  it("verifies an existing worktree already points at the stored lineage branch", async () => {
    const rootTaskId = "pi-agents-151";
    const branchName = lineageBranchName(rootTaskId);
    const worktreePath = lineageWorktreePath(WORKTREE_ROOT, rootTaskId);
    await initializeTaskLineage({
      teamName: TEAM_NAME,
      taskId: rootTaskId,
      worktreePath,
      branchName,
      reviewCycleCount: 1,
    });
    await mkdir(worktreePath, { recursive: true });

    const calls: string[][] = [];
    const runner: CommandRunner = async (_command, args) => {
      calls.push([...args]);

      switch (args.join(" ")) {
        case "rev-parse --abbrev-ref HEAD":
          return { stdout: `${branchName}\n`, stderr: "" };
        default:
          throw new Error(`Unexpected command: ${args.join(" ")}`);
      }
    };

    const result = await prepareClaimedTaskLineage({
      teamName: TEAM_NAME,
      workspacePath: WORKSPACE_PATH,
      worktreeDir: WORKTREE_ROOT,
      task: {
        id: rootTaskId,
        title: "Existing task",
        status: "in_progress",
        priority: 1,
        labels: [],
        dependencies: [],
      },
      runner,
    });

    expect(result.createdLineage).toBe(false);
    expect(result.createdWorktree).toBe(false);
    expect(result.worktreePath).toBe(worktreePath);
    expect(calls).toEqual([["rev-parse", "--abbrev-ref", "HEAD"]]);
  });

  it("recovers a fresh-task retry by reusing the previously created branch/worktree and writing lineage state", async () => {
    const rootTaskId = "pi-agents-151-retry";
    const branchName = lineageBranchName(rootTaskId);
    const worktreePath = lineageWorktreePath(WORKTREE_ROOT, rootTaskId);

    const calls: string[][] = [];
    const runner: CommandRunner = async (_command, args) => {
      calls.push([...args]);

      switch (args.join(" ")) {
        case `worktree add -b ${branchName} ${worktreePath} main`:
          throw new Error(
            `fatal: a branch named '${branchName}' already exists`,
          );
        case `worktree add ${worktreePath} ${branchName}`:
          return { stdout: "", stderr: "" };
        default:
          throw new Error(`Unexpected command: ${args.join(" ")}`);
      }
    };

    const result = await prepareClaimedTaskLineage({
      teamName: TEAM_NAME,
      workspacePath: WORKSPACE_PATH,
      worktreeDir: WORKTREE_ROOT,
      task: {
        id: rootTaskId,
        title: "Retried task",
        status: "in_progress",
        priority: 1,
        labels: [],
        dependencies: [],
      },
      runner,
    });

    expect(result).toEqual({
      lineage: {
        rootTaskId,
        taskIds: [rootTaskId],
        worktreePath,
        branchName,
        reviewCycleCount: 0,
      },
      worktreePath,
      branchName,
      createdLineage: true,
      createdWorktree: false,
    });
    await expect(getTaskLineage(TEAM_NAME, rootTaskId)).resolves.toEqual(
      result.lineage,
    );
    expect(calls).toEqual([
      ["worktree", "add", "-b", branchName, worktreePath, "main"],
      ["worktree", "add", worktreePath, branchName],
    ]);
  });

  it("rejects remedial tasks when lineage state is missing", async () => {
    await expect(
      prepareClaimedTaskLineage({
        teamName: TEAM_NAME,
        workspacePath: WORKSPACE_PATH,
        worktreeDir: WORKTREE_ROOT,
        task: {
          id: "pi-agents-151.1",
          title: "Fix follow-up",
          status: "in_progress",
          priority: 2,
          parentTaskId: "pi-agents-151",
          labels: [],
          dependencies: [
            {
              id: "pi-agents-151",
              dependencyType: "parent-child",
            },
          ],
        },
      }),
    ).rejects.toMatchObject({
      name: "TeamLineageError",
      code: "missing-lineage",
    } satisfies Partial<TeamLineageError>);
  });
});

describe("createRemedialTaskLineage", () => {
  it("creates remedial beads linkage and reuses existing lineage state", async () => {
    const rootLineage = await initializeTaskLineage({
      teamName: TEAM_NAME,
      taskId: "pi-agents-200",
      worktreePath: join(WORKTREE_ROOT, "task-pi-agents-200"),
      branchName: lineageBranchName("pi-agents-200"),
      reviewCycleCount: 1,
    });

    const calls: string[][] = [];
    const runner: CommandRunner = async (_command, args) => {
      calls.push([...args]);

      switch (args.join(" ")) {
        case "create --actor leader Fix follow-up for pi-agents-200 --priority 2 --type task --parent pi-agents-200 --description Address review findings --json":
          return {
            stdout: JSON.stringify({
              id: "pi-agents-200.1",
              title: "Fix follow-up for pi-agents-200",
              status: "open",
              priority: 2,
              description: "Address review findings",
              issue_type: "task",
              labels: [],
              dependencies: [
                {
                  issue_id: "pi-agents-200.1",
                  depends_on_id: "pi-agents-200",
                  type: "parent-child",
                },
              ],
            }),
            stderr: "",
          };
        case "show pi-agents-200.1 --json":
          return {
            stdout: JSON.stringify([
              {
                id: "pi-agents-200.1",
                title: "Fix follow-up for pi-agents-200",
                status: "open",
                priority: 2,
                description: "Address review findings",
                issue_type: "task",
                labels: [],
                parent: "pi-agents-200",
                dependencies: [
                  {
                    id: "pi-agents-200",
                    title: "Original task",
                    status: "closed",
                    priority: 2,
                    dependency_type: "parent-child",
                  },
                ],
              },
            ]),
            stderr: "",
          };
        default:
          throw new Error(`Unexpected command: ${args.join(" ")}`);
      }
    };

    const result = await createRemedialTaskLineage({
      teamName: TEAM_NAME,
      workspacePath: WORKSPACE_PATH,
      originalTaskId: "pi-agents-200",
      title: "Fix follow-up for pi-agents-200",
      description: "Address review findings",
      priority: 2,
      issueType: "task",
      actor: "leader",
      runner,
    });

    expect(result.task.id).toBe("pi-agents-200.1");
    expect(result.lineage).toEqual({
      ...rootLineage,
      taskIds: ["pi-agents-200", "pi-agents-200.1"],
    });
    await expect(getTaskLineage(TEAM_NAME, "pi-agents-200.1")).resolves.toEqual(
      result.lineage,
    );
    expect(calls).toEqual([
      [
        "create",
        "--actor",
        "leader",
        "Fix follow-up for pi-agents-200",
        "--priority",
        "2",
        "--type",
        "task",
        "--parent",
        "pi-agents-200",
        "--description",
        "Address review findings",
        "--json",
      ],
      ["show", "pi-agents-200.1", "--json"],
    ]);
  });

  it("increments review cycle counts at lineage scope", async () => {
    await initializeTaskLineage({
      teamName: TEAM_NAME,
      taskId: "pi-agents-300",
      worktreePath: join(WORKTREE_ROOT, "task-pi-agents-300"),
      branchName: lineageBranchName("pi-agents-300"),
    });

    const runner: CommandRunner = async (_command, args) => {
      switch (args.join(" ")) {
        case "create --actor leader Fix follow-up for pi-agents-300 --parent pi-agents-300 --json":
          return {
            stdout: JSON.stringify({
              id: "pi-agents-300.1",
              title: "Fix follow-up for pi-agents-300",
              status: "open",
              priority: 2,
              labels: [],
              dependencies: [
                {
                  issue_id: "pi-agents-300.1",
                  depends_on_id: "pi-agents-300",
                  type: "parent-child",
                },
              ],
            }),
            stderr: "",
          };
        case "show pi-agents-300.1 --json":
          return {
            stdout: JSON.stringify([
              {
                id: "pi-agents-300.1",
                title: "Fix follow-up for pi-agents-300",
                status: "open",
                priority: 2,
                labels: [],
                parent: "pi-agents-300",
                dependencies: [
                  {
                    id: "pi-agents-300",
                    title: "Original task",
                    status: "closed",
                    priority: 2,
                    dependency_type: "parent-child",
                  },
                ],
              },
            ]),
            stderr: "",
          };
        default:
          throw new Error(`Unexpected command: ${args.join(" ")}`);
      }
    };

    await createRemedialTaskLineage({
      teamName: TEAM_NAME,
      workspacePath: WORKSPACE_PATH,
      originalTaskId: "pi-agents-300",
      title: "Fix follow-up for pi-agents-300",
      actor: "leader",
      runner,
    });

    const lineage = await incrementTaskLineageReviewCycle(
      TEAM_NAME,
      "pi-agents-300.1",
    );

    expect(lineage.reviewCycleCount).toBe(1);
    await expect(getTaskLineage(TEAM_NAME, "pi-agents-300")).resolves.toEqual(
      lineage,
    );
  });

  it("throws typed error when lineage state is missing", async () => {
    await expect(
      createRemedialTaskLineage({
        teamName: TEAM_NAME,
        workspacePath: WORKSPACE_PATH,
        originalTaskId: "pi-agents-missing",
        title: "Fix follow-up for pi-agents-missing",
      }),
    ).rejects.toMatchObject({
      name: "TeamLineageError",
      code: "missing-lineage",
    } satisfies Partial<TeamLineageError>);
  });

  it("detects remedial tasks from parent-child linkage when discovered-from is unavailable", () => {
    const remedialTask = {
      id: "pi-agents-401",
      title: "Fix follow-up for pi-agents-400",
      status: "open",
      priority: 2,
      parentTaskId: "pi-agents-400",
      labels: [],
      dependencies: [
        {
          id: "pi-agents-400",
          dependencyType: "parent-child",
        },
      ],
    };

    expect(getDiscoveredFromTaskId(remedialTask)).toBe("pi-agents-400");
    expect(isRemedialBeadsTask(remedialTask)).toBe(true);
  });
});

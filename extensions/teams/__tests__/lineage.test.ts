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
  type TeamLineageError,
} from "../tasks/lineage.ts";
import {
  getLineageRecordForTask,
  LineageStateError,
  lineageStatePath,
} from "../tasks/lineage-state.ts";

const TEST_ROOT = join(tmpdir(), "pi-teams-lineage-test-tmp");
const TEAM_NAME = "lineage-team";
const WORKSPACE_PATH = "/tmp/team-workspace";

afterEach(async () => {
  delete process.env.PI_TEAMS_ROOT;
  await rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  process.env.PI_TEAMS_ROOT = TEST_ROOT;
  await mkdir(TEST_ROOT, { recursive: true });
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
      worktreePath: "/tmp/worktrees/task-pi-agents-seed",
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
            worktreePath: "/tmp/worktrees/task-pi-agents-bad-root",
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

describe("createRemedialTaskLineage", () => {
  it("creates remedial beads linkage and reuses existing lineage state", async () => {
    const rootLineage = await initializeTaskLineage({
      teamName: TEAM_NAME,
      taskId: "pi-agents-200",
      worktreePath: "/tmp/worktrees/task-pi-agents-200",
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
      worktreePath: "/tmp/worktrees/task-pi-agents-300",
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

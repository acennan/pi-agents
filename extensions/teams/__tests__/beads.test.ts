import { describe, expect, it } from "vitest";
import {
  BEADS_TASK_STATUS_IN_PROGRESS,
  BEADS_TASK_STATUS_OPEN,
  type BeadsTask,
  type CommandRunner,
  claimNextReadyBeadsTask,
  getBeadsTask,
  listClaimableBeadsTasks,
  updateBeadsTask,
} from "../tasks/beads.ts";

const WORKSPACE_PATH = "/tmp/team-workspace";

type RunnerCall = {
  command: string;
  args: string[];
  cwd?: string;
};

function makeTask(
  overrides: Partial<BeadsTask> & Pick<BeadsTask, "id">,
): BeadsTask {
  return {
    id: overrides.id,
    title: overrides.title ?? `Task ${overrides.id}`,
    status: overrides.status ?? BEADS_TASK_STATUS_OPEN,
    priority: overrides.priority ?? 2,
    description: overrides.description,
    issueType: overrides.issueType,
    assignee: overrides.assignee,
    labels: overrides.labels ?? [],
    dependencies: overrides.dependencies ?? [],
  };
}

function jsonResponse(payload: unknown): { stdout: string; stderr: string } {
  return {
    stdout: JSON.stringify(payload),
    stderr: "",
  };
}

describe("listClaimableBeadsTasks", () => {
  it("keeps only ready open tasks that are not dependency-blocked", async () => {
    const calls: RunnerCall[] = [];
    const runner: CommandRunner = async (command, args, options) => {
      calls.push({ command, args: [...args], cwd: options?.cwd });

      switch (args.join(" ")) {
        case "ready --json":
          return jsonResponse([
            makeTask({ id: "pi-agents-1", status: BEADS_TASK_STATUS_OPEN }),
            makeTask({
              id: "pi-agents-2",
              status: BEADS_TASK_STATUS_IN_PROGRESS,
            }),
            makeTask({ id: "pi-agents-3", status: BEADS_TASK_STATUS_OPEN }),
          ]);
        case "blocked --json":
          return jsonResponse([
            makeTask({ id: "pi-agents-3", status: BEADS_TASK_STATUS_OPEN }),
          ]);
        default:
          throw new Error(`Unexpected command: ${args.join(" ")}`);
      }
    };

    const result = await listClaimableBeadsTasks(WORKSPACE_PATH, { runner });

    expect(result.readyTasks.map((task) => task.id)).toEqual([
      "pi-agents-1",
      "pi-agents-2",
      "pi-agents-3",
    ]);
    expect(result.blockedTasks.map((task) => task.id)).toEqual(["pi-agents-3"]);
    expect(result.claimableTasks.map((task) => task.id)).toEqual([
      "pi-agents-1",
    ]);
    expect(calls).toEqual([
      {
        command: "br",
        args: ["ready", "--json"],
        cwd: WORKSPACE_PATH,
      },
      {
        command: "br",
        args: ["blocked", "--json"],
        cwd: WORKSPACE_PATH,
      },
    ]);
  });
});

describe("getBeadsTask/updateBeadsTask", () => {
  it("normalizes show output and preserves dependency metadata", async () => {
    const runner: CommandRunner = async (_command, args) => {
      expect(args).toEqual(["show", "pi-agents-9", "--json"]);
      return jsonResponse([
        {
          ...makeTask({
            id: "pi-agents-9",
            labels: ["teams", "phase-4"],
          }),
          dependencies: [
            {
              id: "pi-agents-8",
              title: "Parent task",
              status: "closed",
              priority: 1,
              dependency_type: "blocks",
            },
          ],
          issue_type: "task",
        },
      ]);
    };

    const task = await getBeadsTask(WORKSPACE_PATH, "pi-agents-9", { runner });

    expect(task).toEqual({
      id: "pi-agents-9",
      title: "Task pi-agents-9",
      status: "open",
      priority: 2,
      description: undefined,
      issueType: "task",
      assignee: undefined,
      labels: ["teams", "phase-4"],
      dependencies: [
        {
          id: "pi-agents-8",
          title: "Parent task",
          status: "closed",
          priority: 1,
          dependencyType: "blocks",
        },
      ],
    });
  });

  it("writes updates with an explicit actor", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = async (_command, args) => {
      calls.push([...args]);
      return jsonResponse([
        makeTask({
          id: "pi-agents-10",
          status: BEADS_TASK_STATUS_IN_PROGRESS,
        }),
      ]);
    };

    const task = await updateBeadsTask(WORKSPACE_PATH, "pi-agents-10", {
      runner,
      env: {
        BR_ACTOR: "team-bot",
      },
      status: BEADS_TASK_STATUS_IN_PROGRESS,
    });

    expect(task.status).toBe(BEADS_TASK_STATUS_IN_PROGRESS);
    expect(calls).toEqual([
      [
        "update",
        "--actor",
        "team-bot",
        "pi-agents-10",
        "--status",
        "in_progress",
        "--json",
      ],
    ]);
  });
});

describe("claimNextReadyBeadsTask", () => {
  it("returns no task when there are no ready open candidates to claim", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = async (_command, args) => {
      calls.push([...args]);
      switch (args.join(" ")) {
        case "ready --json":
          return jsonResponse([
            makeTask({
              id: "pi-agents-1",
              status: BEADS_TASK_STATUS_IN_PROGRESS,
            }),
          ]);
        case "blocked --json":
          return jsonResponse([]);
        default:
          throw new Error(`Unexpected command: ${args.join(" ")}`);
      }
    };

    const result = await claimNextReadyBeadsTask(WORKSPACE_PATH, {
      runner,
      actor: "code-1",
    });

    expect(result.task).toBeUndefined();
    expect(result.attemptedTaskIds).toEqual([]);
    expect(result.lostRaceTaskIds).toEqual([]);
    expect(calls).toEqual([
      ["ready", "--json"],
      ["blocked", "--json"],
    ]);
  });

  it("retries the next candidate after a lost race", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = async (_command, args) => {
      calls.push([...args]);
      switch (args.join(" ")) {
        case "ready --json":
          return jsonResponse([
            makeTask({ id: "pi-agents-1" }),
            makeTask({ id: "pi-agents-2" }),
          ]);
        case "blocked --json":
          return jsonResponse([]);
        case "update --actor code-1 pi-agents-1 --claim --json":
          throw new Error("lost race");
        case "show pi-agents-1 --json":
          return jsonResponse([
            makeTask({
              id: "pi-agents-1",
              status: BEADS_TASK_STATUS_IN_PROGRESS,
            }),
          ]);
        case "update --actor code-1 pi-agents-2 --claim --json":
          return jsonResponse([
            makeTask({
              id: "pi-agents-2",
              status: BEADS_TASK_STATUS_IN_PROGRESS,
            }),
          ]);
        default:
          throw new Error(`Unexpected command: ${args.join(" ")}`);
      }
    };

    const result = await claimNextReadyBeadsTask(WORKSPACE_PATH, {
      runner,
      actor: "code-1",
    });

    expect(result.task?.id).toBe("pi-agents-2");
    expect(result.attemptedTaskIds).toEqual(["pi-agents-1", "pi-agents-2"]);
    expect(result.lostRaceTaskIds).toEqual(["pi-agents-1"]);
    expect(calls).toEqual([
      ["ready", "--json"],
      ["blocked", "--json"],
      ["update", "--actor", "code-1", "pi-agents-1", "--claim", "--json"],
      ["show", "pi-agents-1", "--json"],
      ["update", "--actor", "code-1", "pi-agents-2", "--claim", "--json"],
    ]);
  });

  it("rethrows failures when the task is still open after the failed claim", async () => {
    const runner: CommandRunner = async (_command, args) => {
      switch (args.join(" ")) {
        case "ready --json":
          return jsonResponse([makeTask({ id: "pi-agents-1" })]);
        case "blocked --json":
          return jsonResponse([]);
        case "update --actor code-1 pi-agents-1 --claim --json":
          throw new Error("br unavailable");
        case "show pi-agents-1 --json":
          return jsonResponse([makeTask({ id: "pi-agents-1" })]);
        default:
          throw new Error(`Unexpected command: ${args.join(" ")}`);
      }
    };

    await expect(
      claimNextReadyBeadsTask(WORKSPACE_PATH, {
        runner,
        actor: "code-1",
      }),
    ).rejects.toThrow('Failed to claim beads task "pi-agents-1"');
  });
});

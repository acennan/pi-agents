import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CodeAgentTaskError,
  claimCodeAgentTask,
  codeAgentCompletionSubject,
  completeCodeAgentTask,
  parseCodeAgentCompletionReport,
  resetCodeAgentSession,
} from "../agents/code-agent.ts";
import { leaderInboxPath, readMailboxEntries } from "../agents/mailbox.ts";
import type { CommandRunner } from "../tasks/beads.ts";
import {
  initializeTaskLineage,
  lineageBranchName,
  lineageWorktreePath,
  registerRemedialTaskLineage,
} from "../tasks/lineage.ts";
import { readTaskSummary } from "../tasks/summaries.ts";

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

describe("completeCodeAgentTask", () => {
  it("writes the summary, commits worktree changes, reports touched files, and clears residual session messages", async () => {
    const worktreePath = join(WORKTREE_DIR, "task-pi-agents-7");
    await mkdir(worktreePath, { recursive: true });

    const calls: string[][] = [];
    const runner: CommandRunner = async (_command, args) => {
      calls.push([...args]);

      switch (args.join(" ")) {
        case "add --all":
          return { stdout: "", stderr: "" };
        case "status --porcelain --untracked-files=all":
          return {
            stdout:
              "M  extensions/teams/agents/code-agent.ts\nA  extensions/teams/__tests__/code-agent.test.ts\n",
            stderr: "",
          };
        case "commit -m feat: implement pi-agents-7":
          return { stdout: "[task-pi-agents-7 abc123] done\n", stderr: "" };
        case "rev-parse HEAD":
          return { stdout: "abc123def456\n", stderr: "" };
        case "show --pretty=format: --name-only HEAD":
          return {
            stdout:
              "extensions/teams/agents/code-agent.ts\nextensions/teams/__tests__/code-agent.test.ts\n",
            stderr: "",
          };
        default:
          throw new Error(`Unexpected command: ${args.join(" ")}`);
      }
    };
    const reset = vi.fn(() => {
      // Simulate SDK reset() leaving stale messages behind so the fallback path
      // must clear them before the next task.
    });
    const session = {
      agent: {
        reset,
        state: {
          messages: [{ role: "user", content: "stale" }],
        },
      },
    };

    const result = await completeCodeAgentTask({
      teamName: TEAM_NAME,
      agentName: "code-1",
      taskId: "pi-agents-7",
      branchName: "task-pi-agents-7",
      worktreePath,
      summaryMarkdown: "# Task pi-agents-7 Summary\n\nImplemented the task.",
      session,
      runner,
      now: () => new Date("2026-04-08T20:00:00.000Z"),
    });

    expect(calls).toEqual([
      ["add", "--all"],
      ["status", "--porcelain", "--untracked-files=all"],
      ["commit", "-m", "feat: implement pi-agents-7"],
      ["rev-parse", "HEAD"],
      ["show", "--pretty=format:", "--name-only", "HEAD"],
    ]);
    await expect(readTaskSummary(TEAM_NAME, "pi-agents-7")).resolves.toBe(
      "# Task pi-agents-7 Summary\n\nImplemented the task.",
    );
    expect(result).toMatchObject({
      taskId: "pi-agents-7",
      agentName: "code-1",
      branchName: "task-pi-agents-7",
      commitId: "abc123def456",
      touchedFiles: [
        "extensions/teams/agents/code-agent.ts",
        "extensions/teams/__tests__/code-agent.test.ts",
      ],
      subject: codeAgentCompletionSubject("pi-agents-7"),
      completedAt: "2026-04-08T20:00:00.000Z",
    });

    const inboxEntries = await readMailboxEntries(leaderInboxPath(TEAM_NAME));
    expect(inboxEntries).toHaveLength(1);
    expect(inboxEntries[0]).toMatchObject({
      sender: "code-1",
      receiver: "leader",
      subject: codeAgentCompletionSubject("pi-agents-7"),
      timestamp: "2026-04-08T20:00:00.000Z",
    });
    const message = inboxEntries[0]?.message;
    if (message === undefined) {
      throw new Error("Expected a leader mailbox message");
    }
    expect(parseCodeAgentCompletionReport(message)).toEqual({
      taskId: "pi-agents-7",
      agentName: "code-1",
      branchName: "task-pi-agents-7",
      worktreePath,
      commitId: "abc123def456",
      touchedFiles: [
        "extensions/teams/agents/code-agent.ts",
        "extensions/teams/__tests__/code-agent.test.ts",
      ],
      summaryPath: join(
        TEST_ROOT,
        TEAM_NAME,
        "summaries",
        "task-pi-agents-7-summary.md",
      ),
      completedAt: "2026-04-08T20:00:00.000Z",
    });
    expect(reset).toHaveBeenCalledOnce();
    expect(session.agent.state.messages).toEqual([]);
  });

  it("creates a default summary file when the agent did not write one explicitly", async () => {
    const worktreePath = join(WORKTREE_DIR, "task-pi-agents-8");
    await mkdir(worktreePath, { recursive: true });

    const runner: CommandRunner = async (_command, args) => {
      switch (args.join(" ")) {
        case "add --all":
          return { stdout: "", stderr: "" };
        case "status --porcelain --untracked-files=all":
          return {
            stdout: "M  extensions/teams/agents/code-agent.ts\n",
            stderr: "",
          };
        case "commit -m feat: implement pi-agents-8":
          return { stdout: "[task-pi-agents-8 def456] done\n", stderr: "" };
        case "rev-parse HEAD":
          return { stdout: "def456\n", stderr: "" };
        case "show --pretty=format: --name-only HEAD":
          return {
            stdout: "extensions/teams/agents/code-agent.ts\n",
            stderr: "",
          };
        default:
          throw new Error(`Unexpected command: ${args.join(" ")}`);
      }
    };

    await completeCodeAgentTask({
      teamName: TEAM_NAME,
      agentName: "code-1",
      taskId: "pi-agents-8",
      branchName: "task-pi-agents-8",
      worktreePath,
      session: {
        agent: {
          reset: () => {},
          state: { messages: [] },
        },
      },
      runner,
    });

    await expect(readTaskSummary(TEAM_NAME, "pi-agents-8")).resolves.toBe(
      "# Task pi-agents-8 Summary\n\n",
    );
  });

  it("fails with nothing-to-commit and does not create a summary or report", async () => {
    const worktreePath = join(WORKTREE_DIR, "task-pi-agents-9");
    await mkdir(worktreePath, { recursive: true });

    const runner: CommandRunner = async (_command, args) => {
      switch (args.join(" ")) {
        case "add --all":
          return { stdout: "", stderr: "" };
        case "status --porcelain --untracked-files=all":
          return { stdout: "", stderr: "" };
        default:
          throw new Error(`Unexpected command: ${args.join(" ")}`);
      }
    };

    await expect(
      completeCodeAgentTask({
        teamName: TEAM_NAME,
        agentName: "code-1",
        taskId: "pi-agents-9",
        branchName: "task-pi-agents-9",
        worktreePath,
        summaryMarkdown: "# Task pi-agents-9 Summary\n\nShould not persist.",
        session: {
          agent: {
            reset: vi.fn(),
            state: { messages: [] },
          },
        },
        runner,
      }),
    ).rejects.toMatchObject({
      code: "nothing-to-commit",
    } satisfies Partial<CodeAgentTaskError>);

    await expect(readTaskSummary(TEAM_NAME, "pi-agents-9")).resolves.toBe(
      undefined,
    );
    await expect(
      readMailboxEntries(leaderInboxPath(TEAM_NAME)),
    ).resolves.toEqual([]);
  });

  it("fails with commit-failed and does not create a summary or report", async () => {
    const worktreePath = join(WORKTREE_DIR, "task-pi-agents-10");
    await mkdir(worktreePath, { recursive: true });

    const runner: CommandRunner = async (_command, args) => {
      switch (args.join(" ")) {
        case "add --all":
          return { stdout: "", stderr: "" };
        case "status --porcelain --untracked-files=all":
          return {
            stdout: "M  extensions/teams/agents/code-agent.ts\n",
            stderr: "",
          };
        case "commit -m feat: implement pi-agents-10":
          throw new Error("git commit failed");
        default:
          throw new Error(`Unexpected command: ${args.join(" ")}`);
      }
    };

    await expect(
      completeCodeAgentTask({
        teamName: TEAM_NAME,
        agentName: "code-1",
        taskId: "pi-agents-10",
        branchName: "task-pi-agents-10",
        worktreePath,
        summaryMarkdown: "# Task pi-agents-10 Summary\n\nShould not persist.",
        session: {
          agent: {
            reset: vi.fn(),
            state: { messages: [] },
          },
        },
        runner,
      }),
    ).rejects.toMatchObject({
      code: "commit-failed",
    } satisfies Partial<CodeAgentTaskError>);

    await expect(readTaskSummary(TEAM_NAME, "pi-agents-10")).resolves.toBe(
      undefined,
    );
    await expect(
      readMailboxEntries(leaderInboxPath(TEAM_NAME)),
    ).resolves.toEqual([]);
  });
});

describe("resetCodeAgentSession", () => {
  it("does not overwrite message history when reset already clears it", () => {
    const session = {
      agent: {
        reset: vi.fn(() => {
          session.agent.state.messages = [];
        }),
        state: {
          messages: [{ role: "user", content: "done" }],
        },
      },
    };

    resetCodeAgentSession(session);

    expect(session.agent.reset).toHaveBeenCalledOnce();
    expect(session.agent.state.messages).toEqual([]);
  });
});

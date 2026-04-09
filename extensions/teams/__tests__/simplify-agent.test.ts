import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeAgentCompletionReport } from "../agents/code-agent.ts";
import { leaderInboxPath, readMailboxEntries } from "../agents/mailbox.ts";
import {
  completeSimplifyAgentTask,
  parseSimplifyAgentCompletionReport,
  type SimplifyAgentTaskError,
  simplifyAgentCompletionSubject,
} from "../agents/simplify-agent.ts";
import type { CommandRunner } from "../tasks/beads.ts";
import { readTaskSummary, writeTaskSummary } from "../tasks/summaries.ts";

const TEST_ROOT = join(tmpdir(), "pi-teams-simplify-agent-test-tmp");
const TEAM_NAME = "simplify-team";

function createCompletionReport(
  worktreePath: string,
  overrides: Partial<CodeAgentCompletionReport> = {},
): CodeAgentCompletionReport {
  return {
    taskId: "pi-agents-7",
    agentName: "code-1",
    branchName: "task-pi-agents-7",
    worktreePath,
    commitId: "abc123",
    touchedFiles: ["src/example.ts"],
    summaryPath: join(
      TEST_ROOT,
      TEAM_NAME,
      "summaries",
      "task-pi-agents-7-summary.md",
    ),
    completedAt: "2026-04-08T20:00:00.000Z",
    ...overrides,
  };
}

describe("completeSimplifyAgentTask", () => {
  beforeEach(async () => {
    process.env.PI_TEAMS_ROOT = TEST_ROOT;
    await mkdir(TEST_ROOT, { recursive: true });
  });

  afterEach(async () => {
    delete process.env.PI_TEAMS_ROOT;
    await rm(TEST_ROOT, { recursive: true, force: true });
  });

  it("commits simplify changes, appends a summary note, and reports the merged touched files", async () => {
    const worktreePath = join(TEST_ROOT, "worktrees", "task-pi-agents-7");
    await mkdir(worktreePath, { recursive: true });
    await writeTaskSummary(
      TEAM_NAME,
      "pi-agents-7",
      "# Task pi-agents-7 Summary\n\nImplemented the task.",
    );

    const calls: string[][] = [];
    const runner: CommandRunner = async (_command, args) => {
      calls.push([...args]);

      switch (args.join(" ")) {
        case "add --all":
          return { stdout: "", stderr: "" };
        case "status --porcelain --untracked-files=all":
          return {
            stdout: "M  src/example.ts\nA  src/extra.ts\n",
            stderr: "",
          };
        case "commit -m refactor: simplify pi-agents-7":
          return { stdout: "[task-pi-agents-7 def456] done\n", stderr: "" };
        case "rev-parse HEAD":
          return { stdout: "def456\n", stderr: "" };
        case "show --pretty=format: --name-only HEAD":
          return {
            stdout: "src/example.ts\nsrc/extra.ts\n",
            stderr: "",
          };
        default:
          throw new Error(`Unexpected command: ${args.join(" ")}`);
      }
    };
    const session = {
      followUp: vi.fn(async () => {}),
    };

    const result = await completeSimplifyAgentTask({
      teamName: TEAM_NAME,
      agentName: "simplify-1",
      completion: createCompletionReport(worktreePath),
      session,
      runner,
      now: () => new Date("2026-04-08T20:05:00.000Z"),
    });

    expect(session.followUp).toHaveBeenCalledOnce();
    expect(session.followUp).toHaveBeenCalledWith(
      expect.stringContaining("src/example.ts"),
    );
    expect(calls).toEqual([
      ["add", "--all"],
      ["status", "--porcelain", "--untracked-files=all"],
      ["commit", "-m", "refactor: simplify pi-agents-7"],
      ["rev-parse", "HEAD"],
      ["show", "--pretty=format:", "--name-only", "HEAD"],
    ]);
    await expect(readTaskSummary(TEAM_NAME, "pi-agents-7")).resolves.toContain(
      "Committed simplification updates in def456.",
    );
    expect(result).toMatchObject({
      taskId: "pi-agents-7",
      agentName: "simplify-1",
      commitId: "def456",
      changed: true,
      touchedFiles: ["src/example.ts", "src/extra.ts"],
      subject: simplifyAgentCompletionSubject("pi-agents-7"),
      completedAt: "2026-04-08T20:05:00.000Z",
    });

    const inboxEntries = await readMailboxEntries(leaderInboxPath(TEAM_NAME));
    expect(inboxEntries).toHaveLength(1);
    const message = inboxEntries[0]?.message;
    if (message === undefined) {
      throw new Error("Expected a simplify completion report");
    }
    expect(parseSimplifyAgentCompletionReport(message)).toEqual({
      taskId: "pi-agents-7",
      agentName: "simplify-1",
      branchName: "task-pi-agents-7",
      worktreePath,
      commitId: "def456",
      touchedFiles: ["src/example.ts", "src/extra.ts"],
      summaryPath: join(
        TEST_ROOT,
        TEAM_NAME,
        "summaries",
        "task-pi-agents-7-summary.md",
      ),
      completedAt: "2026-04-08T20:05:00.000Z",
      changed: true,
    });
  });

  it("skips the commit when the simplify pass makes no changes", async () => {
    const worktreePath = join(TEST_ROOT, "worktrees", "task-pi-agents-8");
    await mkdir(worktreePath, { recursive: true });

    const calls: string[][] = [];
    const runner: CommandRunner = async (_command, args) => {
      calls.push([...args]);

      switch (args.join(" ")) {
        case "add --all":
          return { stdout: "", stderr: "" };
        case "status --porcelain --untracked-files=all":
          return { stdout: "", stderr: "" };
        default:
          throw new Error(`Unexpected command: ${args.join(" ")}`);
      }
    };

    const result = await completeSimplifyAgentTask({
      teamName: TEAM_NAME,
      agentName: "simplify-1",
      completion: createCompletionReport(worktreePath, {
        taskId: "pi-agents-8",
        branchName: "task-pi-agents-8",
        commitId: "stay-put",
        touchedFiles: ["src/unchanged.ts"],
      }),
      session: {
        followUp: vi.fn(async () => {}),
      },
      runner,
      now: () => new Date("2026-04-08T20:10:00.000Z"),
    });

    expect(calls).toEqual([
      ["add", "--all"],
      ["status", "--porcelain", "--untracked-files=all"],
    ]);
    expect(result).toMatchObject({
      taskId: "pi-agents-8",
      commitId: "stay-put",
      touchedFiles: ["src/unchanged.ts"],
      changed: false,
    });
    await expect(readTaskSummary(TEAM_NAME, "pi-agents-8")).resolves.toContain(
      "No simplify changes were required after reviewing the touched files.",
    );
  });
});

describe("parseSimplifyAgentCompletionReport", () => {
  it("parses a valid simplify-agent completion report", () => {
    expect(
      parseSimplifyAgentCompletionReport(
        JSON.stringify({
          taskId: "pi-agents-7",
          agentName: "simplify-1",
          branchName: "task-pi-agents-7",
          worktreePath: "/workspace/project/.worktrees/task-pi-agents-7",
          commitId: "def456",
          touchedFiles: ["src/example.ts", "src/extra.ts"],
          summaryPath: "/tmp/task-pi-agents-7-summary.md",
          completedAt: "2026-04-08T20:05:00.000Z",
          changed: true,
        }),
      ),
    ).toEqual({
      taskId: "pi-agents-7",
      agentName: "simplify-1",
      branchName: "task-pi-agents-7",
      worktreePath: "/workspace/project/.worktrees/task-pi-agents-7",
      commitId: "def456",
      touchedFiles: ["src/example.ts", "src/extra.ts"],
      summaryPath: "/tmp/task-pi-agents-7-summary.md",
      completedAt: "2026-04-08T20:05:00.000Z",
      changed: true,
    });
  });

  const invalidMessageCases = [
    {
      name: "rejects invalid JSON",
      message: "not-json",
      expectedMessage: "Simplify-agent completion message was not valid JSON",
    },
    {
      name: "rejects non-object JSON payloads",
      message: JSON.stringify(["not", "an", "object"]),
      expectedMessage:
        "Simplify-agent completion message must be a JSON object",
    },
  ] as const;

  for (const testCase of invalidMessageCases) {
    it(testCase.name, () => {
      expect(() =>
        parseSimplifyAgentCompletionReport(testCase.message),
      ).toThrow(
        expect.objectContaining({
          name: "SimplifyAgentTaskError",
          code: "invalid-completion-report",
          message: testCase.expectedMessage,
        } satisfies Partial<SimplifyAgentTaskError>),
      );
    });
  }

  const invalidFieldCases = [
    {
      name: "rejects a missing required string field",
      payload: {
        taskId: "",
        agentName: "simplify-1",
        branchName: "task-pi-agents-7",
        worktreePath: "/workspace/project/.worktrees/task-pi-agents-7",
        commitId: "def456",
        touchedFiles: ["src/example.ts"],
        summaryPath: "/tmp/task-pi-agents-7-summary.md",
        completedAt: "2026-04-08T20:05:00.000Z",
        changed: true,
      },
      expectedMessage:
        'Simplify-agent completion field "taskId" must be a non-empty string',
    },
    {
      name: "rejects a wrong-type touchedFiles field",
      payload: {
        taskId: "pi-agents-7",
        agentName: "simplify-1",
        branchName: "task-pi-agents-7",
        worktreePath: "/workspace/project/.worktrees/task-pi-agents-7",
        commitId: "def456",
        touchedFiles: ["src/example.ts", 42],
        summaryPath: "/tmp/task-pi-agents-7-summary.md",
        completedAt: "2026-04-08T20:05:00.000Z",
        changed: true,
      },
      expectedMessage:
        'Simplify-agent completion field "touchedFiles" must be an array of strings',
    },
    {
      name: "rejects a wrong-type changed field",
      payload: {
        taskId: "pi-agents-7",
        agentName: "simplify-1",
        branchName: "task-pi-agents-7",
        worktreePath: "/workspace/project/.worktrees/task-pi-agents-7",
        commitId: "def456",
        touchedFiles: ["src/example.ts"],
        summaryPath: "/tmp/task-pi-agents-7-summary.md",
        completedAt: "2026-04-08T20:05:00.000Z",
        changed: "yes",
      },
      expectedMessage:
        'Simplify-agent completion field "changed" must be a boolean',
    },
  ] as const;

  for (const testCase of invalidFieldCases) {
    it(testCase.name, () => {
      expect(() =>
        parseSimplifyAgentCompletionReport(JSON.stringify(testCase.payload)),
      ).toThrow(
        expect.objectContaining({
          name: "SimplifyAgentTaskError",
          code: "invalid-completion-report",
          message: testCase.expectedMessage,
        } satisfies Partial<SimplifyAgentTaskError>),
      );
    });
  }
});

import { describe, expect, it } from "vitest";
import {
  parseSimplifyAgentCompletionReport,
  type SimplifyAgentTaskError,
  simplifyAgentCompletionSubject,
} from "../agents/simplify-agent.ts";

describe("simplifyAgentCompletionSubject", () => {
  it("returns the expected subject for a task ID", () => {
    expect(simplifyAgentCompletionSubject("pi-agents-7")).toBe(
      "task-pi-agents-7-simplify-complete",
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

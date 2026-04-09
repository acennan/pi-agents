import { describe, expect, it } from "vitest";
import {
  type CodeAgentTaskError,
  codeAgentCompletionSubject,
  parseCodeAgentCompletionReport,
} from "../agents/code-agent.ts";

describe("codeAgentCompletionSubject", () => {
  it("returns the expected subject for a task ID", () => {
    expect(codeAgentCompletionSubject("pi-agents-7")).toBe(
      "task-pi-agents-7-coding-complete",
    );
  });
});

describe("parseCodeAgentCompletionReport", () => {
  it("parses a valid code-agent completion report", () => {
    expect(
      parseCodeAgentCompletionReport(
        JSON.stringify({
          taskId: "pi-agents-7",
          agentName: "code-1",
          branchName: "task-pi-agents-7",
          worktreePath: "/workspace/project/.worktrees/task-pi-agents-7",
          commitId: "abc123def456",
          touchedFiles: [
            "extensions/teams/agents/code-agent.ts",
            "extensions/teams/__tests__/code-agent.test.ts",
          ],
          summaryPath:
            "/home/.pi/teams/myteam/summaries/task-pi-agents-7-summary.md",
          completedAt: "2026-04-08T20:00:00.000Z",
        }),
      ),
    ).toEqual({
      taskId: "pi-agents-7",
      agentName: "code-1",
      branchName: "task-pi-agents-7",
      worktreePath: "/workspace/project/.worktrees/task-pi-agents-7",
      commitId: "abc123def456",
      touchedFiles: [
        "extensions/teams/agents/code-agent.ts",
        "extensions/teams/__tests__/code-agent.test.ts",
      ],
      summaryPath:
        "/home/.pi/teams/myteam/summaries/task-pi-agents-7-summary.md",
      completedAt: "2026-04-08T20:00:00.000Z",
    });
  });

  const invalidMessageCases = [
    {
      name: "rejects invalid JSON",
      message: "not-json",
      expectedMessage: "Code-agent completion message was not valid JSON",
    },
    {
      name: "rejects non-object JSON payloads",
      message: JSON.stringify(["not", "an", "object"]),
      expectedMessage: "Code-agent completion message must be a JSON object",
    },
  ] as const;

  for (const testCase of invalidMessageCases) {
    it(testCase.name, () => {
      expect(() =>
        parseCodeAgentCompletionReport(testCase.message),
      ).toThrow(
        expect.objectContaining({
          name: "CodeAgentTaskError",
          code: "invalid-completion-report",
          message: testCase.expectedMessage,
        } satisfies Partial<CodeAgentTaskError>),
      );
    });
  }

  const invalidFieldCases = [
    {
      name: "rejects a missing required string field",
      payload: {
        taskId: "",
        agentName: "code-1",
        branchName: "task-pi-agents-7",
        worktreePath: "/workspace/project/.worktrees/task-pi-agents-7",
        commitId: "abc123",
        touchedFiles: ["src/example.ts"],
        summaryPath: "/tmp/task-pi-agents-7-summary.md",
        completedAt: "2026-04-08T20:00:00.000Z",
      },
      expectedMessage:
        'Code-agent completion message field "taskId" must be a non-empty string',
    },
    {
      name: "rejects a wrong-type touchedFiles field",
      payload: {
        taskId: "pi-agents-7",
        agentName: "code-1",
        branchName: "task-pi-agents-7",
        worktreePath: "/workspace/project/.worktrees/task-pi-agents-7",
        commitId: "abc123",
        touchedFiles: ["src/example.ts", 42],
        summaryPath: "/tmp/task-pi-agents-7-summary.md",
        completedAt: "2026-04-08T20:00:00.000Z",
      },
      expectedMessage:
        'Code-agent completion message field "touchedFiles" must be a string array',
    },
  ] as const;

  for (const testCase of invalidFieldCases) {
    it(testCase.name, () => {
      expect(() =>
        parseCodeAgentCompletionReport(JSON.stringify(testCase.payload)),
      ).toThrow(
        expect.objectContaining({
          name: "CodeAgentTaskError",
          code: "invalid-completion-report",
          message: testCase.expectedMessage,
        } satisfies Partial<CodeAgentTaskError>),
      );
    });
  }
});

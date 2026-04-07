import { describe, expect, it } from "vitest";
import { claimCodeAgentTask } from "../agents/code-agent.ts";
import type { CommandRunner } from "../tasks/beads.ts";

describe("claimCodeAgentTask", () => {
  it("uses the agent name as the default beads actor", async () => {
    const calls: string[][] = [];
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
              },
            ]),
            stderr: "",
          };
        default:
          throw new Error(`Unexpected command: ${args.join(" ")}`);
      }
    };

    const result = await claimCodeAgentTask({
      workspacePath: "/tmp/workspace",
      agentName: "code-1",
      runner,
    });

    expect(result.task?.id).toBe("pi-agents-1");
    expect(calls.at(-1)).toEqual([
      "update",
      "--actor",
      "code-1",
      "pi-agents-1",
      "--claim",
      "--json",
    ]);
  });

  it("prefers BR_ACTOR when present", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = async (_command, args) => {
      calls.push([...args]);

      switch (args.join(" ")) {
        case "ready --json":
          return {
            stdout: JSON.stringify([
              {
                id: "pi-agents-2",
                title: "Task 2",
                status: "open",
                priority: 1,
              },
            ]),
            stderr: "",
          };
        case "blocked --json":
          return { stdout: "[]", stderr: "" };
        case "update --actor team-bot pi-agents-2 --claim --json":
          return {
            stdout: JSON.stringify([
              {
                id: "pi-agents-2",
                title: "Task 2",
                status: "in_progress",
                priority: 1,
              },
            ]),
            stderr: "",
          };
        default:
          throw new Error(`Unexpected command: ${args.join(" ")}`);
      }
    };

    await claimCodeAgentTask({
      workspacePath: "/tmp/workspace",
      agentName: "code-2",
      runner,
      env: {
        BR_ACTOR: "team-bot",
      },
    });

    expect(calls.at(-1)).toEqual([
      "update",
      "--actor",
      "team-bot",
      "pi-agents-2",
      "--claim",
      "--json",
    ]);
  });
});

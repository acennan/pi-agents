import type { Api, Model } from "@mariozechner/pi-ai";
import { getModels } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapTeamChildRuntime,
  parseTeamChildRuntimeArgs,
  runTeamChildRuntime,
  TEAM_CHILD_RUNTIME_READY_EVENT,
  type TeamChildRuntimeReadyEvent,
} from "../agents/runtime-entry.ts";

function requireModel(provider: "anthropic" | "openai"): Model<Api> {
  const [model] = getModels(provider);
  if (model === undefined) {
    throw new Error(`Expected at least one ${provider} model in test runtime`);
  }
  return model;
}

describe("parseTeamChildRuntimeArgs", () => {
  it("parses explicit role/team/task/env arguments", () => {
    const result = parseTeamChildRuntimeArgs([
      "--role",
      "code",
      "--team",
      "alpha",
      "--agent",
      "code-1",
      "--workspace",
      "/tmp/workspace",
      "--cwd",
      "/tmp/workspace/worktree",
      "--task",
      "pi-agents-123",
      "--model",
      "anthropic/claude-opus-4-5",
      "--thinking",
      "medium",
      "--tools",
      "read,bash,grep",
      "--env",
      "PI_MAILBOX_LOCK_ATTEMPTS=5",
      "--env",
      "CUSTOM_FLAG=enabled",
    ]);

    expect(result).toMatchObject({
      role: "code",
      teamName: "alpha",
      agentName: "code-1",
      workspacePath: "/tmp/workspace",
      cwd: "/tmp/workspace/worktree",
      taskId: "pi-agents-123",
      modelReference: "anthropic/claude-opus-4-5",
      thinkingLevel: "medium",
      tools: ["read", "bash", "grep"],
      env: {
        PI_MAILBOX_LOCK_ATTEMPTS: "5",
        CUSTOM_FLAG: "enabled",
      },
    });
  });

  it("rejects leader mode for child runtimes", () => {
    expect(() =>
      parseTeamChildRuntimeArgs([
        "--role",
        "leader",
        "--team",
        "alpha",
        "--agent",
        "leader-1",
        "--workspace",
        "/tmp/workspace",
        "--model",
        "anthropic/claude-opus-4-5",
        "--thinking",
        "medium",
        "--tools",
        "read",
      ]),
    ).toThrow('cannot run with role "leader"');
  });

  it("fails when a required argument is missing", () => {
    expect(() =>
      parseTeamChildRuntimeArgs([
        "--role",
        "code",
        "--agent",
        "code-1",
        "--workspace",
        "/tmp/workspace",
        "--model",
        "anthropic/claude-opus-4-5",
        "--thinking",
        "medium",
        "--tools",
        "read",
      ]),
    ).toThrow("Missing required runtime argument --team");
  });

  it("rejects unknown tool names", () => {
    expect(() =>
      parseTeamChildRuntimeArgs([
        "--role",
        "code",
        "--team",
        "alpha",
        "--agent",
        "code-1",
        "--workspace",
        "/tmp/workspace",
        "--model",
        "anthropic/claude-opus-4-5",
        "--thinking",
        "medium",
        "--tools",
        "read,invalidtool",
      ]),
    ).toThrow('Unknown tool name "invalidtool"');
  });

  it("rejects malformed env values", () => {
    expect(() =>
      parseTeamChildRuntimeArgs([
        "--role",
        "code",
        "--team",
        "alpha",
        "--agent",
        "code-1",
        "--workspace",
        "/tmp/workspace",
        "--model",
        "anthropic/claude-opus-4-5",
        "--thinking",
        "medium",
        "--tools",
        "read",
        "--env",
        "NOEQUALS",
      ]),
    ).toThrow('Invalid --env value "NOEQUALS". Expected KEY=value');
  });
});

describe("bootstrapTeamChildRuntime", () => {
  it("creates an SDK session with the requested cwd, model, thinking level, and tools", async () => {
    const model = requireModel("anthropic");
    const session = {
      dispose: vi.fn(),
    };
    const createSession = vi.fn(async (_options) => ({
      session: session as never,
    }));
    const createTools = vi.fn((_cwd: string, toolNames: readonly string[]) =>
      toolNames.map((toolName) => ({ name: toolName }) as never),
    );
    const resolveModel = vi.fn(() => model);

    const result = await bootstrapTeamChildRuntime(
      [
        "--role",
        "review",
        "--team",
        "alpha",
        "--agent",
        "review-1",
        "--workspace",
        "/tmp/workspace",
        "--cwd",
        "/tmp/workspace/task-1",
        "--task",
        "pi-agents-999",
        "--model",
        `${model.provider}/${model.id}`,
        "--thinking",
        "low",
        "--tools",
        "read,find,ls",
      ],
      {
        resolveModel,
        createSession,
        createTools,
      },
    );

    expect(result.args).toMatchObject({
      role: "review",
      teamName: "alpha",
      agentName: "review-1",
      taskId: "pi-agents-999",
      cwd: "/tmp/workspace/task-1",
      thinkingLevel: "low",
      tools: ["read", "find", "ls"],
    });
    expect(resolveModel).toHaveBeenCalledOnce();
    expect(createTools).toHaveBeenCalledWith("/tmp/workspace/task-1", [
      "read",
      "find",
      "ls",
    ]);

    expect(createSession).toHaveBeenCalledOnce();
    const [options] = createSession.mock.calls[0] ?? [];
    expect(options).toMatchObject({
      cwd: "/tmp/workspace/task-1",
      model,
      thinkingLevel: "low",
    });
    expect(options.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "read",
      "find",
      "ls",
    ]);
    expect(result.session).toBe(session);
  });
});

describe("runTeamChildRuntime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a ready event and disposes the session on shutdown", async () => {
    const model = requireModel("openai");
    const dispose = vi.fn();
    const session = { dispose };
    const stdoutChunks: string[] = [];

    await runTeamChildRuntime({
      argv: [
        "--role",
        "test",
        "--team",
        "alpha",
        "--agent",
        "test-1",
        "--workspace",
        "/tmp/workspace",
        "--model",
        `${model.provider}/${model.id}`,
        "--thinking",
        "off",
        "--tools",
        "read,bash",
      ],
      stdout: {
        write(chunk: string) {
          stdoutChunks.push(chunk);
          return true;
        },
      },
      resolveModel: () => model,
      createTools: () => [],
      createSession: async () => ({ session: session as never }),
      installSignalHandlers: false,
      onReady: ({ requestShutdown, args }) => {
        expect(args.role).toBe("test");
        expect(args.agentName).toBe("test-1");
        requestShutdown();
      },
    });

    const stdout = stdoutChunks.join("");
    const readyEvent = JSON.parse(stdout.trim()) as TeamChildRuntimeReadyEvent;
    expect(readyEvent).toMatchObject({
      type: TEAM_CHILD_RUNTIME_READY_EVENT,
      role: "test",
      teamName: "alpha",
      agentName: "test-1",
    });
    expect(dispose).toHaveBeenCalledOnce();
  });
});

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import { getModels } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailboxEntry } from "../agents/mailbox.ts";
import {
  bootstrapTeamChildRuntime,
  deliverMailboxEntryToSession,
  parseTeamChildRuntimeArgs,
  runTeamChildRuntime,
  TEAM_CHILD_PROMPT_ARGS_ENV_VAR,
  TEAM_CHILD_PROMPT_TEMPLATE_ENV_VAR,
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
      followUp: vi.fn(),
      setFollowUpMode: vi.fn(),
      steer: vi.fn(),
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
    expect(session.setFollowUpMode).toHaveBeenCalledWith("one-at-a-time");
  });

  it("loads the configured prompt template into the child session resources", async () => {
    const model = requireModel("anthropic");
    const session = {
      agent: {},
      dispose: vi.fn(),
      followUp: vi.fn(),
      setFollowUpMode: vi.fn(),
      steer: vi.fn(),
    };
    const teamsRoot = join(
      tmpdir(),
      `pi-runtime-entry-prompt-${process.pid}-${Date.now()}`,
    );
    process.env.PI_TEAMS_ROOT = teamsRoot;
    await mkdir(join(teamsRoot, "prompt-templates"), { recursive: true });
    await writeFile(
      join(teamsRoot, "prompt-templates", "code-prompt.md"),
      [
        "---",
        "description: prompt",
        "---",
        "Worktrees: $1",
        "Summaries: $2",
      ].join("\n"),
      "utf8",
    );

    let loadedSystemPrompt: string | undefined;
    const createSession = vi.fn(async (options) => {
      await options.resourceLoader?.reload();
      loadedSystemPrompt = options.resourceLoader?.getSystemPrompt();
      return { session: session as never };
    });

    try {
      await bootstrapTeamChildRuntime(
        {
          role: "code",
          teamName: "alpha",
          agentName: "code-1",
          workspacePath: "/tmp/workspace",
          cwd: "/tmp/workspace",
          modelReference: `${model.provider}/${model.id}`,
          thinkingLevel: "medium",
          tools: ["read"],
          env: {
            [TEAM_CHILD_PROMPT_TEMPLATE_ENV_VAR]: "code-prompt.md",
            [TEAM_CHILD_PROMPT_ARGS_ENV_VAR]: JSON.stringify([
              "/tmp/worktrees",
              "/tmp/summaries",
            ]),
          },
        },
        {
          resolveModel: () => model,
          createSession,
          createTools: () => [],
        },
      );
    } finally {
      delete process.env.PI_TEAMS_ROOT;
      await rm(teamsRoot, { recursive: true, force: true });
    }

    expect(loadedSystemPrompt).toBe(
      "Worktrees: /tmp/worktrees\nSummaries: /tmp/summaries",
    );
  });

  it("picks up updated prompt template contents for later child spawns", async () => {
    const model = requireModel("anthropic");
    const session = {
      dispose: vi.fn(),
      followUp: vi.fn(),
      setFollowUpMode: vi.fn(),
      steer: vi.fn(),
    };
    const teamsRoot = join(
      tmpdir(),
      `pi-runtime-entry-prompt-refresh-${process.pid}-${Date.now()}`,
    );
    const promptPath = join(
      teamsRoot,
      "prompt-templates",
      "simplify-prompt.md",
    );
    process.env.PI_TEAMS_ROOT = teamsRoot;
    await mkdir(join(teamsRoot, "prompt-templates"), { recursive: true });

    const loadedPrompts: string[] = [];
    const createSession = vi.fn(async (options) => {
      await options.resourceLoader?.reload();
      const systemPrompt = options.resourceLoader?.getSystemPrompt();
      if (systemPrompt !== undefined) {
        loadedPrompts.push(systemPrompt);
      }
      return { session: session as never };
    });

    try {
      await writeFile(promptPath, "Version one: $1\n", "utf8");
      await bootstrapTeamChildRuntime(
        {
          role: "simplify",
          teamName: "alpha",
          agentName: "simplify-1",
          workspacePath: "/tmp/workspace",
          cwd: "/tmp/workspace/task-1",
          taskId: "pi-agents-1",
          modelReference: `${model.provider}/${model.id}`,
          thinkingLevel: "medium",
          tools: ["read"],
          env: {
            [TEAM_CHILD_PROMPT_TEMPLATE_ENV_VAR]: "simplify-prompt.md",
            [TEAM_CHILD_PROMPT_ARGS_ENV_VAR]: JSON.stringify(["pi-agents-1"]),
          },
        },
        {
          resolveModel: () => model,
          createSession,
          createTools: () => [],
        },
      );

      await writeFile(promptPath, "Version two: $1\n", "utf8");
      await bootstrapTeamChildRuntime(
        {
          role: "simplify",
          teamName: "alpha",
          agentName: "simplify-2",
          workspacePath: "/tmp/workspace",
          cwd: "/tmp/workspace/task-2",
          taskId: "pi-agents-2",
          modelReference: `${model.provider}/${model.id}`,
          thinkingLevel: "medium",
          tools: ["read"],
          env: {
            [TEAM_CHILD_PROMPT_TEMPLATE_ENV_VAR]: "simplify-prompt.md",
            [TEAM_CHILD_PROMPT_ARGS_ENV_VAR]: JSON.stringify(["pi-agents-2"]),
          },
        },
        {
          resolveModel: () => model,
          createSession,
          createTools: () => [],
        },
      );
    } finally {
      delete process.env.PI_TEAMS_ROOT;
      await rm(teamsRoot, { recursive: true, force: true });
    }

    expect(loadedPrompts).toEqual([
      "Version one: pi-agents-1\n",
      "Version two: pi-agents-2\n",
    ]);
  });
});

describe("deliverMailboxEntryToSession", () => {
  it("maps queued-work, send, and broadcast entries to follow-up delivery", async () => {
    const session = {
      followUp: vi.fn(async () => {}),
      steer: vi.fn(async () => {}),
    };

    for (const entry of [
      { subject: "queued-work", message: "task A" },
      { subject: "send", message: "task B" },
      { subject: "broadcast", message: "task C" },
    ] satisfies Pick<MailboxEntry, "message" | "subject">[]) {
      await expect(deliverMailboxEntryToSession(entry, session)).resolves.toBe(
        "follow-up",
      );
    }

    expect(session.followUp).toHaveBeenNthCalledWith(1, "task A");
    expect(session.followUp).toHaveBeenNthCalledWith(2, "task B");
    expect(session.followUp).toHaveBeenNthCalledWith(3, "task C");
    expect(session.steer).not.toHaveBeenCalled();
  });

  it("maps steering entries to session.steer and ignores unrelated subjects", async () => {
    const session = {
      followUp: vi.fn(async () => {}),
      steer: vi.fn(async () => {}),
    };

    await expect(
      deliverMailboxEntryToSession(
        { subject: "steer", message: "switch direction" },
        session,
      ),
    ).resolves.toBe("steer");
    await expect(
      deliverMailboxEntryToSession(
        { subject: "task-complete", message: "done" },
        session,
      ),
    ).resolves.toBe("ignored");

    expect(session.steer).toHaveBeenCalledWith("switch direction");
    expect(session.followUp).not.toHaveBeenCalled();
  });
});

describe("runTeamChildRuntime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a ready event and disposes the session on shutdown", async () => {
    const model = requireModel("openai");
    const dispose = vi.fn();
    const session = {
      dispose,
      followUp: vi.fn(async () => {}),
      setFollowUpMode: vi.fn(),
      steer: vi.fn(async () => {}),
    };
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

  it("runs one-shot simplify work and shuts down automatically", async () => {
    const model = requireModel("openai");
    const dispose = vi.fn();
    const session = {
      dispose,
      followUp: vi.fn(async () => {}),
      setFollowUpMode: vi.fn(),
      steer: vi.fn(async () => {}),
    };
    const runSimplifyTask = vi.fn(async ({ args }) => {
      expect(args.role).toBe("simplify");
      expect(args.agentName).toBe("simplify-1");
      expect(args.taskId).toBe("pi-agents-321");
    });

    await runTeamChildRuntime({
      argv: [
        "--role",
        "simplify",
        "--team",
        "alpha",
        "--agent",
        "simplify-1",
        "--workspace",
        "/tmp/workspace",
        "--cwd",
        "/tmp/workspace/task-pi-agents-321",
        "--task",
        "pi-agents-321",
        "--model",
        `${model.provider}/${model.id}`,
        "--thinking",
        "medium",
        "--tools",
        "read,edit,write",
      ],
      stdout: {
        write(_chunk: string) {
          return true;
        },
      },
      resolveModel: () => model,
      createTools: () => [],
      createSession: async () => ({ session: session as never }),
      installSignalHandlers: false,
      runSimplifyTask,
    });

    expect(runSimplifyTask).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });
});

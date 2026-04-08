import type { Api, Model } from "@mariozechner/pi-ai";
import { getModels } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createCodeAgentContextPruner,
  installCodeAgentContextPruning,
} from "../agents/context-pruning.ts";
import { bootstrapTeamChildRuntime } from "../agents/runtime-entry.ts";

function requireModel(provider: "anthropic" | "openai"): Model<Api> {
  const [model] = getModels(provider);
  if (model === undefined) {
    throw new Error(`Expected at least one ${provider} model in test runtime`);
  }
  return model;
}

describe("createCodeAgentContextPruner", () => {
  it("keeps only the most recent messages once the limit is exceeded", async () => {
    const pruner = createCodeAgentContextPruner({ maxMessages: 2 });
    const messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
      { role: "user", content: "third" },
    ];

    await expect(pruner(messages as never)).resolves.toEqual([
      { role: "assistant", content: "second" },
      { role: "user", content: "third" },
    ]);
  });
});

describe("installCodeAgentContextPruning", () => {
  it("stores a transformContext hook on the session agent", async () => {
    const session = {
      agent: {},
    };

    installCodeAgentContextPruning(session, { maxMessages: 1 });

    const transformContext = Reflect.get(session.agent, "transformContext");
    expect(typeof transformContext).toBe("function");
    if (typeof transformContext !== "function") {
      throw new Error("Expected transformContext to be installed");
    }

    await expect(
      transformContext([
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
      ]),
    ).resolves.toEqual([{ role: "assistant", content: "two" }]);
  });
});

describe("bootstrapTeamChildRuntime", () => {
  it("installs context pruning for code runtimes", async () => {
    const model = requireModel("anthropic");
    const session = {
      agent: {},
      dispose: vi.fn(),
      followUp: vi.fn(async () => {}),
      setFollowUpMode: vi.fn(),
      steer: vi.fn(async () => {}),
    };

    await bootstrapTeamChildRuntime(
      [
        "--role",
        "code",
        "--team",
        "alpha",
        "--agent",
        "code-1",
        "--workspace",
        "/tmp/workspace",
        "--cwd",
        "/tmp/workspace/task-1",
        "--task",
        "pi-agents-9",
        "--model",
        `${model.provider}/${model.id}`,
        "--thinking",
        "low",
        "--tools",
        "read,write,edit,bash",
      ],
      {
        resolveModel: () => model,
        createTools: () => [],
        createSession: async () => ({ session: session as never }),
      },
    );

    const transformContext = Reflect.get(session.agent, "transformContext");
    expect(typeof transformContext).toBe("function");
  });
});

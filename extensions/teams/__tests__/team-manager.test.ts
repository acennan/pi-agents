import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureTeamMailbox,
  readMailboxEntries,
  teamMailboxInboxPath,
} from "../agents/mailbox.ts";
import type {
  ChildRuntimeExit,
  SpawnChildRuntimeOptions,
  SpawnedChildRuntime,
} from "../leader/process-manager.ts";
import {
  type ManagedCodeAgent,
  type TeamLifecycleSink,
  TeamManager,
  TeamManagerError,
} from "../leader/team-manager.ts";
import type { TeamSnapshot } from "../storage/team-home.ts";

const TEST_ROOT = join(tmpdir(), "pi-teams-manager-test-tmp");

type ControlledRuntime = {
  options: SpawnChildRuntimeOptions;
  runtime: SpawnedChildRuntime;
  kill: ReturnType<typeof vi.fn>;
  resolve: (exit: ChildRuntimeExit) => void;
};

function createSnapshot(config: unknown): TeamSnapshot {
  return {
    name: "alpha",
    workspacePath: "/workspace/project",
    worktreeDir: "/workspace/project/.worktrees",
    model: "anthropic/claude-opus-4-5",
    thinkingLevel: "medium",
    createdAt: "2026-04-06T00:00:00.000Z",
    config,
  };
}

function createLifecycleSink() {
  return {
    addEvent: vi.fn(),
    notify: vi.fn(),
    setTeamStatus: vi.fn(),
    updateAgent: vi.fn(),
  } satisfies TeamLifecycleSink;
}

function createControlledSpawnStub() {
  let nextPid = 4100;
  const runtimes: ControlledRuntime[] = [];

  const spawnChildRuntime = vi.fn(
    (options: SpawnChildRuntimeOptions): SpawnedChildRuntime => {
      let resolveExit!: (exit: ChildRuntimeExit) => void;
      const kill = vi.fn((signal?: NodeJS.Signals | number) => {
        const normalizedSignal =
          typeof signal === "string"
            ? signal
            : signal === undefined
              ? null
              : null;
        resolveExit(
          createExit(options, {
            signal: normalizedSignal,
            expectedExit: normalizedSignal === "SIGTERM",
            crashed: normalizedSignal !== "SIGTERM",
          }),
        );
        return true;
      });

      const completion = new Promise<ChildRuntimeExit>((resolve) => {
        resolveExit = resolve;
      });
      const runtime: SpawnedChildRuntime = {
        child: {
          pid: nextPid,
          kill,
        } as unknown as SpawnedChildRuntime["child"],
        metadata: {
          role: options.role,
          teamName: options.teamName,
          agentName: options.agentName,
          workspacePath: resolve(options.workspacePath),
          cwd: resolve(options.cwd ?? options.workspacePath),
          taskId: options.taskId,
          model: options.model,
          thinkingLevel: options.thinkingLevel,
          tools: [...options.tools],
          env: { ...(options.env ?? {}) },
        },
        completion,
      };

      runtimes.push({
        options,
        runtime,
        kill,
        resolve: resolveExit,
      });
      nextPid += 1;
      return runtime;
    },
  );

  return { spawnChildRuntime, runtimes };
}

function createExit(
  options: SpawnChildRuntimeOptions,
  overrides: Partial<ChildRuntimeExit> = {},
): ChildRuntimeExit {
  return {
    metadata: {
      role: options.role,
      teamName: options.teamName,
      agentName: options.agentName,
      workspacePath: resolve(options.workspacePath),
      cwd: resolve(options.cwd ?? options.workspacePath),
      taskId: options.taskId,
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      tools: [...options.tools],
      env: { ...(options.env ?? {}) },
    },
    code: 0,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    crashed: false,
    expectedExit: true,
    ...overrides,
  };
}

function flushMicrotasks(): Promise<void> {
  return Promise.resolve();
}

function getAgentNames(agents: ManagedCodeAgent[]): string[] {
  return agents.map((agent) => agent.name);
}

describe("TeamManager", () => {
  beforeEach(async () => {
    process.env.PI_TEAMS_ROOT = TEST_ROOT;
    await mkdir(TEST_ROOT, { recursive: true });
  });

  afterEach(async () => {
    delete process.env.PI_TEAMS_ROOT;
    await rm(TEST_ROOT, { recursive: true, force: true });
  });

  it("starts one standing child process per configured code agent", async () => {
    const spawn = createControlledSpawnStub();
    const manager = new TeamManager({
      spawnChildRuntime: spawn.spawnChildRuntime,
      now: () => new Date("2026-04-06T12:00:00.000Z"),
    });
    const lifecycleSink = createLifecycleSink();

    const result = await manager.startTeam({
      snapshot: createSnapshot({
        agents: [
          {
            nameTemplate: "code",
            type: "code",
            count: 2,
            tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
          },
        ],
        subAgents: [
          {
            nameTemplate: "review",
            type: "review",
            maxAllowed: 1,
            tools: ["read", "grep", "find", "ls"],
          },
        ],
      }),
      lifecycleSink,
    });

    expect(spawn.spawnChildRuntime).toHaveBeenCalledTimes(2);
    expect(result.codeAgentCount).toBe(2);
    expect(getAgentNames(result.codeAgents)).toEqual(["code-1", "code-2"]);
    expect(manager.isActive()).toBe(true);
    expect(getAgentNames(manager.getActiveTeam()?.codeAgents ?? [])).toEqual([
      "code-1",
      "code-2",
    ]);
    expect(spawn.runtimes.map((runtime) => runtime.options.agentName)).toEqual([
      "code-1",
      "code-2",
    ]);
    expect(spawn.runtimes.map((runtime) => runtime.options.role)).toEqual([
      "code",
      "code",
    ]);
    expect(lifecycleSink.setTeamStatus).toHaveBeenCalledWith("Active");
    expect(lifecycleSink.addEvent).toHaveBeenCalledWith(
      "Started 2 standing code agents",
    );
    expect(existsSync(teamMailboxInboxPath("alpha", "leader"))).toBe(true);
    expect(existsSync(teamMailboxInboxPath("alpha", "code-1"))).toBe(true);
    expect(existsSync(teamMailboxInboxPath("alpha", "code-2"))).toBe(true);
  });

  it("falls back to the leader snapshot model, thinking level, and full tools", async () => {
    const spawn = createControlledSpawnStub();
    const manager = new TeamManager({
      spawnChildRuntime: spawn.spawnChildRuntime,
    });

    await manager.startTeam({
      snapshot: createSnapshot({
        agents: [
          {
            nameTemplate: "code",
            type: "code",
          },
        ],
      }),
    });

    expect(spawn.runtimes).toHaveLength(1);
    expect(spawn.runtimes[0]?.options.model).toBe("anthropic/claude-opus-4-5");
    expect(spawn.runtimes[0]?.options.thinkingLevel).toBe("medium");
    expect(spawn.runtimes[0]?.options.tools).toEqual([
      "read",
      "write",
      "edit",
      "bash",
      "grep",
      "find",
      "ls",
    ]);
  });

  it("records a clean runtime exit while the team is still running", async () => {
    const spawn = createControlledSpawnStub();
    const manager = new TeamManager({
      spawnChildRuntime: spawn.spawnChildRuntime,
    });
    const lifecycleSink = createLifecycleSink();

    await manager.startTeam({
      snapshot: createSnapshot({
        agents: [{ nameTemplate: "code", type: "code" }],
      }),
      lifecycleSink,
    });

    const [runtime] = spawn.runtimes;
    if (runtime === undefined) {
      throw new Error("Expected one runtime");
    }

    runtime.resolve(
      createExit(runtime.options, {
        code: 0,
        expectedExit: true,
        crashed: false,
      }),
    );
    await flushMicrotasks();

    expect(manager.getActiveTeam()?.codeAgents[0]).toMatchObject({
      name: "code-1",
      status: "stopped",
    });
    expect(lifecycleSink.addEvent).toHaveBeenCalledWith(
      "Code agent code-1 exited (exit code 0)",
    );
    expect(lifecycleSink.notify).not.toHaveBeenCalled();
  });

  it("enforces one active team per leader session", async () => {
    const spawn = createControlledSpawnStub();
    const manager = new TeamManager({
      spawnChildRuntime: spawn.spawnChildRuntime,
    });

    await manager.startTeam({
      snapshot: createSnapshot({
        agents: [{ nameTemplate: "code", type: "code" }],
      }),
    });

    await expect(
      manager.startTeam({
        snapshot: createSnapshot({
          agents: [{ nameTemplate: "code", type: "code" }],
        }),
      }),
    ).rejects.toBeInstanceOf(TeamManagerError);
    await expect(
      manager.startTeam({
        snapshot: createSnapshot({
          agents: [{ nameTemplate: "code", type: "code" }],
        }),
      }),
    ).rejects.toMatchObject({ code: "team-active" });
  });

  it("records unexpected child exits as crashes and surfaces them", async () => {
    const spawn = createControlledSpawnStub();
    const manager = new TeamManager({
      spawnChildRuntime: spawn.spawnChildRuntime,
    });
    const lifecycleSink = createLifecycleSink();

    await manager.startTeam({
      snapshot: createSnapshot({
        agents: [{ nameTemplate: "code", type: "code" }],
      }),
      lifecycleSink,
    });

    const [runtime] = spawn.runtimes;
    if (runtime === undefined) {
      throw new Error("Expected one runtime");
    }

    runtime.resolve(
      createExit(runtime.options, {
        code: 17,
        expectedExit: false,
        crashed: true,
      }),
    );
    await flushMicrotasks();

    expect(manager.getActiveTeam()?.codeAgents[0]).toMatchObject({
      name: "code-1",
      status: "crashed",
    });
    expect(lifecycleSink.addEvent).toHaveBeenCalledWith(
      "Code agent code-1 crashed (exit code 17)",
    );
    expect(lifecycleSink.notify).toHaveBeenCalledWith(
      "Code agent code-1 crashed (exit code 17)",
      "error",
    );
  });

  it("queues send and steer messages to active agent mailboxes", async () => {
    const spawn = createControlledSpawnStub();
    const manager = new TeamManager({
      spawnChildRuntime: spawn.spawnChildRuntime,
    });

    await manager.startTeam({
      snapshot: createSnapshot({
        agents: [{ nameTemplate: "code", type: "code" }],
      }),
    });

    await manager.sendMessage("code-1", "focus on tests");
    await manager.steerMessage("code-1", "switch to lint failures");

    await expect(
      readMailboxEntries(teamMailboxInboxPath("alpha", "code-1")),
    ).resolves.toMatchObject([
      {
        sender: "leader",
        receiver: "code-1",
        subject: "send",
        message: "focus on tests",
      },
      {
        sender: "leader",
        receiver: "code-1",
        subject: "steer",
        message: "switch to lint failures",
      },
    ]);
  });

  it("routes directed messages to active sub-agent mailboxes when they exist", async () => {
    const spawn = createControlledSpawnStub();
    const manager = new TeamManager({
      spawnChildRuntime: spawn.spawnChildRuntime,
    });

    await manager.startTeam({
      snapshot: createSnapshot({
        agents: [{ nameTemplate: "code", type: "code" }],
      }),
    });
    await ensureTeamMailbox("alpha", "review-1");

    await manager.sendMessage("review-1", "check the failing test");

    await expect(
      readMailboxEntries(teamMailboxInboxPath("alpha", "review-1")),
    ).resolves.toMatchObject([
      {
        sender: "leader",
        receiver: "review-1",
        subject: "send",
        message: "check the failing test",
      },
    ]);
  });

  it("broadcasts queued messages to all standing code agents", async () => {
    const spawn = createControlledSpawnStub();
    const manager = new TeamManager({
      spawnChildRuntime: spawn.spawnChildRuntime,
    });

    await manager.startTeam({
      snapshot: createSnapshot({
        agents: [{ nameTemplate: "code", type: "code", count: 2 }],
      }),
    });

    const result = await manager.broadcastMessage("all hands on deck", "code");

    expect(result).toEqual({
      teamName: "alpha",
      agentType: "code",
      ignored: false,
      targetNames: ["code-1", "code-2"],
    });
    await expect(
      readMailboxEntries(teamMailboxInboxPath("alpha", "code-1")),
    ).resolves.toMatchObject([
      {
        sender: "leader",
        receiver: "code-1",
        subject: "broadcast",
        message: "all hands on deck",
      },
    ]);
    await expect(
      readMailboxEntries(teamMailboxInboxPath("alpha", "code-2")),
    ).resolves.toMatchObject([
      {
        sender: "leader",
        receiver: "code-2",
        subject: "broadcast",
        message: "all hands on deck",
      },
    ]);
  });

  it("rejects invalid broadcast target types", async () => {
    const spawn = createControlledSpawnStub();
    const manager = new TeamManager({
      spawnChildRuntime: spawn.spawnChildRuntime,
    });

    await manager.startTeam({
      snapshot: createSnapshot({
        agents: [{ nameTemplate: "code", type: "code" }],
      }),
    });

    await expect(
      manager.broadcastMessage("nope", "review"),
    ).rejects.toMatchObject({
      code: "invalid-broadcast-type",
    });
  });

  it("stops standing code agents with SIGTERM and clears the active team", async () => {
    const spawn = createControlledSpawnStub();
    const manager = new TeamManager({
      spawnChildRuntime: spawn.spawnChildRuntime,
    });
    const lifecycleSink = createLifecycleSink();

    await manager.startTeam({
      snapshot: createSnapshot({
        agents: [{ nameTemplate: "code", type: "code", count: 2 }],
      }),
      lifecycleSink,
    });

    const result = await manager.stopActiveTeam();

    expect(result).toEqual({
      teamName: "alpha",
      stoppedAgentCount: 2,
      crashedAgentCount: 0,
    });
    expect(
      spawn.runtimes.map((runtime) => runtime.kill.mock.calls[0]?.[0]),
    ).toEqual(["SIGTERM", "SIGTERM"]);
    expect(manager.isActive()).toBe(false);
    expect(lifecycleSink.setTeamStatus).toHaveBeenNthCalledWith(2, "Stopping");
    expect(lifecycleSink.setTeamStatus).toHaveBeenNthCalledWith(3, "Stopped");
  });

  it("ignores new operator messages while the team is stopping", async () => {
    const spawn = createControlledSpawnStub();
    const manager = new TeamManager({
      spawnChildRuntime: spawn.spawnChildRuntime,
    });

    await manager.startTeam({
      snapshot: createSnapshot({
        agents: [{ nameTemplate: "code", type: "code" }],
      }),
    });

    const [runtime] = spawn.runtimes;
    if (runtime === undefined) {
      throw new Error("Expected one runtime");
    }

    runtime.kill.mockImplementationOnce(() => true);
    const stopPromise = manager.stopActiveTeam();

    const sendResult = await manager.sendMessage("code-1", "ignored");
    expect(sendResult.ignored).toBe(true);

    runtime.resolve(
      createExit(runtime.options, {
        signal: "SIGTERM",
        expectedExit: true,
        crashed: false,
      }),
    );
    await stopPromise;

    await expect(
      readMailboxEntries(teamMailboxInboxPath("alpha", "code-1")),
    ).resolves.toEqual([]);
  });

  it("rolls back already-started children when startup fails partway through", async () => {
    const spawn = createControlledSpawnStub();
    const manager = new TeamManager({
      spawnChildRuntime: vi
        .fn()
        .mockImplementationOnce(spawn.spawnChildRuntime)
        .mockImplementationOnce(() => {
          throw new Error("spawn failed");
        }),
    });

    await expect(
      manager.startTeam({
        snapshot: createSnapshot({
          agents: [{ nameTemplate: "code", type: "code", count: 2 }],
        }),
      }),
    ).rejects.toThrow("spawn failed");

    expect(spawn.runtimes).toHaveLength(1);
    expect(spawn.runtimes[0]?.kill).toHaveBeenCalledWith("SIGTERM");
    expect(manager.isActive()).toBe(false);
  });
});

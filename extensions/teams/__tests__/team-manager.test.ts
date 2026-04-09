import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codeAgentCompletionSubject } from "../agents/code-agent.ts";
import {
  appendLeaderMailboxEntry,
  ensureTeamMailbox,
  readMailboxEntries,
  teamMailboxInboxPath,
} from "../agents/mailbox.ts";
import {
  TEAM_CHILD_PROMPT_ARGS_ENV_VAR,
  TEAM_CHILD_PROMPT_TEMPLATE_ENV_VAR,
  TEAM_CHILD_SIMPLIFY_INPUT_ENV_VAR,
} from "../agents/runtime-entry.ts";
import { simplifyAgentCompletionSubject } from "../agents/simplify-agent.ts";
import type {
  ChildRuntimeExit,
  SpawnChildRuntimeOptions,
  SpawnedChildRuntime,
} from "../leader/process-manager.ts";
import {
  type ManagedCodeAgent,
  TEAM_CONTROL_MESSAGE_PAUSED,
  TEAM_CONTROL_MESSAGE_RESUMED,
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

async function waitFor(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for ${description}`);
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

  it("logs when a code agent completes a task but no simplify sub-agent is configured", async () => {
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
      env: {
        PI_TEAM_MAILBOX_POLL_SECS: "1",
      },
    });

    await appendLeaderMailboxEntry("alpha", {
      sender: "code-1",
      subject: codeAgentCompletionSubject("pi-agents-7"),
      message: JSON.stringify({
        taskId: "pi-agents-7",
        agentName: "code-1",
        branchName: "task-pi-agents-7",
        worktreePath: "/workspace/project/.worktrees/task-pi-agents-7",
        commitId: "abc123def456",
        touchedFiles: ["src/example.ts"],
        summaryPath: "/tmp/task-pi-agents-7-summary.md",
        completedAt: "2026-04-08T20:00:00.000Z",
      }),
    });

    await waitFor(
      () =>
        lifecycleSink.addEvent.mock.calls.some((call) =>
          String(call[0]).includes(
            'Code agent code-1 completed task "pi-agents-7" but no simplify sub-agent is configured',
          ),
        ),
      "missing simplify-agent event",
    );

    expect(spawn.spawnChildRuntime).toHaveBeenCalledTimes(1);
    expect(spawn.runtimes).toHaveLength(1);
    expect(lifecycleSink.notify).not.toHaveBeenCalled();

    await manager.stopActiveTeam();
  });

  it("spawns a simplify child when a code-agent completion reaches the leader inbox", async () => {
    const spawn = createControlledSpawnStub();
    const manager = new TeamManager({
      spawnChildRuntime: spawn.spawnChildRuntime,
    });
    const lifecycleSink = createLifecycleSink();

    await manager.startTeam({
      snapshot: createSnapshot({
        agents: [
          {
            nameTemplate: "code",
            type: "code",
            promptTemplate: "code-prompt.md",
          },
        ],
        subAgents: [
          {
            nameTemplate: "simplify",
            type: "simplify",
            maxAllowed: 1,
            tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
            promptTemplate: "simplify-prompt.md",
          },
        ],
      }),
      lifecycleSink,
      env: {
        PI_TEAM_MAILBOX_POLL_SECS: "1",
      },
    });

    const completionReport = {
      taskId: "pi-agents-7",
      agentName: "code-1",
      branchName: "task-pi-agents-7",
      worktreePath: "/workspace/project/.worktrees/task-pi-agents-7",
      commitId: "abc123def456",
      touchedFiles: ["src/example.ts"],
      summaryPath: "/tmp/task-pi-agents-7-summary.md",
      completedAt: "2026-04-08T20:00:00.000Z",
    };
    await appendLeaderMailboxEntry("alpha", {
      sender: "code-1",
      subject: codeAgentCompletionSubject("pi-agents-7"),
      message: JSON.stringify(completionReport),
    });

    await waitFor(() => spawn.runtimes.length === 2, "simplify runtime spawn");

    const codeRuntime = spawn.runtimes[0];
    if (codeRuntime === undefined) {
      throw new Error("Expected a code runtime");
    }

    expect(codeRuntime.options.env?.[TEAM_CHILD_PROMPT_TEMPLATE_ENV_VAR]).toBe(
      "code-prompt.md",
    );
    expect(codeRuntime.options.env?.[TEAM_CHILD_PROMPT_ARGS_ENV_VAR]).toBe(
      JSON.stringify([
        "/workspace/project/.worktrees",
        join(TEST_ROOT, "alpha", "summaries"),
      ]),
    );

    const simplifyRuntime = spawn.runtimes[1];
    if (simplifyRuntime === undefined) {
      throw new Error("Expected a simplify runtime");
    }

    expect(simplifyRuntime.options).toMatchObject({
      role: "simplify",
      agentName: "simplify-1-pi-agents-7",
      taskId: "pi-agents-7",
      workspacePath: "/workspace/project",
      cwd: "/workspace/project/.worktrees/task-pi-agents-7",
    });
    expect(
      simplifyRuntime.options.env?.[TEAM_CHILD_PROMPT_TEMPLATE_ENV_VAR],
    ).toBe("simplify-prompt.md");
    expect(simplifyRuntime.options.env?.[TEAM_CHILD_PROMPT_ARGS_ENV_VAR]).toBe(
      JSON.stringify([
        "pi-agents-7",
        "/workspace/project/.worktrees/task-pi-agents-7",
        "- src/example.ts",
        join(TEST_ROOT, "alpha", "summaries"),
      ]),
    );
    expect(
      simplifyRuntime.options.env?.[TEAM_CHILD_SIMPLIFY_INPUT_ENV_VAR],
    ).toBe(JSON.stringify(completionReport));
    expect(lifecycleSink.addEvent).toHaveBeenCalledWith(
      'Started simplify agent simplify-1-pi-agents-7 (pid 4101) for task "pi-agents-7"',
    );

    await appendLeaderMailboxEntry("alpha", {
      sender: "simplify-1-pi-agents-7",
      subject: simplifyAgentCompletionSubject("pi-agents-7"),
      message: JSON.stringify({
        taskId: "pi-agents-7",
        agentName: "simplify-1-pi-agents-7",
        branchName: "task-pi-agents-7",
        worktreePath: "/workspace/project/.worktrees/task-pi-agents-7",
        commitId: "def456",
        touchedFiles: ["src/example.ts", "src/extra.ts"],
        summaryPath: "/tmp/task-pi-agents-7-summary.md",
        completedAt: "2026-04-08T20:05:00.000Z",
        changed: true,
      }),
    });

    await waitFor(
      () =>
        lifecycleSink.addEvent.mock.calls.some((call) =>
          String(call[0]).includes(
            'Simplify agent simplify-1-pi-agents-7 completed task "pi-agents-7" with 2 touched files',
          ),
        ),
      "simplify completion event",
    );

    simplifyRuntime.resolve(
      createExit(simplifyRuntime.options, {
        code: 0,
        expectedExit: true,
        crashed: false,
      }),
    );
    await flushMicrotasks();
    await manager.stopActiveTeam();
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

  it("pauses new task claiming without stopping active work", async () => {
    const spawn = createControlledSpawnStub();
    const manager = new TeamManager({
      spawnChildRuntime: spawn.spawnChildRuntime,
    });
    const lifecycleSink = createLifecycleSink();

    const startResult = await manager.startTeam({
      snapshot: createSnapshot({
        agents: [{ nameTemplate: "code", type: "code", count: 2 }],
      }),
      lifecycleSink,
    });

    expect(startResult.codeAgentCount).toBe(2);

    const pauseResult = await manager.pauseActiveTeam();

    expect(pauseResult).toEqual({
      teamName: "alpha",
      changed: true,
      ignored: false,
      targetNames: ["code-1", "code-2"],
    });
    expect(manager.getActiveTeam()).toMatchObject({
      paused: true,
    });
    expect(
      spawn.runtimes.every((runtime) => runtime.kill.mock.calls.length === 0),
    ).toBe(true);
    expect(lifecycleSink.setTeamStatus).toHaveBeenNthCalledWith(2, "Paused");
    expect(lifecycleSink.addEvent).toHaveBeenCalledWith(
      'Paused new task claiming for team "alpha"',
    );
    await expect(
      readMailboxEntries(teamMailboxInboxPath("alpha", "code-1")),
    ).resolves.toMatchObject([
      {
        sender: "leader",
        receiver: "code-1",
        subject: "broadcast",
        message: TEAM_CONTROL_MESSAGE_PAUSED,
      },
    ]);
    await expect(
      readMailboxEntries(teamMailboxInboxPath("alpha", "code-2")),
    ).resolves.toMatchObject([
      {
        sender: "leader",
        receiver: "code-2",
        subject: "broadcast",
        message: TEAM_CONTROL_MESSAGE_PAUSED,
      },
    ]);
  });

  it("does nothing when pausing a team that is already paused", async () => {
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

    await manager.pauseActiveTeam();

    await expect(manager.pauseActiveTeam()).resolves.toEqual({
      teamName: "alpha",
      changed: false,
      ignored: false,
      targetNames: ["code-1"],
    });
    expect(manager.getActiveTeam()).toMatchObject({
      paused: true,
    });
    expect(lifecycleSink.setTeamStatus).toHaveBeenCalledTimes(2);
    await expect(
      readMailboxEntries(teamMailboxInboxPath("alpha", "code-1")),
    ).resolves.toMatchObject([
      {
        sender: "leader",
        receiver: "code-1",
        subject: "broadcast",
        message: TEAM_CONTROL_MESSAGE_PAUSED,
      },
    ]);
  });

  it("continues delivering operator messages while paused", async () => {
    const spawn = createControlledSpawnStub();
    const manager = new TeamManager({
      spawnChildRuntime: spawn.spawnChildRuntime,
    });

    await manager.startTeam({
      snapshot: createSnapshot({
        agents: [{ nameTemplate: "code", type: "code" }],
      }),
    });

    await manager.pauseActiveTeam();

    await expect(
      manager.sendMessage("code-1", "stay on the current diff"),
    ).resolves.toMatchObject({
      ignored: false,
      subject: "send",
    });
    await expect(
      manager.broadcastMessage("status update", "code"),
    ).resolves.toMatchObject({
      ignored: false,
      targetNames: ["code-1"],
    });

    await expect(
      readMailboxEntries(teamMailboxInboxPath("alpha", "code-1")),
    ).resolves.toMatchObject([
      {
        sender: "leader",
        receiver: "code-1",
        subject: "broadcast",
        message: TEAM_CONTROL_MESSAGE_PAUSED,
      },
      {
        sender: "leader",
        receiver: "code-1",
        subject: "send",
        message: "stay on the current diff",
      },
      {
        sender: "leader",
        receiver: "code-1",
        subject: "broadcast",
        message: "status update",
      },
    ]);
  });

  it("resumes task claiming after a pause", async () => {
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

    await manager.pauseActiveTeam();
    const resumeResult = await manager.resumeActiveTeam();

    expect(resumeResult).toEqual({
      teamName: "alpha",
      changed: true,
      ignored: false,
      targetNames: ["code-1"],
    });
    expect(manager.getActiveTeam()).toMatchObject({
      paused: false,
    });
    expect(lifecycleSink.setTeamStatus).toHaveBeenNthCalledWith(3, "Active");
    expect(lifecycleSink.addEvent).toHaveBeenCalledWith(
      'Resumed task claiming for team "alpha"',
    );
    await expect(
      readMailboxEntries(teamMailboxInboxPath("alpha", "code-1")),
    ).resolves.toMatchObject([
      {
        sender: "leader",
        receiver: "code-1",
        subject: "broadcast",
        message: TEAM_CONTROL_MESSAGE_PAUSED,
      },
      {
        sender: "leader",
        receiver: "code-1",
        subject: "broadcast",
        message: TEAM_CONTROL_MESSAGE_RESUMED,
      },
    ]);
  });

  it("does nothing when resuming a team that is not paused", async () => {
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

    await expect(manager.resumeActiveTeam()).resolves.toEqual({
      teamName: "alpha",
      changed: false,
      ignored: false,
      targetNames: ["code-1"],
    });
    expect(manager.getActiveTeam()).toMatchObject({
      paused: false,
    });
    expect(lifecycleSink.setTeamStatus).toHaveBeenCalledTimes(1);
    await expect(
      readMailboxEntries(teamMailboxInboxPath("alpha", "code-1")),
    ).resolves.toEqual([]);
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

/**
 * Standing team lifecycle management.
 *
 * TF-13 starts the always-on code-agent processes for an active team,
 * tracks their lifecycle, surfaces exits/crashes to the leader UI, and
 * ensures one active team per leader session.
 */

import { validateTeamConfigValue } from "../config/loader.ts";
import {
  expandTeamConfig,
  type ResolvedAgentDef,
  TOOL_NAMES,
  type ToolName,
} from "../config/schema.ts";
import { pluralize } from "../pluralize.ts";
import type { TeamSnapshot } from "../storage/team-home.ts";
import {
  type SupportedThinkingLevel,
  validateThinkingLevel,
} from "./create-team.ts";
import {
  type ChildRuntimeExit,
  type SpawnChildRuntimeOptions,
  type SpawnedChildRuntime,
  spawnChildRuntime,
} from "./process-manager.ts";

export type TeamLifecycleNotificationType = "info" | "warning" | "error";

export type TeamLifecycleSink = {
  addEvent?: (event: string) => void;
  notify?: (message: string, type: TeamLifecycleNotificationType) => void;
  setTeamStatus?: (status: string) => void;
  updateAgent?: () => void;
};

export type ManagedCodeAgentStatus =
  | "running"
  | "stopping"
  | "stopped"
  | "crashed";

export type ManagedCodeAgent = {
  name: string;
  pid: number | undefined;
  status: ManagedCodeAgentStatus;
  startedAt: string;
  exit?: ChildRuntimeExit;
};

type ManagedCodeAgentRecord = ManagedCodeAgent & {
  runtime: SpawnedChildRuntime;
};

type ActiveTeamRuntime = {
  snapshot: TeamSnapshot;
  sink: TeamLifecycleSink;
  codeAgents: Map<string, ManagedCodeAgentRecord>;
  stopping: boolean;
};

export type StartTeamParams = {
  snapshot: TeamSnapshot;
  lifecycleSink?: TeamLifecycleSink;
  runtimeEntryPath?: string;
  execPath?: string;
  baseEnv?: NodeJS.ProcessEnv;
  supportsTypeScriptEntrypoints?: boolean;
  outputLimitBytes?: number;
  env?: Record<string, string>;
};

export type StartTeamResult = {
  teamName: string;
  codeAgentCount: number;
  codeAgents: ManagedCodeAgent[];
};

export type StopTeamResult = {
  teamName: string;
  stoppedAgentCount: number;
  crashedAgentCount: number;
};

export type TeamManagerDeps = {
  spawnChildRuntime?: (
    options: SpawnChildRuntimeOptions,
  ) => SpawnedChildRuntime;
  now?: () => Date;
};

export class TeamManagerError extends Error {
  readonly code: "team-active";

  constructor(
    code: TeamManagerError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TeamManagerError";
    this.code = code;
  }
}

export class TeamManager {
  readonly #spawnChildRuntime: NonNullable<
    TeamManagerDeps["spawnChildRuntime"]
  >;
  readonly #now: NonNullable<TeamManagerDeps["now"]>;

  #activeTeam: ActiveTeamRuntime | undefined;

  constructor(deps: TeamManagerDeps = {}) {
    this.#spawnChildRuntime = deps.spawnChildRuntime ?? spawnChildRuntime;
    this.#now = deps.now ?? (() => new Date());
  }

  isActive(): boolean {
    return this.#activeTeam !== undefined;
  }

  getActiveTeam():
    | { snapshot: TeamSnapshot; codeAgents: ManagedCodeAgent[] }
    | undefined {
    const activeTeam = this.#activeTeam;
    if (activeTeam === undefined) {
      return undefined;
    }

    return {
      snapshot: activeTeam.snapshot,
      codeAgents: [...activeTeam.codeAgents.values()].map(
        ({ runtime, ...agent }) => ({
          ...agent,
        }),
      ),
    };
  }

  async startTeam(params: StartTeamParams): Promise<StartTeamResult> {
    if (this.#activeTeam !== undefined) {
      throw new TeamManagerError(
        "team-active",
        `Team "${this.#activeTeam.snapshot.name}" is already active in this leader session`,
      );
    }

    const sink = params.lifecycleSink ?? {};
    const loadResult = validateTeamConfigValue(params.snapshot.config);
    const codeAgentDefinitions = expandTeamConfig(
      loadResult.config,
    ).agents.filter((definition) => definition.type === "code");

    const activeTeam: ActiveTeamRuntime = {
      snapshot: params.snapshot,
      sink,
      codeAgents: new Map(),
      stopping: false,
    };
    this.#activeTeam = activeTeam;

    sink.setTeamStatus?.("Active");

    try {
      for (const definition of codeAgentDefinitions) {
        const runtime = this.#spawnChildRuntime({
          role: "code",
          teamName: params.snapshot.name,
          agentName: definition.name,
          workspacePath: params.snapshot.workspacePath,
          cwd: params.snapshot.workspacePath,
          model: definition.model ?? params.snapshot.model,
          thinkingLevel: resolveThinkingLevel(
            definition,
            params.snapshot.thinkingLevel,
          ),
          tools: resolveTools(definition),
          env: { ...(params.env ?? {}) },
          runtimeEntryPath: params.runtimeEntryPath,
          execPath: params.execPath,
          baseEnv: params.baseEnv,
          supportsTypeScriptEntrypoints: params.supportsTypeScriptEntrypoints,
          outputLimitBytes: params.outputLimitBytes,
          expectedExitSignals: ["SIGINT", "SIGTERM"],
        });

        const record: ManagedCodeAgentRecord = {
          name: definition.name,
          pid: runtime.child.pid ?? undefined,
          status: "running",
          startedAt: this.#now().toISOString(),
          runtime,
        };

        activeTeam.codeAgents.set(definition.name, record);
        sink.addEvent?.(
          `Started code agent ${definition.name}${formatPidSuffix(record.pid)}`,
        );
        sink.updateAgent?.();
        this.#trackCodeAgentCompletion(activeTeam, definition.name, runtime);
      }

      if (codeAgentDefinitions.length === 0) {
        sink.addEvent?.("No standing code agents are configured for this team");
      } else {
        sink.addEvent?.(
          `Started ${codeAgentDefinitions.length} standing code agent${pluralize(
            codeAgentDefinitions.length,
          )}`,
        );
      }

      return {
        teamName: params.snapshot.name,
        codeAgentCount: activeTeam.codeAgents.size,
        codeAgents: this.getActiveTeam()?.codeAgents ?? [],
      };
    } catch (error) {
      activeTeam.stopping = true;
      await this.#stopRecords(activeTeam, [...activeTeam.codeAgents.values()]);
      this.#activeTeam = undefined;
      throw error;
    }
  }

  async stopActiveTeam(): Promise<StopTeamResult | undefined> {
    const activeTeam = this.#activeTeam;
    if (activeTeam === undefined) {
      return undefined;
    }

    activeTeam.stopping = true;
    activeTeam.sink.setTeamStatus?.("Stopping");

    const records = [...activeTeam.codeAgents.values()];
    await this.#stopRecords(activeTeam, records);

    const stoppedAgentCount = records.filter(
      (record) => record.status === "stopped",
    ).length;
    const crashedAgentCount = records.filter(
      (record) => record.status === "crashed",
    ).length;

    activeTeam.sink.setTeamStatus?.("Stopped");
    activeTeam.sink.addEvent?.(
      `Stopped ${stoppedAgentCount} code agent${pluralize(stoppedAgentCount)}`,
    );
    this.#activeTeam = undefined;

    return {
      teamName: activeTeam.snapshot.name,
      stoppedAgentCount,
      crashedAgentCount,
    };
  }

  #trackCodeAgentCompletion(
    activeTeam: ActiveTeamRuntime,
    agentName: string,
    runtime: SpawnedChildRuntime,
  ): void {
    void runtime.completion.then((exit) => {
      const record = activeTeam.codeAgents.get(agentName);
      if (record === undefined) {
        return;
      }

      record.exit = exit;
      record.status = exit.crashed ? "crashed" : "stopped";
      activeTeam.sink.updateAgent?.();

      if (exit.crashed) {
        const message = formatCrashMessage(exit);
        activeTeam.sink.addEvent?.(message);
        activeTeam.sink.notify?.(message, "error");
        return;
      }

      if (!activeTeam.stopping) {
        activeTeam.sink.addEvent?.(
          `Code agent ${agentName} exited${formatExitReason(exit)}`,
        );
      }
    });
  }

  async #stopRecords(
    activeTeam: ActiveTeamRuntime,
    records: ManagedCodeAgentRecord[],
  ): Promise<void> {
    await Promise.all(
      records.map(async (record) => {
        if (record.status === "stopped" || record.status === "crashed") {
          return;
        }

        record.status = "stopping";
        activeTeam.sink.updateAgent?.();
        record.runtime.child.kill("SIGTERM");
        await record.runtime.completion;
      }),
    );
  }
}

function resolveThinkingLevel(
  definition: ResolvedAgentDef,
  fallbackThinkingLevel: string,
): SupportedThinkingLevel {
  const thinkingLevel = definition.thinking ?? fallbackThinkingLevel;
  validateThinkingLevel(
    thinkingLevel,
    `Agent "${definition.name}" thinking level`,
  );
  return thinkingLevel;
}

function resolveTools(definition: ResolvedAgentDef): ToolName[] {
  return definition.tools === undefined
    ? [...TOOL_NAMES]
    : [...definition.tools];
}

function formatCrashMessage(exit: ChildRuntimeExit): string {
  const { agentName } = exit.metadata;
  const reason = formatExitReason(exit);
  const errorMessage = exit.error?.message;

  if (errorMessage !== undefined) {
    return `Code agent ${agentName} crashed${reason}: ${errorMessage}`;
  }

  return `Code agent ${agentName} crashed${reason}`;
}

function formatExitReason(exit: ChildRuntimeExit): string {
  if (exit.signal !== null) {
    return ` (signal ${exit.signal})`;
  }

  if (exit.code !== null) {
    return ` (exit code ${exit.code})`;
  }

  return "";
}

function formatPidSuffix(pid: number | undefined): string {
  return pid === undefined ? "" : ` (pid ${pid})`;
}

/**
 * Teams extension entry point.
 *
 * Registers the `/team` command family with the Pi extension API.
 * All team commands are rejected when this process is a member agent
 * rather than the leader session.
 */

import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { CommandRouter } from "./command-router.ts";
import { loadTeamConfigFile } from "./config/loader.ts";
import { createTeam, preflightCreateTeam } from "./leader/create-team.ts";
import {
  preflightRestartTeam,
  prepareRestartTeamLease,
} from "./leader/restart-team.ts";
import { TeamManager } from "./leader/team-manager.ts";
import {
  createTeamModeHelpText,
  createTeamModeHotkeysText,
  getTeamModeSubcommandCompletions,
  parseAgentMessageCommandArgs,
  parseBroadcastCommandArgs,
  parseCreateCommandArgs,
  parseRestartCommandArgs,
  resolveCreateCommandPaths,
  TeamModeState,
} from "./leader/team-state.ts";
import { pluralize } from "./pluralize.ts";
import { getTeamName, isMemberAgent } from "./roles.ts";

const EXTENSION_SOURCE_DIR = fileURLToPath(new URL("./", import.meta.url));
const DEFAULT_CONFIG_PATH = fileURLToPath(
  new URL("./config/default-team.yaml", import.meta.url),
);
const BUNDLED_PROMPT_TEMPLATES_DIR = fileURLToPath(
  new URL("./config/prompt-templates/", import.meta.url),
);

export default function teamsExtension(pi: ExtensionAPI): void {
  const router = new CommandRouter<ExtensionCommandContext>();
  const teamModeState = new TeamModeState();
  const teamManager = new TeamManager();

  router.register("create", {
    description: "Create a team from config and enter team mode",
    handler: (args, ctx) =>
      handleCreateCommand(ctx, teamManager, teamModeState, args, () =>
        pi.getThinkingLevel(),
      ),
  });

  router.register("stop", {
    description: "Stop the active team and leave team mode",
    handler: (_args, ctx) => handleStopCommand(ctx, teamManager, teamModeState),
  });

  router.register("pause", {
    description: "Pause new task claims without stopping the team",
    handler: (_args, ctx) =>
      handlePauseCommand(ctx, teamManager, teamModeState),
  });

  router.register("resume", {
    description: "Resume task claiming after a pause",
    handler: (_args, ctx) =>
      handleResumeCommand(ctx, teamManager, teamModeState),
  });

  router.register("restart", {
    description: "Restart a stored team from its persisted snapshot",
    handler: (args, ctx) =>
      handleRestartCommand(ctx, teamManager, teamModeState, args),
  });

  router.register("delete", {
    description: "Delete a stored team after it has been stopped",
    handler: (_args, ctx) =>
      handleDeleteCommand(ctx, teamManager, teamModeState),
  });

  router.register("send", {
    description: "Send a queued message to a named agent",
    handler: (args) => handleSendCommand(teamManager, args),
  });

  router.register("steer", {
    description: "Queue a steering message for a named agent",
    handler: (args) => handleSteerCommand(teamManager, args),
  });

  router.register("broadcast", {
    description: "Broadcast a message to standing code agents",
    handler: (args) => handleBroadcastCommand(teamManager, args),
  });

  router.register("help", {
    description: "Show available /team subcommands",
    handler: async () => createTeamModeHelpText(),
  });

  router.register("hotkeys", {
    description: "Show team-mode shortcut help",
    handler: async () => createTeamModeHotkeysText(),
  });

  router.register("exit", {
    description: "Explain how to leave team mode safely",
    handler: (_args, ctx) => handleExitCommand(ctx, teamManager, teamModeState),
  });

  pi.registerCommand("team", {
    description: "Manage coding teams (create, start, stop, …)",

    getArgumentCompletions: (prefix: string) => {
      if (isMemberAgent()) return null;
      if (teamModeState.isActive()) {
        return getTeamModeSubcommandCompletions(prefix);
      }
      return router.getCompletions(prefix);
    },

    handler: async (args, ctx) => {
      // Reject team commands in member-agent processes.
      if (isMemberAgent()) {
        const teamName = getTeamName();
        const context = teamName
          ? ` (running as member of team "${teamName}")`
          : "";
        ctx.ui.notify(
          `/team commands are only available in the leader session${context}. ` +
            `This process is a member agent and cannot issue team commands.`,
          "error",
        );
        return;
      }

      try {
        const response = await router.dispatch(args ?? "", ctx);
        if (response !== undefined) {
          ctx.ui.notify(response, "info");
        }
      } catch (err: unknown) {
        ctx.ui.notify(getErrorMessage(err), "error");
      }
    },
  });

  // SIGINT / SIGTERM best-effort shutdown hook (TF-27 will flesh this out).
  // Registered here so the extension owns the signal handlers from the start.
  pi.on("session_shutdown", async () => {
    await teamManager.stopActiveTeam();
  });
}

async function handleCreateCommand(
  ctx: ExtensionCommandContext,
  teamManager: TeamManager,
  teamModeState: TeamModeState,
  args: string,
  getThinkingLevel: () => string,
): Promise<string> {
  if (teamModeState.isActive()) {
    const activeTeam = teamModeState.getActiveTeam();
    return formatAlreadyActiveMessage(activeTeam?.snapshot.name);
  }

  const parsed = parseCreateCommandArgs(args);
  const paths = resolveCreateCommandPaths(ctx.cwd, parsed.name, {
    configPath: parsed.configPath,
    worktreeDir: parsed.worktreeDir,
  });
  const loadResult = await loadTeamConfigFile(
    paths.configPath ?? DEFAULT_CONFIG_PATH,
    BUNDLED_PROMPT_TEMPLATES_DIR,
  );

  const currentModel = ctx.model
    ? `${ctx.model.provider}/${ctx.model.id}`
    : undefined;
  const modelReference = parsed.model ?? currentModel;
  if (modelReference === undefined) {
    throw new Error(
      "No active model is selected. Choose one with /model before creating a team, or pass --model provider/model-id.",
    );
  }

  const thinkingLevel = parsed.thinkingLevel ?? getThinkingLevel();
  const preflight = await preflightCreateTeam({
    name: parsed.name,
    workspacePath: ctx.cwd,
    worktreeDir: paths.worktreeDir,
    model: modelReference,
    thinkingLevel,
    config: loadResult.config,
    configSourcePath: paths.configPath,
    extensionSourceDir: EXTENSION_SOURCE_DIR,
    availableModels: ctx.modelRegistry.getAvailable(),
  });

  const snapshot = await createTeam({
    name: parsed.name,
    workspacePath: preflight.workspacePath,
    worktreeDir: preflight.worktreeDir,
    model: modelReference,
    thinkingLevel,
    configSourcePath: paths.configPath,
    config: preflight.config,
    extensionSourceDir: EXTENSION_SOURCE_DIR,
  });

  await teamModeState.activate(ctx, { snapshot });

  try {
    const startResult = await teamManager.startTeam({
      snapshot: {
        ...snapshot,
        config: preflight.config,
      },
      lifecycleSink: createLifecycleSink(ctx, teamModeState),
    });

    return formatSuccessMessage(
      `Created team "${snapshot.name}", started ${startResult.codeAgentCount} code agent${pluralize(startResult.codeAgentCount)}, and entered team mode.`,
      preflight.warnings,
    );
  } catch (error) {
    await teamModeState.deactivate(ctx);
    throw error;
  }
}

async function handleStopCommand(
  ctx: ExtensionCommandContext,
  teamManager: TeamManager,
  teamModeState: TeamModeState,
): Promise<string> {
  const activeTeam = teamModeState.getActiveTeam();
  if (activeTeam === undefined) {
    return "No team is currently active.";
  }

  const stopResult = await teamManager.stopActiveTeam();
  await teamModeState.deactivate(ctx);
  const stoppedAgentCount = stopResult?.stoppedAgentCount ?? 0;
  return `Stopped team "${activeTeam.snapshot.name}", terminated ${stoppedAgentCount} code agent${pluralize(stoppedAgentCount)}, and left team mode.`;
}

async function handleSendCommand(
  teamManager: TeamManager,
  args: string,
): Promise<string> {
  const parsed = parseAgentMessageCommandArgs(args, "send");
  const result = await teamManager.sendMessage(
    parsed.agentName,
    parsed.message,
  );

  if (result.ignored) {
    return `Ignoring /team send because team "${result.teamName}" is stopping.`;
  }

  return `Queued message for agent "${parsed.agentName}".`;
}

async function handleSteerCommand(
  teamManager: TeamManager,
  args: string,
): Promise<string> {
  const parsed = parseAgentMessageCommandArgs(args, "steer");
  const result = await teamManager.steerMessage(
    parsed.agentName,
    parsed.message,
  );

  if (result.ignored) {
    return `Ignoring /team steer because team "${result.teamName}" is stopping.`;
  }

  return `Queued steering message for agent "${parsed.agentName}". It will be delivered between turns after the current tool calls finish.`;
}

async function handleBroadcastCommand(
  teamManager: TeamManager,
  args: string,
): Promise<string> {
  const parsed = parseBroadcastCommandArgs(args);
  const result = await teamManager.broadcastMessage(
    parsed.message,
    parsed.agentType,
  );

  if (result.ignored) {
    return `Ignoring /team broadcast because team "${result.teamName}" is stopping.`;
  }

  if (result.targetNames.length === 0) {
    return `No standing ${result.agentType} agents are running to receive the broadcast.`;
  }

  return `Queued broadcast message for ${result.targetNames.length} ${result.agentType} agent${pluralize(result.targetNames.length)}.`;
}

async function handlePauseCommand(
  ctx: ExtensionCommandContext,
  teamManager: TeamManager,
  teamModeState: TeamModeState,
): Promise<string> {
  void ctx;
  void teamManager;
  void teamModeState;
  return notImplementedMessage("pause", "TF-15");
}

async function handleResumeCommand(
  ctx: ExtensionCommandContext,
  teamManager: TeamManager,
  teamModeState: TeamModeState,
): Promise<string> {
  void ctx;
  void teamManager;
  void teamModeState;
  return notImplementedMessage("resume", "TF-15");
}

async function handleRestartCommand(
  ctx: ExtensionCommandContext,
  teamManager: TeamManager,
  teamModeState: TeamModeState,
  args: string,
): Promise<string> {
  if (teamModeState.isActive()) {
    const activeTeam = teamModeState.getActiveTeam();
    return formatAlreadyActiveMessage(activeTeam?.snapshot.name);
  }

  const parsed = parseRestartCommandArgs(args);
  const preflight = await preflightRestartTeam({
    teamName: parsed.teamName,
    currentWorkspacePath: ctx.cwd,
    availableModels: ctx.modelRegistry.getAvailable(),
  });
  const leaseResult = await prepareRestartTeamLease({
    teamName: parsed.teamName,
  });

  await teamModeState.activate(ctx, {
    snapshot: preflight.snapshot,
  });

  try {
    const startResult = await teamManager.startTeam({
      snapshot: preflight.snapshot,
      lifecycleSink: createLifecycleSink(ctx, teamModeState),
    });

    return formatSuccessMessage(
      `${formatRestartSuccessMessage(preflight.snapshot.name, leaseResult)} Started ${startResult.codeAgentCount} code agent${pluralize(startResult.codeAgentCount)}.`,
      preflight.warnings,
    );
  } catch (error) {
    await teamModeState.deactivate(ctx);
    throw error;
  }
}

async function handleDeleteCommand(
  ctx: ExtensionCommandContext,
  teamManager: TeamManager,
  teamModeState: TeamModeState,
): Promise<string> {
  void ctx;
  void teamManager;
  void teamModeState;
  return notImplementedMessage("delete", "TF-25");
}

async function handleExitCommand(
  ctx: ExtensionCommandContext,
  teamManager: TeamManager,
  teamModeState: TeamModeState,
): Promise<string> {
  void ctx;
  void teamManager;

  if (!teamModeState.isActive()) {
    return "Team mode is not active.";
  }

  return "Run /team stop first. `/team exit` does not leave an active team running in the background.";
}

function createLifecycleSink(
  ctx: ExtensionCommandContext,
  teamModeState: TeamModeState,
) {
  return {
    addEvent: (event: string) => teamModeState.addEvent(event),
    notify: (message: string, type: "info" | "warning" | "error") =>
      ctx.ui.notify(message, type),
    setTeamStatus: (status: string) => teamModeState.setTeamStatus(status),
    updateAgent: () => teamModeState.updateAgent(),
  };
}

function formatAlreadyActiveMessage(teamName: string | undefined): string {
  return `Team "${teamName ?? "unknown"}" is already active in this session`;
}

function formatSuccessMessage(
  message: string,
  warnings: readonly string[],
): string {
  if (warnings.length === 0) {
    return message;
  }

  return [
    message,
    "",
    "Warnings:",
    ...warnings.map((warning) => `- ${warning}`),
  ].join("\n");
}

function formatRestartSuccessMessage(
  teamName: string,
  leaseResult: "claimed" | "already-owned" | "recovered-stale",
): string {
  switch (leaseResult) {
    case "claimed":
      return `Restarted team "${teamName}" and entered team mode.`;
    case "already-owned":
      return `Restarted team "${teamName}" and entered team mode using the existing runtime lease.`;
    case "recovered-stale":
      return `Restarted team "${teamName}" and entered team mode after recovering a stale runtime lease.`;
  }
}

function notImplementedMessage(commandName: string, taskId: string): string {
  return `/team ${commandName} is reserved for a later slice (${taskId}) and is not implemented yet.`;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

export type { CommandRouter };

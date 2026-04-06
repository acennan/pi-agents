import { join, resolve } from "node:path";
import {
  CustomEditor,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionUIContext,
  type KeybindingsManager,
} from "@mariozechner/pi-coding-agent";
import {
  type AutocompleteItem,
  CombinedAutocompleteProvider,
  type EditorTheme,
  Key,
  matchesKey,
  type SlashCommand,
  type TUI,
} from "@mariozechner/pi-tui";
import { type TeamSnapshot, teamDir } from "../storage/team-home.ts";
import { removeRuntimeLock } from "../storage/team-lease.ts";
import { TeamDashboardComponent } from "./team-dashboard.ts";

export const TEAM_MODE_FREE_TEXT_MESSAGE =
  "Use /team send <agent> <message> to communicate with agents";
export const TEAM_MODE_SLASH_COMMAND_MESSAGE =
  "Only /team commands are available during team mode";

export type TeamModeSubcommand = {
  readonly name: string;
  readonly description: string;
};

export const TEAM_MODE_OPERATOR_SUBCOMMANDS: readonly TeamModeSubcommand[] = [
  {
    name: "send",
    description: "Send a queued message to a named agent",
  },
  {
    name: "steer",
    description: "Queue a steering message for a named agent",
  },
  {
    name: "broadcast",
    description: "Broadcast a message to standing code agents",
  },
  {
    name: "stop",
    description: "Stop the active team and leave team mode",
  },
  {
    name: "pause",
    description: "Pause new task claims without stopping the team",
  },
  {
    name: "resume",
    description: "Resume task claiming after a pause",
  },
  {
    name: "restart",
    description: "Restart a stored team from its persisted snapshot",
  },
  {
    name: "delete",
    description: "Delete a stored team after it has been stopped",
  },
  {
    name: "help",
    description: "Show team-mode operator commands",
  },
  {
    name: "hotkeys",
    description: "Show team-mode shortcut help",
  },
  {
    name: "exit",
    description: "Explain how to leave team mode safely",
  },
] as const;

export type TeamModeInputValidation =
  | { kind: "accept" }
  | { kind: "ignore" }
  | {
      kind: "reject";
      message: string;
      type: "info" | "warning" | "error";
    };

export type ParsedCreateCommandArgs = {
  name: string;
  configPath?: string;
  worktreeDir?: string;
  model?: string;
  thinkingLevel?: string;
};

export type ParsedRestartCommandArgs = {
  teamName: string;
};

export type ParsedAgentMessageCommandArgs = {
  agentName: string;
  message: string;
};

export type ParsedBroadcastCommandArgs = {
  agentType?: "code";
  message: string;
};

export type ActiveTeamMode = {
  snapshot: TeamSnapshot;
};

export type TeamModeStateDeps = {
  removeRuntimeLock?: typeof removeRuntimeLock;
};

export function createDefaultWorktreeDir(teamName: string): string {
  return join(teamDir(teamName), "worktrees");
}

export function createTeamModeHelpText(): string {
  const lines = ["Team-mode /team commands:", ""];

  for (const { name, description } of TEAM_MODE_OPERATOR_SUBCOMMANDS) {
    lines.push(`  ${name.padEnd(12)} ${description}`);
  }

  return lines.join("\n");
}

export function createTeamModeHotkeysText(): string {
  return [
    "Team-mode shortcut help:",
    "",
    "  Enter        Submit the current /team command",
    "  Shift+Enter  Insert a newline in the editor",
    "  Escape       Keep Pi's normal interrupt/cancel behaviour",
    "  Tab          Reserved for dashboard/editor focus once the dashboard is enabled",
  ].join("\n");
}

export function getTeamModeSubcommandCompletions(
  prefix: string,
): AutocompleteItem[] | null {
  const items = TEAM_MODE_OPERATOR_SUBCOMMANDS.filter(({ name }) =>
    name.startsWith(prefix),
  ).map(({ name, description }) => ({
    value: name,
    label: `${name} — ${description}`,
  }));

  return items.length > 0 ? items : null;
}

export function createTeamModeAutocompleteProvider(
  basePath: string,
): CombinedAutocompleteProvider {
  const commands: SlashCommand[] = [
    {
      name: "team",
      description: "Control the active team",
      getArgumentCompletions: (prefix: string) =>
        getTeamModeSubcommandCompletions(prefix),
    },
  ];

  return new CombinedAutocompleteProvider(commands, basePath);
}

export function validateTeamModeInput(text: string): TeamModeInputValidation {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return { kind: "ignore" };
  }

  if (!trimmed.startsWith("/")) {
    return {
      kind: "reject",
      message: TEAM_MODE_FREE_TEXT_MESSAGE,
      type: "info",
    };
  }

  if (!/^\/team(?:\s|$)/.test(trimmed)) {
    return {
      kind: "reject",
      message: TEAM_MODE_SLASH_COMMAND_MESSAGE,
      type: "warning",
    };
  }

  return { kind: "accept" };
}

export function splitCommandArgs(rawArgs: string): string[] {
  const tokens: string[] = [];
  const tokenPattern =
    /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;

  for (const match of rawArgs.matchAll(tokenPattern)) {
    const [, doubleQuoted, singleQuoted, bare] = match;
    const token = doubleQuoted ?? singleQuoted ?? bare;
    if (token !== undefined) {
      tokens.push(token.replace(/\\([\\"'])/g, "$1"));
    }
  }

  return tokens;
}

type ParsedFlagEntry = {
  name: string;
  value?: string;
};

type ParsedKeyValueFlags = {
  tokens: string[];
  positionals: string[];
  entries: ParsedFlagEntry[];
};

function parseKeyValueFlags(args: string[]): ParsedKeyValueFlags {
  const positionals: string[] = [];
  const entries: ParsedFlagEntry[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) {
      continue;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) {
      entries.push({ name: token });
      continue;
    }

    entries.push({ name: token, value: next });
    index += 1;
  }

  return {
    tokens: [...args],
    positionals,
    entries,
  };
}

function buildCreateArgs(flags: ParsedKeyValueFlags): ParsedCreateCommandArgs {
  if (flags.positionals.length > 0) {
    throw new Error(`Unknown /team create option: ${flags.positionals[0]}`);
  }

  const result: ParsedCreateCommandArgs = { name: "" };

  for (const entry of flags.entries) {
    switch (entry.name) {
      case "--name":
        if (entry.value === undefined) {
          throw new Error("/team create requires a value after --name");
        }
        result.name = entry.value;
        break;
      case "--config":
        if (entry.value === undefined) {
          throw new Error("/team create requires a value after --config");
        }
        result.configPath = entry.value;
        break;
      case "--worktree-dir":
        if (entry.value === undefined) {
          throw new Error("/team create requires a value after --worktree-dir");
        }
        result.worktreeDir = entry.value;
        break;
      case "--model":
        if (entry.value === undefined) {
          throw new Error("/team create requires a value after --model");
        }
        result.model = entry.value;
        break;
      case "--thinking":
        if (entry.value === undefined) {
          throw new Error("/team create requires a value after --thinking");
        }
        result.thinkingLevel = entry.value;
        break;
      default:
        throw new Error(`Unknown /team create option: ${entry.name}`);
    }
  }

  if (result.name.trim().length === 0) {
    throw new Error("/team create requires --name <team-name>");
  }

  return result;
}

function buildRestartArgs(
  flags: ParsedKeyValueFlags,
): ParsedRestartCommandArgs {
  const [teamName] = flags.tokens;

  if (teamName === undefined || teamName.trim().length === 0) {
    throw new Error("/team restart requires <team-name>");
  }

  if (flags.tokens.length > 1) {
    throw new Error("/team restart accepts exactly one <team-name>");
  }

  return { teamName };
}

function isAgentTypeToken(
  value: string,
): value is "code" | "simplify" | "review" | "test" | "commit" {
  return (
    value === "code" ||
    value === "simplify" ||
    value === "review" ||
    value === "test" ||
    value === "commit"
  );
}

export function parseCreateCommandArgs(
  rawArgs: string,
): ParsedCreateCommandArgs {
  return buildCreateArgs(parseKeyValueFlags(splitCommandArgs(rawArgs)));
}

export function parseRestartCommandArgs(
  rawArgs: string,
): ParsedRestartCommandArgs {
  return buildRestartArgs(parseKeyValueFlags(splitCommandArgs(rawArgs)));
}

export function parseAgentMessageCommandArgs(
  rawArgs: string,
  commandName: "send" | "steer",
): ParsedAgentMessageCommandArgs {
  const [agentName, ...messageParts] = splitCommandArgs(rawArgs);

  if (agentName === undefined || messageParts.length === 0) {
    throw new Error(`/team ${commandName} requires <agent-name> <message>`);
  }

  return {
    agentName,
    message: messageParts.join(" "),
  };
}

export function parseBroadcastCommandArgs(
  rawArgs: string,
): ParsedBroadcastCommandArgs {
  const [firstToken, ...restTokens] = splitCommandArgs(rawArgs);

  if (firstToken === undefined) {
    throw new Error("/team broadcast requires [code] <message>");
  }

  if (isAgentTypeToken(firstToken)) {
    if (firstToken !== "code") {
      throw new Error(
        `Unsupported /team broadcast target type "${firstToken}". Only "code" is allowed.`,
      );
    }

    if (restTokens.length === 0) {
      throw new Error("/team broadcast code requires <message>");
    }

    return {
      agentType: "code",
      message: restTokens.join(" "),
    };
  }

  return {
    message: [firstToken, ...restTokens].join(" "),
  };
}

export class TeamModeEditor extends CustomEditor {
  readonly #notify: ExtensionUIContext["notify"];

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    options: {
      notify: ExtensionUIContext["notify"];
      workspacePath: string;
    },
  ) {
    super(tui, theme, keybindings);
    this.#notify = options.notify;
    this.setAutocompleteProvider(
      createTeamModeAutocompleteProvider(options.workspacePath),
    );
  }

  override handleInput(data: string): void {
    if (matchesKey(data, Key.enter) && !this.isShowingAutocomplete()) {
      const validation = validateTeamModeInput(
        this.getExpandedText?.() ?? this.getText(),
      );

      if (validation.kind === "ignore") {
        return;
      }

      if (validation.kind === "reject") {
        this.#notify(validation.message, validation.type);
        return;
      }
    }

    super.handleInput(data);
  }
}

export class TeamModeState {
  readonly #removeRuntimeLock: typeof removeRuntimeLock;

  #activeTeam: ActiveTeamMode | undefined;
  #dashboard: TeamDashboardComponent | undefined;
  #dashboardEvents: string[] = [];
  #dashboardTeamStatus = "Active";

  constructor(deps: TeamModeStateDeps = {}) {
    this.#removeRuntimeLock = deps.removeRuntimeLock ?? removeRuntimeLock;
  }

  isActive(): boolean {
    return this.#activeTeam !== undefined;
  }

  getActiveTeam(): ActiveTeamMode | undefined {
    return this.#activeTeam;
  }

  addEvent(event: string): void {
    this.#dashboardEvents.push(event);
    this.#dashboard?.addEvent(event);
  }

  setTeamStatus(status: string): void {
    this.#dashboardTeamStatus = status;
    this.#dashboard?.setTeamStatus(status);
  }

  updateAgent(): void {
    this.#dashboard?.updateAgent();
  }

  updateTask(): void {
    this.#dashboard?.updateTask();
  }

  async activate(
    ctx: ExtensionContext | ExtensionCommandContext,
    activeTeam: ActiveTeamMode,
  ): Promise<void> {
    this.#activeTeam = activeTeam;
    this.#dashboard = undefined;
    this.#dashboardEvents = [];
    this.#dashboardTeamStatus = "Active";

    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) =>
        new TeamModeEditor(tui, theme, keybindings, {
          notify: (message, type) => ctx.ui.notify(message, type),
          workspacePath: ctx.cwd,
        }),
    );

    ctx.ui.setWidget("team-dashboard", (tui, theme) => {
      const dashboard = new TeamDashboardComponent(
        tui,
        theme,
        activeTeam.snapshot.name,
        this.#dashboardTeamStatus,
      );
      this.#dashboard = dashboard;
      for (const event of this.#dashboardEvents) {
        dashboard.addEvent(event);
      }
      return dashboard;
    });

    this.addEvent(`Entered team mode for ${activeTeam.snapshot.name}`);

    ctx.ui.setStatus(
      "team-mode",
      ctx.ui.theme.fg("accent", `team:${activeTeam.snapshot.name}`),
    );
  }

  async deactivate(
    ctx: ExtensionContext | ExtensionCommandContext,
  ): Promise<void> {
    const activeTeam = this.#activeTeam;

    if (activeTeam !== undefined) {
      await this.#removeRuntimeLock(activeTeam.snapshot.name);
    }

    ctx.ui.setEditorComponent(undefined);
    ctx.ui.setWidget("team-dashboard", undefined);
    ctx.ui.setStatus("team-mode", undefined);
    this.#dashboard = undefined;
    this.#dashboardEvents = [];
    this.#dashboardTeamStatus = "Active";
    this.#activeTeam = undefined;
  }
}

export function resolveCreateCommandPaths(
  cwd: string,
  teamName: string,
  options: {
    configPath?: string;
    worktreeDir?: string;
  },
): {
  configPath?: string;
  worktreeDir: string;
} {
  return {
    configPath:
      options.configPath !== undefined
        ? resolve(cwd, options.configPath)
        : undefined,
    worktreeDir: resolve(
      cwd,
      options.worktreeDir ?? createDefaultWorktreeDir(teamName),
    ),
  };
}

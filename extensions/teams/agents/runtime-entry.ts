/**
 * SDK child-runtime bootstrap entrypoint for team member processes.
 *
 * TF-11 defines the contract between the leader and child runtimes:
 * - the leader passes role/team/task/env arguments explicitly
 * - the child bootstraps its own SDK session from those arguments
 * - the process is spawnable as runnable JavaScript in production packages,
 *   while local Bun-based development can fall back to the TypeScript source
 * - later slices can layer role-specific work loops on top of this bootstrap
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  type CreateAgentSessionOptions,
  createAgentSession,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { TOOL_NAMES, type ToolName } from "../config/schema.ts";
import {
  SUPPORTED_THINKING_LEVELS,
  type SupportedThinkingLevel,
} from "../leader/create-team.ts";
import type { ProcessRole } from "../roles.ts";

export const TEAM_CHILD_RUNTIME_READY_EVENT = "team-child-ready";
export const TEAM_CHILD_ROLE_ENV_VAR = "PI_TEAM_ROLE";
export const TEAM_CHILD_TEAM_NAME_ENV_VAR = "PI_TEAM_NAME";
export const TEAM_CHILD_AGENT_NAME_ENV_VAR = "PI_TEAM_AGENT_NAME";
export const TEAM_CHILD_TASK_ID_ENV_VAR = "PI_TEAM_TASK_ID";

export type MemberProcessRole = Exclude<ProcessRole, "leader">;

export type TeamChildRuntimeArgs = {
  role: MemberProcessRole;
  teamName: string;
  agentName: string;
  workspacePath: string;
  cwd: string;
  taskId?: string;
  modelReference: string;
  thinkingLevel: SupportedThinkingLevel;
  tools: ToolName[];
  env: Record<string, string>;
};

export type TeamChildRuntimeReadyEvent = {
  type: typeof TEAM_CHILD_RUNTIME_READY_EVENT;
  pid: number;
  role: MemberProcessRole;
  teamName: string;
  agentName: string;
  taskId?: string;
};

type AgentSessionLike = Awaited<
  ReturnType<typeof createAgentSession>
>["session"];

type SessionFactory = (
  options: CreateAgentSessionOptions,
) => Promise<{ session: AgentSessionLike }>;

export type BootstrapTeamChildRuntimeDependencies = {
  resolveModel?: (
    modelReference: string,
    modelRegistry: ModelRegistry,
  ) => Model<Api>;
  createSession?: SessionFactory;
  createTools?: (cwd: string, toolNames: readonly ToolName[]) => RuntimeTool[];
};

export type TeamChildRuntimeBootstrap = {
  args: TeamChildRuntimeArgs;
  session: AgentSessionLike;
};

export type RunTeamChildRuntimeOptions =
  BootstrapTeamChildRuntimeDependencies & {
    argv?: readonly string[];
    stdout?: Pick<NodeJS.WritableStream, "write">;
    onReady?: (context: TeamChildRuntimeRunContext) => Promise<void> | void;
    installSignalHandlers?: boolean;
  };

export type TeamChildRuntimeRunContext = TeamChildRuntimeBootstrap & {
  requestShutdown: () => void;
  shutdownSignal: Promise<void>;
};

export class TeamChildRuntimeError extends Error {
  readonly code:
    | "invalid-arg"
    | "invalid-model"
    | "missing-arg"
    | "unsupported-role";

  constructor(
    code: TeamChildRuntimeError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TeamChildRuntimeError";
    this.code = code;
  }
}

type RuntimeTool = NonNullable<CreateAgentSessionOptions["tools"]>[number];

const TOOL_FACTORIES: Record<ToolName, (cwd: string) => RuntimeTool> = {
  read: (cwd) => createReadTool(cwd),
  bash: (cwd) => createBashTool(cwd),
  edit: (cwd) => createEditTool(cwd),
  write: (cwd) => createWriteTool(cwd),
  grep: (cwd) => createGrepTool(cwd),
  find: (cwd) => createFindTool(cwd),
  ls: (cwd) => createLsTool(cwd),
};

const defaultCreateSession: SessionFactory = async (options) => {
  const { session } = await createAgentSession(options);
  return { session };
};

/**
 * Parse the CLI arguments passed by the leader into a validated child-runtime
 * configuration.
 */
export function parseTeamChildRuntimeArgs(
  argv: readonly string[],
): TeamChildRuntimeArgs {
  let role: string | undefined;
  let teamName: string | undefined;
  let agentName: string | undefined;
  let workspacePath: string | undefined;
  let cwd: string | undefined;
  let taskId: string | undefined;
  let modelReference: string | undefined;
  let thinkingLevel: string | undefined;
  let toolsCsv: string | undefined;
  const env: Record<string, string> = {};

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }

    switch (arg) {
      case "--role":
        role = readFlagValue(argv, ++index, arg);
        break;
      case "--team":
        teamName = readFlagValue(argv, ++index, arg);
        break;
      case "--agent":
        agentName = readFlagValue(argv, ++index, arg);
        break;
      case "--workspace":
        workspacePath = readFlagValue(argv, ++index, arg);
        break;
      case "--cwd":
        cwd = readFlagValue(argv, ++index, arg);
        break;
      case "--task":
        taskId = readFlagValue(argv, ++index, arg);
        break;
      case "--model":
        modelReference = readFlagValue(argv, ++index, arg);
        break;
      case "--thinking":
        thinkingLevel = readFlagValue(argv, ++index, arg);
        break;
      case "--tools":
        toolsCsv = readFlagValue(argv, ++index, arg);
        break;
      case "--env": {
        const entry = readFlagValue(argv, ++index, arg);
        const equalsIndex = entry.indexOf("=");
        if (equalsIndex <= 0) {
          throw new TeamChildRuntimeError(
            "invalid-arg",
            `Invalid --env value "${entry}". Expected KEY=value`,
          );
        }

        const key = entry.slice(0, equalsIndex);
        const value = entry.slice(equalsIndex + 1);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          throw new TeamChildRuntimeError(
            "invalid-arg",
            `Invalid environment variable name "${key}"`,
          );
        }
        env[key] = value;
        break;
      }
      default:
        throw new TeamChildRuntimeError(
          "invalid-arg",
          `Unknown runtime argument "${arg}"`,
        );
    }
  }

  const resolvedWorkspacePath = resolve(
    requireRuntimeArg(workspacePath, "--workspace"),
  );
  const resolvedCwd = resolve(cwd ?? resolvedWorkspacePath);

  return {
    role: parseMemberRole(requireRuntimeArg(role, "--role")),
    teamName: requireNonEmptyValue(teamName, "--team"),
    agentName: requireNonEmptyValue(agentName, "--agent"),
    workspacePath: resolvedWorkspacePath,
    cwd: resolvedCwd,
    taskId: taskId ? requireNonEmptyValue(taskId, "--task") : undefined,
    modelReference: validateModelReference(
      requireRuntimeArg(modelReference, "--model"),
    ),
    thinkingLevel: parseThinkingLevel(
      requireRuntimeArg(thinkingLevel, "--thinking"),
    ),
    tools: parseToolNames(requireRuntimeArg(toolsCsv, "--tools")),
    env,
  };
}

/** Create concrete Pi tool instances for the provided tool names. */
export function createRuntimeTools(
  cwd: string,
  toolNames: readonly ToolName[],
): RuntimeTool[] {
  return toolNames.map((toolName) => {
    const factory = TOOL_FACTORIES[toolName];
    return factory(cwd);
  });
}

/** Resolve a provider/model-id reference through the runtime's model registry. */
export function resolveRuntimeModel(
  modelReference: string,
  modelRegistry: ModelRegistry,
): Model<Api> {
  const [provider, modelId] = splitModelReference(modelReference);
  const model = modelRegistry.find(provider, modelId);
  if (model !== undefined) {
    return model;
  }

  throw new TeamChildRuntimeError(
    "invalid-model",
    `Model "${modelReference}" is not available in this child runtime`,
  );
}

/**
 * Bootstrap a team child runtime from parsed args or raw argv.
 *
 * This creates an SDK-backed in-memory session bound to the requested cwd,
 * model, thinking level, and explicit tool list.
 */
export async function bootstrapTeamChildRuntime(
  input: TeamChildRuntimeArgs | readonly string[],
  dependencies: BootstrapTeamChildRuntimeDependencies = {},
): Promise<TeamChildRuntimeBootstrap> {
  const args = isTeamChildRuntimeArgv(input)
    ? parseTeamChildRuntimeArgs(input)
    : input;
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const resolveModel = dependencies.resolveModel ?? resolveRuntimeModel;
  const createTools = dependencies.createTools ?? createRuntimeTools;
  const createSession = dependencies.createSession ?? defaultCreateSession;

  const model = resolveModel(args.modelReference, modelRegistry);
  const tools = createTools(args.cwd, args.tools);
  const { session } = await createSession({
    authStorage,
    cwd: args.cwd,
    model,
    modelRegistry,
    sessionManager: SessionManager.inMemory(args.cwd),
    settingsManager: SettingsManager.inMemory(),
    thinkingLevel: args.thinkingLevel,
    tools,
  });

  return {
    args,
    session,
  };
}

/**
 * CLI entrypoint used by spawned child processes.
 *
 * It bootstraps the SDK session, emits a single structured ready event on
 * stdout, and then waits until shutdown is requested or a termination signal
 * arrives.
 */
export async function runTeamChildRuntime(
  options: RunTeamChildRuntimeOptions = {},
): Promise<void> {
  const {
    argv = process.argv.slice(2),
    stdout = process.stdout,
    onReady,
    installSignalHandlers = true,
    ...dependencies
  } = options;
  const bootstrap = await bootstrapTeamChildRuntime(argv, dependencies);

  let resolveShutdown!: () => void;
  const shutdownSignal = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });

  const cleanupSignals = installSignalHandlers
    ? installShutdownSignalHandlers(resolveShutdown)
    : () => {};

  try {
    writeLifecycleEvent(stdout, {
      type: TEAM_CHILD_RUNTIME_READY_EVENT,
      pid: process.pid,
      role: bootstrap.args.role,
      teamName: bootstrap.args.teamName,
      agentName: bootstrap.args.agentName,
      ...(bootstrap.args.taskId !== undefined && {
        taskId: bootstrap.args.taskId,
      }),
    });

    await onReady?.({
      ...bootstrap,
      requestShutdown: resolveShutdown,
      shutdownSignal,
    });

    await shutdownSignal;
  } finally {
    cleanupSignals();
    bootstrap.session.dispose();
  }
}

function isTeamChildRuntimeArgv(
  value: TeamChildRuntimeArgs | readonly string[],
): value is readonly string[] {
  return Array.isArray(value);
}

function readFlagValue(
  argv: readonly string[],
  index: number,
  flagName: string,
): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new TeamChildRuntimeError(
      "missing-arg",
      `Missing value for runtime argument ${flagName}`,
    );
  }
  return value;
}

function requireRuntimeArg(
  value: string | undefined,
  flagName: string,
): string {
  if (value === undefined) {
    throw new TeamChildRuntimeError(
      "missing-arg",
      `Missing required runtime argument ${flagName}`,
    );
  }
  return value;
}

function requireNonEmptyValue(
  value: string | undefined,
  flagName: string,
): string {
  const resolved = requireRuntimeArg(value, flagName).trim();
  if (resolved.length > 0) {
    return resolved;
  }

  throw new TeamChildRuntimeError(
    "invalid-arg",
    `Runtime argument ${flagName} must not be empty`,
  );
}

function parseMemberRole(role: string): MemberProcessRole {
  switch (role) {
    case "code":
    case "simplify":
    case "review":
    case "test":
    case "commit":
      return role;
    case "leader":
      throw new TeamChildRuntimeError(
        "unsupported-role",
        'The child runtime entrypoint cannot run with role "leader"',
      );
    default:
      throw new TeamChildRuntimeError(
        "invalid-arg",
        `Unknown team member role "${role}"`,
      );
  }
}

/**
 * Validate provider/model-id formatting while preserving the exact string that
 * should be passed through to later model-registry lookup.
 */
function validateModelReference(modelReference: string): string {
  splitModelReference(modelReference);
  return modelReference;
}

function splitModelReference(modelReference: string): [string, string] {
  const trimmed = modelReference.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    throw new TeamChildRuntimeError(
      "invalid-arg",
      `Model reference "${modelReference}" must use provider/model-id format`,
    );
  }

  return [trimmed.slice(0, slashIndex), trimmed.slice(slashIndex + 1)];
}

function parseThinkingLevel(value: string): SupportedThinkingLevel {
  if (SUPPORTED_THINKING_LEVELS.includes(value as SupportedThinkingLevel)) {
    return value as SupportedThinkingLevel;
  }

  throw new TeamChildRuntimeError(
    "invalid-arg",
    `Unsupported thinking level "${value}"`,
  );
}

function parseToolNames(value: string): ToolName[] {
  const names = value
    .split(",")
    .map((toolName) => toolName.trim())
    .filter((toolName) => toolName.length > 0);

  if (names.length === 0) {
    throw new TeamChildRuntimeError(
      "invalid-arg",
      "Runtime argument --tools must include at least one tool name",
    );
  }

  return names.map((toolName) => {
    if ((TOOL_NAMES as readonly string[]).includes(toolName)) {
      return toolName as ToolName;
    }

    throw new TeamChildRuntimeError(
      "invalid-arg",
      `Unknown tool name "${toolName}"`,
    );
  });
}

function installShutdownSignalHandlers(
  requestShutdown: () => void,
): () => void {
  const signals: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  const listeners = new Map<NodeJS.Signals, () => void>();

  for (const signal of signals) {
    const listener = () => {
      requestShutdown();
    };
    listeners.set(signal, listener);
    process.once(signal, listener);
  }

  return () => {
    for (const [signal, listener] of listeners) {
      process.off(signal, listener);
    }
  };
}

function writeLifecycleEvent(
  stdout: Pick<NodeJS.WritableStream, "write">,
  event: TeamChildRuntimeReadyEvent,
): void {
  stdout.write(`${JSON.stringify(event)}\n`);
}

function formatRuntimeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isMainModule(moduleUrl: string): boolean {
  const executedPath = process.argv[1];
  if (executedPath === undefined) {
    return false;
  }

  return resolve(executedPath) === fileURLToPath(moduleUrl);
}

if (isMainModule(import.meta.url)) {
  runTeamChildRuntime().catch((error: unknown) => {
    process.stderr.write(`${formatRuntimeError(error)}\n`);
    process.exitCode = 1;
  });
}

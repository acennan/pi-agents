/**
 * `/team create` orchestration and preflight validation.
 *
 * TF-02 introduced the storage-side creation flow.
 * TF-04 adds startup preflight checks so invalid setup fails before any team
 * processes are spawned.
 */

import { resolve } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
  type LoadResult,
  TeamConfigError,
  validateTeamConfigValue,
} from "../config/loader.ts";
import { expandTeamConfig, type TeamConfig } from "../config/schema.ts";
import {
  ensureWorktreeDirWritable,
  type CommandRunner as GitCommandRunner,
  TeamPreflightError,
  validateGitWorkspace,
} from "../git/worktree.ts";
import {
  copyBundledPromptTemplates,
  createTeamDir,
  ensureTeamsRoot,
  type TeamSnapshot,
  teamExists,
  writeTeamSnapshot,
} from "../storage/team-home.ts";
import {
  createRuntimeLockRecord,
  writeRuntimeLock,
} from "../storage/team-lease.ts";
import {
  type CommandRunner as BeadsCommandRunner,
  validateBeadsWorkspace,
} from "../tasks/beads.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Parameters required to create a new team. */
export type CreateTeamParams = {
  /** Desired team name. Must be unique under `~/.pi/teams/`. */
  name: string;
  /**
   * Absolute path to the workspace (git repo) root.
   * Will be resolved to an absolute path if relative.
   */
  workspacePath: string;
  /**
   * Absolute path to the directory used for task git worktrees.
   * Will be resolved to an absolute path if relative.
   */
  worktreeDir: string;
  /** Default model identifier for the leader session (e.g. `claude-opus-4`). */
  model: string;
  /** Default thinking level (`off` | `minimal` | `low` | `medium` | `high` | `xhigh`). */
  thinkingLevel: string;
  /**
   * Absolute path to the config source YAML file, when the user provided one.
   * Absent when the built-in defaults are used.
   */
  configSourcePath?: string;
  /**
   * The raw config object that was used to construct this team.
   * Validated by TF-03's loader before this function is called.
   */
  config: unknown;
  /**
   * Absolute path to the `extensions/teams/` directory so bundled prompt
   * templates can be located portably at runtime.
   */
  extensionSourceDir: string;
  /**
   * Optional leader-session identifier written to `runtime-lock.json`.
   * When omitted, a process-scoped session id is generated automatically.
   */
  sessionId?: string;
};

export const SUPPORTED_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type SupportedThinkingLevel = (typeof SUPPORTED_THINKING_LEVELS)[number];

export type CreateTeamPreflightParams = CreateTeamParams & {
  /** Available models from the current Pi runtime. */
  availableModels: readonly Model<Api>[];
  /** Injectable command runners for deterministic tests. */
  gitRunner?: GitCommandRunner;
  beadsRunner?: BeadsCommandRunner;
};

export type CreateTeamPreflightResult = {
  workspacePath: string;
  workspaceRealpath: string;
  worktreeDir: string;
  config: TeamConfig;
  warnings: string[];
};

/** User-facing create/restart preflight failure. */
export class TeamStartupPreflightError extends Error {
  readonly code:
    | "team-exists"
    | "invalid-config"
    | "invalid-model"
    | "invalid-thinking";

  constructor(
    code: TeamStartupPreflightError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TeamStartupPreflightError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate all `/team create` inputs before anything is spawned.
 */
export async function preflightCreateTeam(
  params: CreateTeamPreflightParams,
): Promise<CreateTeamPreflightResult> {
  const {
    name,
    workspacePath,
    worktreeDir,
    model,
    thinkingLevel,
    config,
    extensionSourceDir,
    availableModels,
    gitRunner,
    beadsRunner,
  } = params;

  await ensureTeamsRoot();

  if (teamExists(name)) {
    throw new TeamStartupPreflightError(
      "team-exists",
      `Team "${name}" already exists and cannot be created again`,
    );
  }

  const loadResult = validateTeamConfigForStartup(
    config,
    resolve(extensionSourceDir, "config", "prompt-templates"),
  );

  validateModelReference(model, availableModels, "Leader model");
  validateThinkingLevel(thinkingLevel, "Leader thinking level");
  validateExpandedTeamRuntimeSettings(loadResult.config, availableModels);

  const workspace = await validateGitWorkspace(workspacePath, {
    runner: gitRunner,
  });
  await validateBeadsWorkspace(workspace.workspaceRealpath, {
    runner: beadsRunner,
  });
  const resolvedWorktreeDir = await ensureWorktreeDirWritable(worktreeDir);

  return {
    workspacePath: workspace.workspacePath,
    workspaceRealpath: workspace.workspaceRealpath,
    worktreeDir: resolvedWorktreeDir,
    config: loadResult.config,
    warnings: loadResult.warnings,
  };
}

/**
 * Create a new team: build its home directory, copy shared prompt templates,
 * persist the authoritative `team-config.yaml` snapshot, and record the active
 * leader session in `runtime-lock.json`.
 *
 * Throws `TeamAlreadyExistsError` (from team-home.ts) when the team name is
 * already in use — the caller should surface this to the user.
 *
 * @returns The written TeamSnapshot (useful for the caller to confirm values).
 */
export async function createTeam(
  params: CreateTeamParams,
): Promise<TeamSnapshot> {
  const {
    name,
    workspacePath,
    worktreeDir,
    model,
    thinkingLevel,
    configSourcePath,
    config,
    extensionSourceDir,
    sessionId,
  } = params;

  // Resolve paths to absolute form.
  const resolvedWorkspace = resolve(workspacePath);
  const resolvedWorktreeDir = resolve(worktreeDir);
  const resolvedConfigSource = configSourcePath
    ? resolve(configSourcePath)
    : undefined;
  const resolvedExtensionDir = resolve(extensionSourceDir);

  // Ensure the root teams directory exists before we check team existence,
  // so the check itself does not fail on a missing parent.
  await ensureTeamsRoot();

  // Create the team-specific directory (throws TeamAlreadyExistsError if it exists).
  await createTeamDir(name);

  // Copy bundled prompt templates to the shared location.
  // This is idempotent — existing customised templates are not overwritten.
  await copyBundledPromptTemplates(resolvedExtensionDir);

  // Build and persist the snapshot.
  const snapshot: TeamSnapshot = {
    name,
    workspacePath: resolvedWorkspace,
    worktreeDir: resolvedWorktreeDir,
    model,
    thinkingLevel,
    ...(resolvedConfigSource !== undefined && {
      configSourcePath: resolvedConfigSource,
    }),
    createdAt: new Date().toISOString(),
    config,
  };

  await writeTeamSnapshot(snapshot);

  // `createTeamDir()` above guarantees this team directory was just created, so
  // no competing leader can already have a runtime lock here. We therefore
  // write the initial lease directly rather than going through stale/active
  // contention checks that only matter for restart/delete recovery flows.
  await writeRuntimeLock(name, createRuntimeLockRecord(sessionId));

  return snapshot;
}

export function validateModelReference(
  modelReference: string,
  availableModels: readonly Model<Api>[],
  label = "Model",
): Model<Api> {
  const trimmedReference = modelReference.trim();
  if (trimmedReference.length === 0) {
    throw new TeamStartupPreflightError(
      "invalid-model",
      `${label} must not be empty`,
    );
  }

  const slashIndex = trimmedReference.indexOf("/");
  if (slashIndex !== -1) {
    const provider = trimmedReference.slice(0, slashIndex);
    const modelId = trimmedReference.slice(slashIndex + 1);
    const match = availableModels.find(
      (candidate) =>
        candidate.provider === provider && candidate.id === modelId,
    );
    if (match !== undefined) {
      return match;
    }
    throw new TeamStartupPreflightError(
      "invalid-model",
      `${label} "${trimmedReference}" is not available`,
    );
  }

  const matches = availableModels.filter(
    (candidate) => candidate.id === trimmedReference,
  );
  if (matches.length === 1) {
    const [match] = matches;
    if (match !== undefined) {
      return match;
    }
  }

  if (matches.length > 1) {
    throw new TeamStartupPreflightError(
      "invalid-model",
      `${label} "${trimmedReference}" is ambiguous. Use provider/model-id instead`,
    );
  }

  throw new TeamStartupPreflightError(
    "invalid-model",
    `${label} "${trimmedReference}" is not available`,
  );
}

export function validateThinkingLevel(
  thinkingLevel: string,
  label = "Thinking level",
): asserts thinkingLevel is SupportedThinkingLevel {
  if (
    SUPPORTED_THINKING_LEVELS.includes(thinkingLevel as SupportedThinkingLevel)
  ) {
    return;
  }

  throw new TeamStartupPreflightError(
    "invalid-thinking",
    `${label} "${thinkingLevel}" is invalid. Expected one of: ${SUPPORTED_THINKING_LEVELS.join(", ")}`,
  );
}

export function validateExpandedTeamRuntimeSettings(
  config: TeamConfig,
  availableModels: readonly Model<Api>[],
): void {
  const expanded = expandTeamConfig(config);

  for (const definition of expanded.agents) {
    if (definition.model !== undefined) {
      validateModelReference(
        definition.model,
        availableModels,
        `Agent "${definition.name}" model`,
      );
    }
    if (definition.thinking !== undefined) {
      validateThinkingLevel(
        definition.thinking,
        `Agent "${definition.name}" thinking level`,
      );
    }
  }

  for (const definition of expanded.subAgents) {
    if (definition.model !== undefined) {
      validateModelReference(
        definition.model,
        availableModels,
        `Sub-agent "${definition.name}" model`,
      );
    }
    if (definition.thinking !== undefined) {
      validateThinkingLevel(
        definition.thinking,
        `Sub-agent "${definition.name}" thinking level`,
      );
    }
  }
}

function validateTeamConfigForStartup(
  config: unknown,
  promptTemplatesDir: string,
): LoadResult {
  try {
    return validateTeamConfigValue(config, promptTemplatesDir);
  } catch (err: unknown) {
    if (err instanceof TeamConfigError) {
      throw new TeamStartupPreflightError("invalid-config", err.message, {
        cause: err,
      });
    }
    if (err instanceof TeamPreflightError) {
      throw err;
    }
    throw err;
  }
}

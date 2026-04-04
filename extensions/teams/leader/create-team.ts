/**
 * `/team create` — team creation orchestration (TF-02 slice).
 *
 * This module owns the creation flow: validate the name is unused, build
 * the team home directory, copy prompt templates, and persist the snapshot.
 *
 * Preflight validation (git repo, model validity, beads availability, etc.)
 * is added in TF-04. This module deliberately stays focused on the storage
 * side so the two concerns can be composed cleanly.
 */

import { resolve } from "node:path";
import {
  copyBundledPromptTemplates,
  createTeamDir,
  ensureTeamsRoot,
  type TeamSnapshot,
  writeTeamSnapshot,
} from "../storage/team-home.ts";

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
  /** Default thinking level (`none` | `low` | `medium` | `high` | `max`). */
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
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new team: build its home directory, copy shared prompt templates,
 * and persist the authoritative `team-config.yaml` snapshot.
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

  return snapshot;
}

/**
 * Team home directory management.
 *
 * All team state lives under `~/.pi/teams/<team-name>/`. This module owns
 * the creation, existence checks, and path helpers for that structure.
 *
 * Directory layout created at team creation time:
 *   ~/.pi/teams/
 *     prompt-templates/       shared across all teams, copied from extension source
 *     <team-name>/
 *       team-config.yaml      authoritative snapshot (see TeamSnapshot)
 *       runtime-lock.json     active leader/session ownership record
 *       state/                leader-owned lineage and workflow state (created lazily)
 *
 * NOT created here (created lazily by later tasks):
 *   ~/.pi/teams/archives/     created on first --archive use (TF-25)
 */

import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Returns the root teams directory.
 *
 * Defaults to `~/.pi/teams/`. The `PI_TEAMS_ROOT` environment variable
 * overrides this, which is useful for test isolation without mocking.
 */
export function teamsRootDir(): string {
  return process.env.PI_TEAMS_ROOT ?? join(homedir(), ".pi", "teams");
}

/** Returns the directory for a specific team: `~/.pi/teams/<name>/`. */
export function teamDir(teamName: string): string {
  const validatedTeamName = validateTeamName(teamName);
  const rootDir = resolve(teamsRootDir());
  const resolvedTeamDir = resolve(rootDir, validatedTeamName);
  const relativePath = relative(rootDir, resolvedTeamDir);

  if (
    relativePath.length === 0 ||
    relativePath === "." ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    throw new InvalidTeamNameError(
      teamName,
      `Team name "${teamName}" resolves outside the teams root`,
    );
  }

  return resolvedTeamDir;
}

/** Returns the shared prompt-templates directory: `~/.pi/teams/prompt-templates/`. */
export function sharedPromptTemplatesDir(): string {
  return join(teamsRootDir(), "prompt-templates");
}

/** Returns the path to the authoritative `team-config.yaml` for a team. */
export function teamConfigPath(teamName: string): string {
  return join(teamDir(teamName), "team-config.yaml");
}

/** Returns the path to the leader-owned state directory for a team. */
export function teamStateDir(teamName: string): string {
  return join(teamDir(teamName), "state");
}

// ---------------------------------------------------------------------------
// TeamSnapshot — the shape of team-config.yaml
// ---------------------------------------------------------------------------

/**
 * The authoritative config snapshot written to `team-config.yaml` at team
 * creation time. Stored as YAML; all paths are resolved to absolute form.
 *
 * `config` holds the raw config object (validated by TF-03's loader before
 * creation) so the team can be restarted from this snapshot without requiring
 * the original source file to still be present.
 */
export type TeamSnapshot = {
  /** Team instance name (matches the directory name under ~/.pi/teams/). */
  name: string;
  /** Absolute path to the workspace (git repo) root. */
  workspacePath: string;
  /** Absolute path to the directory used for task worktrees. */
  worktreeDir: string;
  /** Default model identifier for the leader session. */
  model: string;
  /** Default thinking level for the leader session. */
  thinkingLevel: string;
  /** Absolute path to the original config YAML source file, if one was provided. */
  configSourcePath?: string;
  /** ISO 8601 timestamp of when the team was created. */
  createdAt: string;
  /** Full config snapshot as used at creation time. */
  config: unknown;
};

// ---------------------------------------------------------------------------
// Existence checks
// ---------------------------------------------------------------------------

/** Returns true when the team directory already exists on disk. */
export function teamExists(teamName: string): boolean {
  return existsSync(teamDir(teamName));
}

// ---------------------------------------------------------------------------
// Directory creation
// ---------------------------------------------------------------------------

/**
 * Create the top-level teams root and shared prompt-templates directory if
 * they do not already exist. Safe to call multiple times.
 */
export async function ensureTeamsRoot(): Promise<void> {
  await mkdir(teamsRootDir(), { recursive: true });
  await mkdir(sharedPromptTemplatesDir(), { recursive: true });
}

/**
 * Create the directory structure for a single team.
 *
 * Throws `TeamAlreadyExistsError` when the team directory is already present.
 */
export async function createTeamDir(teamName: string): Promise<void> {
  const path = teamDir(teamName);
  await mkdir(teamsRootDir(), { recursive: true });

  try {
    await mkdir(path);
  } catch (err: unknown) {
    if (isAlreadyExistsError(err)) {
      throw new TeamAlreadyExistsError(teamName);
    }
    throw err;
  }
}

export async function removeTeamDir(teamName: string): Promise<void> {
  await rm(teamDir(teamName), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Snapshot persistence
// ---------------------------------------------------------------------------

/** Write the team snapshot to `team-config.yaml`. */
export async function writeTeamSnapshot(snapshot: TeamSnapshot): Promise<void> {
  const yaml = stringifyYaml(snapshot as Record<string, unknown>);
  await writeFile(teamConfigPath(snapshot.name), yaml, "utf8");
}

/** Read and parse `team-config.yaml` for the given team name. */
export async function readTeamSnapshot(
  teamName: string,
): Promise<TeamSnapshot> {
  const path = teamConfigPath(teamName);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err: unknown) {
    throw new Error(`Cannot read team config for "${teamName}" at ${path}`, {
      cause: err,
    });
  }
  const parsed = parseYaml(raw) as unknown;
  if (!isTeamSnapshot(parsed)) {
    throw new Error(
      `team-config.yaml for "${teamName}" is missing required fields`,
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Prompt template copying
// ---------------------------------------------------------------------------

/**
 * Copy the bundled prompt templates from the extension source directory into
 * `~/.pi/teams/prompt-templates/`.
 *
 * Uses `cp` with `force: false` so existing templates are not overwritten —
 * allowing users to customise them after installation.
 *
 * @param extensionSourceDir Absolute path to `extensions/teams/` (the root of
 *   this extension) so the bundled templates can be located portably.
 */
export async function copyBundledPromptTemplates(
  extensionSourceDir: string,
): Promise<void> {
  const sourceTemplatesDir = resolve(
    extensionSourceDir,
    "config",
    "prompt-templates",
  );
  const destDir = sharedPromptTemplatesDir();

  await ensureTeamsRoot();

  // Copy files individually so we can use force: false per-file.
  // Node's fs.cp does support recursive, but we want fine-grained control.
  await cp(sourceTemplatesDir, destDir, {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when attempting to create a team that already exists. */
export class TeamAlreadyExistsError extends Error {
  readonly teamName: string;

  constructor(teamName: string) {
    super(`Team "${teamName}" already exists at ${teamDir(teamName)}`);
    this.name = "TeamAlreadyExistsError";
    this.teamName = teamName;
  }
}

/** Thrown when a supplied team name is unsafe or unsupported. */
export class InvalidTeamNameError extends Error {
  readonly code = "invalid-team-name";
  readonly teamName: string;

  constructor(teamName: string, message?: string) {
    super(
      message ??
        `Team name "${teamName}" is invalid. Use only letters, numbers, hyphens, and underscores.`,
    );
    this.name = "InvalidTeamNameError";
    this.teamName = teamName;
  }
}

export function validateTeamName(teamName: string): string {
  const trimmedTeamName = teamName.trim();

  if (trimmedTeamName.length === 0) {
    throw new InvalidTeamNameError(teamName, "Team name must not be empty");
  }

  if (trimmedTeamName !== teamName) {
    throw new InvalidTeamNameError(
      teamName,
      `Team name "${teamName}" must not include leading or trailing whitespace`,
    );
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(teamName)) {
    throw new InvalidTeamNameError(teamName);
  }

  return teamName;
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

function isTeamSnapshot(value: unknown): value is TeamSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.workspacePath === "string" &&
    typeof v.worktreeDir === "string" &&
    typeof v.model === "string" &&
    typeof v.thinkingLevel === "string" &&
    typeof v.createdAt === "string" &&
    "config" in v
  );
}

function isAlreadyExistsError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err && err.code === "EEXIST";
}

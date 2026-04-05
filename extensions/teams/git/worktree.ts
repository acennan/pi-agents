/**
 * Git/worktree preflight helpers for teams.
 *
 * TF-04 validates the workspace before any team startup work begins:
 * - the workspace path must exist and resolve to the git repository root
 * - the repository must have a local `main` branch
 * - the configured worktree directory must be creatable and writable
 * - restart must attach only from the same workspace realpath as the snapshot
 */

import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

export type ValidatedGitWorkspace = {
  workspacePath: string;
  workspaceRealpath: string;
  gitRootPath: string;
  gitRootRealpath: string;
};

export type RestartWorkspaceMatch = {
  currentWorkspacePath: string;
  currentWorkspaceRealpath: string;
  storedWorkspacePath: string;
  storedWorkspaceRealpath: string;
};

/** User-facing startup/preflight failure. */
export class TeamPreflightError extends Error {
  readonly code:
    | "workspace-missing"
    | "workspace-not-git"
    | "workspace-not-root"
    | "workspace-realpath-mismatch"
    | "main-missing"
    | "worktree-not-writable";

  constructor(
    code: TeamPreflightError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TeamPreflightError";
    this.code = code;
  }
}

/** Default subprocess runner used by the preflight helpers. */
export const defaultCommandRunner: CommandRunner = async (
  command,
  args,
  options,
) => {
  try {
    const result = await execFile(command, args, {
      cwd: options?.cwd,
      encoding: "utf8",
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Command failed: ${command} ${args.join(" ")} (${message})`,
      { cause: err },
    );
  }
};

/**
 * Validate that `workspacePath` exists, resolves to the git repository root,
 * and that the repository has a local `main` branch.
 */
export async function validateGitWorkspace(
  workspacePath: string,
  options: { runner?: CommandRunner } = {},
): Promise<ValidatedGitWorkspace> {
  const runner = options.runner ?? defaultCommandRunner;
  const resolvedWorkspacePath = resolve(workspacePath);
  const workspaceRealpath = await resolveExistingRealpath(
    resolvedWorkspacePath,
    `Workspace path "${resolvedWorkspacePath}" does not exist or is not accessible`,
  );

  let gitRootPath: string;
  try {
    const result = await runner("git", ["rev-parse", "--show-toplevel"], {
      cwd: workspaceRealpath,
    });
    gitRootPath = result.stdout.trim();
  } catch (err: unknown) {
    throw new TeamPreflightError(
      "workspace-not-git",
      `Workspace "${resolvedWorkspacePath}" is not a git repository root with an accessible .git directory`,
      { cause: err },
    );
  }

  if (gitRootPath.length === 0) {
    throw new TeamPreflightError(
      "workspace-not-git",
      `Workspace "${resolvedWorkspacePath}" is not a git repository root with an accessible .git directory`,
    );
  }

  const gitRootRealpath = await resolveExistingRealpath(
    gitRootPath,
    `Git repository root "${gitRootPath}" is not accessible`,
  );

  if (workspaceRealpath !== gitRootRealpath) {
    throw new TeamPreflightError(
      "workspace-not-root",
      `Workspace "${resolvedWorkspacePath}" must be the git repository root. Resolved repository root: "${gitRootRealpath}"`,
    );
  }

  try {
    await runner("git", ["rev-parse", "--verify", "refs/heads/main"], {
      cwd: workspaceRealpath,
    });
  } catch (err: unknown) {
    throw new TeamPreflightError(
      "main-missing",
      `Workspace "${gitRootRealpath}" does not have a local "main" branch`,
      { cause: err },
    );
  }

  return {
    workspacePath: resolvedWorkspacePath,
    workspaceRealpath,
    gitRootPath,
    gitRootRealpath,
  };
}

/**
 * Compare the current restart workspace against the stored snapshot workspace
 * using realpaths so symlinked entry points still attach correctly.
 */
export async function validateRestartWorkspaceMatch(
  currentWorkspacePath: string,
  storedWorkspacePath: string,
): Promise<RestartWorkspaceMatch> {
  const resolvedCurrentWorkspacePath = resolve(currentWorkspacePath);
  const resolvedStoredWorkspacePath = resolve(storedWorkspacePath);
  const currentWorkspaceRealpath = await resolveExistingRealpath(
    resolvedCurrentWorkspacePath,
    `Current workspace path "${resolvedCurrentWorkspacePath}" does not exist or is not accessible`,
  );
  const storedWorkspaceRealpath = await resolveExistingRealpath(
    resolvedStoredWorkspacePath,
    `Stored workspace path "${resolvedStoredWorkspacePath}" does not exist or is not accessible`,
  );

  if (currentWorkspaceRealpath !== storedWorkspaceRealpath) {
    throw new TeamPreflightError(
      "workspace-realpath-mismatch",
      `Current workspace "${currentWorkspaceRealpath}" does not match the stored team workspace "${storedWorkspaceRealpath}"`,
    );
  }

  return {
    currentWorkspacePath: resolvedCurrentWorkspacePath,
    currentWorkspaceRealpath,
    storedWorkspacePath: resolvedStoredWorkspacePath,
    storedWorkspaceRealpath,
  };
}

/**
 * Ensure the worktree directory exists and is writable.
 *
 * The directory is created when missing so later worktree creation can rely on
 * it without racing against a separate setup step.
 */
export async function ensureWorktreeDirWritable(
  worktreeDir: string,
): Promise<string> {
  const resolvedWorktreeDir = resolve(worktreeDir);

  try {
    await mkdir(resolvedWorktreeDir, { recursive: true });
  } catch (err: unknown) {
    throw new TeamPreflightError(
      "worktree-not-writable",
      `Worktree directory "${resolvedWorktreeDir}" could not be created`,
      { cause: err },
    );
  }

  const directoryStats = await stat(resolvedWorktreeDir).catch(
    (err: unknown) => {
      throw new TeamPreflightError(
        "worktree-not-writable",
        `Worktree directory "${resolvedWorktreeDir}" is not accessible`,
        { cause: err },
      );
    },
  );

  if (!directoryStats.isDirectory()) {
    throw new TeamPreflightError(
      "worktree-not-writable",
      `Worktree path "${resolvedWorktreeDir}" exists but is not a directory`,
    );
  }

  try {
    await access(resolvedWorktreeDir, fsConstants.W_OK);
  } catch (err: unknown) {
    throw new TeamPreflightError(
      "worktree-not-writable",
      `Worktree directory "${resolvedWorktreeDir}" is not writable`,
      { cause: err },
    );
  }

  const probePath = join(
    resolvedWorktreeDir,
    `.pi-teams-preflight-${process.pid}-${Date.now()}.tmp`,
  );

  try {
    await writeFile(probePath, "ok", "utf8");
    await rm(probePath, { force: true });
  } catch (err: unknown) {
    throw new TeamPreflightError(
      "worktree-not-writable",
      `Worktree directory "${resolvedWorktreeDir}" is not writable`,
      { cause: err },
    );
  }

  return resolvedWorktreeDir;
}

async function resolveExistingRealpath(
  path: string,
  message: string,
): Promise<string> {
  try {
    return await realpath(path);
  } catch (err: unknown) {
    throw new TeamPreflightError("workspace-missing", message, {
      cause: err,
    });
  }
}

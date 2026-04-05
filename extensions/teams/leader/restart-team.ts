/**
 * `/team restart` preflight validation.
 *
 * Restart always uses the persisted `team-config.yaml` snapshot rather than the
 * original source config, and it may only attach from the same workspace.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import { TeamConfigError, validateTeamConfigValue } from "../config/loader.ts";
import {
  ensureWorktreeDirWritable,
  type CommandRunner as GitCommandRunner,
  validateGitWorkspace,
  validateRestartWorkspaceMatch,
} from "../git/worktree.ts";
import {
  readTeamSnapshot,
  sharedPromptTemplatesDir,
  type TeamSnapshot,
} from "../storage/team-home.ts";
import {
  type CommandRunner as BeadsCommandRunner,
  validateBeadsWorkspace,
} from "../tasks/beads.ts";
import {
  TeamStartupPreflightError,
  validateExpandedTeamRuntimeSettings,
  validateModelReference,
  validateThinkingLevel,
} from "./create-team.ts";

export type RestartTeamPreflightParams = {
  teamName: string;
  currentWorkspacePath: string;
  availableModels: readonly Model<Api>[];
  gitRunner?: GitCommandRunner;
  beadsRunner?: BeadsCommandRunner;
};

export type RestartTeamPreflightResult = {
  snapshot: TeamSnapshot;
  workspaceRealpath: string;
  worktreeDir: string;
  warnings: string[];
};

/**
 * Validate that an existing team can be restarted from its persisted snapshot.
 */
export async function preflightRestartTeam(
  params: RestartTeamPreflightParams,
): Promise<RestartTeamPreflightResult> {
  const {
    teamName,
    currentWorkspacePath,
    availableModels,
    gitRunner,
    beadsRunner,
  } = params;

  const snapshot = await readTeamSnapshot(teamName);

  const workspaceMatch = await validateRestartWorkspaceMatch(
    currentWorkspacePath,
    snapshot.workspacePath,
  );

  const loadResult = validateSnapshotConfig(snapshot.config);
  validateModelReference(snapshot.model, availableModels, "Leader model");
  validateThinkingLevel(snapshot.thinkingLevel, "Leader thinking level");
  validateExpandedTeamRuntimeSettings(loadResult.config, availableModels);
  const workspace = await validateGitWorkspace(snapshot.workspacePath, {
    runner: gitRunner,
  });
  await validateBeadsWorkspace(workspace.workspaceRealpath, {
    runner: beadsRunner,
  });
  const resolvedWorktreeDir = await ensureWorktreeDirWritable(
    snapshot.worktreeDir,
  );

  return {
    snapshot: {
      ...snapshot,
      workspacePath: workspace.workspacePath,
      config: loadResult.config,
    },
    workspaceRealpath: workspaceMatch.storedWorkspaceRealpath,
    worktreeDir: resolvedWorktreeDir,
    warnings: loadResult.warnings,
  };
}

function validateSnapshotConfig(config: unknown) {
  try {
    return validateTeamConfigValue(config, sharedPromptTemplatesDir());
  } catch (err: unknown) {
    if (err instanceof TeamConfigError) {
      throw new TeamStartupPreflightError("invalid-config", err.message, {
        cause: err,
      });
    }
    throw err;
  }
}

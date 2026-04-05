/**
 * Runtime-lock-aware deletion helpers.
 *
 * TF-05A only defines the active/stale lease contract for delete flows.
 * Full archive/worktree removal semantics land later in TF-25.
 */

import {
  clearStaleRuntimeLock,
  inspectRuntimeLock,
  type ProcessAliveChecker,
  TeamLeaseError,
} from "../storage/team-lease.ts";

export type PrepareTeamDeletionParams = {
  teamName: string;
  processAlive?: ProcessAliveChecker;
};

export type PrepareTeamDeletionResult = {
  hadRuntimeLock: boolean;
  clearedStaleRuntimeLock: boolean;
};

/**
 * Validate that a team can be deleted safely with respect to the runtime lock.
 *
 * Active locks are rejected. Stale locks are cleared because delete is an
 * explicit recovery flow. Cleanly stopped teams usually have no runtime lock,
 * so delete mostly needs to reject active teams and clear stale records left
 * behind by crashed leaders.
 */
export async function prepareTeamDeletion(
  params: PrepareTeamDeletionParams,
): Promise<PrepareTeamDeletionResult> {
  const inspection = await inspectRuntimeLock(params.teamName, {
    processAlive: params.processAlive,
  });

  if (inspection === undefined) {
    return {
      hadRuntimeLock: false,
      clearedStaleRuntimeLock: false,
    };
  }

  if (inspection.state === "active") {
    throw new TeamLeaseError(
      "lease-active",
      `Team "${params.teamName}" is still active and must be stopped before it can be deleted`,
    );
  }

  const clearedStaleRuntimeLock = await clearStaleRuntimeLock(params.teamName, {
    processAlive: params.processAlive,
  });

  return {
    hadRuntimeLock: true,
    clearedStaleRuntimeLock,
  };
}

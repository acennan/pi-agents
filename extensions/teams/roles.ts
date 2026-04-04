/**
 * Process-role detection for the teams extension.
 *
 * Member-agent processes are launched by the leader with PI_TEAM_ROLE set
 * to a non-leader value. The leader process leaves PI_TEAM_ROLE unset or
 * sets it to "leader".
 *
 * Centralising this here keeps command-router.ts and the future process
 * manager in sync on what constitutes a member process.
 */

/** All possible process roles within the teams system. */
export type ProcessRole =
  | "leader"
  | "code"
  | "simplify"
  | "review"
  | "test"
  | "commit";

/** The environment variable that identifies the process role. */
const ROLE_ENV_VAR = "PI_TEAM_ROLE";

/** The environment variable that carries the team name (present in all member processes). */
const TEAM_NAME_ENV_VAR = "PI_TEAM_NAME";

/**
 * Read the current process role from environment variables.
 *
 * Returns "leader" when PI_TEAM_ROLE is absent or explicitly set to "leader"
 * (i.e. the user's interactive pi session).
 */
export function getProcessRole(): ProcessRole {
  const raw = process.env[ROLE_ENV_VAR];
  if (!raw || raw === "leader") return "leader";

  const valid: ProcessRole[] = ["code", "simplify", "review", "test", "commit"];
  if ((valid as string[]).includes(raw)) return raw as ProcessRole;

  // Unknown value — treat as leader so commands are not silently swallowed.
  return "leader";
}

/** Returns true when this process is the leader (i.e. the user's interactive session). */
export function isLeader(): boolean {
  return getProcessRole() === "leader";
}

/** Returns true when this process is a member agent (not the leader). */
export function isMemberAgent(): boolean {
  return !isLeader();
}

/** Returns the team name from environment variables, or undefined when not set. */
export function getTeamName(): string | undefined {
  return process.env[TEAM_NAME_ENV_VAR] ?? undefined;
}

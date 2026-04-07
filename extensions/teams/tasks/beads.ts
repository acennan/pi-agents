/**
 * Beads CLI helpers for teams.
 *
 * TF-04 validates that `br` is available before team startup.
 * TF-16 adds the code-agent task selection and atomic claim flow on top of the
 * same runner abstraction so later slices can reuse a single, normalized API.
 * TF-16A adds supported remedial-task creation using beads parent-child links
 * without relying on custom metadata.
 *
 * Real beads workspaces currently key dependencies by `(issue_id, depends_on_id)`,
 * so the same task pair cannot simultaneously carry both `parent-child` and
 * `discovered-from`. Teams therefore use the parent-child link as the
 * authoritative remedial/source-task relationship and keep workflow lineage in
 * team-owned state.
 */

import { execFile as execFileCallback } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

export const BEADS_TASK_STATUS_OPEN = "open";
export const BEADS_TASK_STATUS_IN_PROGRESS = "in_progress";
export const BEADS_DEPENDENCY_TYPE_DISCOVERED_FROM = "discovered-from";
export const BEADS_DEPENDENCY_TYPE_PARENT_CHILD = "parent-child";

export type BeadsTaskDependency = {
  id: string;
  title?: string;
  status?: string;
  priority?: number;
  dependencyType?: string;
};

export type BeadsTask = {
  id: string;
  title: string;
  status: string;
  priority: number;
  description?: string;
  issueType?: string;
  assignee?: string;
  parentTaskId?: string;
  labels: string[];
  dependencies: BeadsTaskDependency[];
};

export type BeadsCommandOptions = {
  runner?: CommandRunner;
};

export type UpdateBeadsTaskOptions = BeadsCommandOptions & {
  actor?: string;
  env?: NodeJS.ProcessEnv;
  status?: string;
  claim?: boolean;
};

export type CreateBeadsTaskOptions = BeadsCommandOptions & {
  actor?: string;
  env?: NodeJS.ProcessEnv;
  title: string;
  description?: string;
  priority?: number;
  issueType?: string;
  assignee?: string;
  labels?: readonly string[];
  parentTaskId?: string;
};

export type AddBeadsDependencyOptions = BeadsCommandOptions & {
  dependencyType?: string;
};

export type AddBeadsDependencyResult = {
  status: string;
  issueId: string;
  dependsOnId: string;
  dependencyType: string;
  action: string;
};

export type CreateRemedialBeadsTaskOptions = Omit<
  CreateBeadsTaskOptions,
  "parentTaskId"
> & {
  originalTaskId: string;
};

export type ListClaimableBeadsTasksResult = {
  readyTasks: BeadsTask[];
  blockedTasks: BeadsTask[];
  claimableTasks: BeadsTask[];
};

export type ClaimNextReadyBeadsTaskOptions = BeadsCommandOptions & {
  actor?: string;
  env?: NodeJS.ProcessEnv;
};

export type ClaimNextReadyBeadsTaskResult = ListClaimableBeadsTasksResult & {
  task?: BeadsTask;
  attemptedTaskIds: string[];
  lostRaceTaskIds: string[];
};

type JsonRecord = Record<string, unknown>;

/** User-facing beads setup failure. */
export class BeadsPreflightError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BeadsPreflightError";
  }
}

export class BeadsAdapterError extends Error {
  readonly code:
    | "claim-failed"
    | "invalid-json"
    | "invalid-response"
    | "missing-update"
    | "not-found";

  constructor(
    code: BeadsAdapterError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BeadsAdapterError";
    this.code = code;
  }
}

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
 * Verify that `br` is installed and usable from the target workspace.
 *
 * We run a read-only query (`br ready --json`) because it checks both CLI
 * availability and that the workspace has a beads instance the team can read.
 */
export async function validateBeadsWorkspace(
  workspacePath: string,
  options: { runner?: CommandRunner } = {},
): Promise<void> {
  const runner = options.runner ?? defaultCommandRunner;
  const resolvedWorkspacePath = resolve(workspacePath);

  try {
    await runner("br", ["ready", "--json"], {
      cwd: resolvedWorkspacePath,
    });
  } catch (err: unknown) {
    throw new BeadsPreflightError(
      `Beads is not available or not initialized for workspace "${resolvedWorkspacePath}". ` +
        `Run beads setup first and verify that the \`br\` CLI works in this repository.`,
      { cause: err },
    );
  }
}

export function resolveBeadsActor(
  fallbackActor = "assistant",
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configuredActor = env.BR_ACTOR?.trim();
  if (configuredActor !== undefined && configuredActor.length > 0) {
    return configuredActor;
  }

  const trimmedFallbackActor = fallbackActor.trim();
  if (trimmedFallbackActor.length > 0) {
    return trimmedFallbackActor;
  }

  return "assistant";
}

export async function listReadyBeadsTasks(
  workspacePath: string,
  options: BeadsCommandOptions = {},
): Promise<BeadsTask[]> {
  return runBeadsTaskListCommand(workspacePath, ["ready"], options);
}

export async function listBlockedBeadsTasks(
  workspacePath: string,
  options: BeadsCommandOptions = {},
): Promise<BeadsTask[]> {
  return runBeadsTaskListCommand(workspacePath, ["blocked"], options);
}

export async function getBeadsTask(
  workspacePath: string,
  taskId: string,
  options: BeadsCommandOptions = {},
): Promise<BeadsTask> {
  const tasks = await runBeadsTaskListCommand(
    workspacePath,
    ["show", taskId],
    options,
  );
  const [task] = tasks;
  if (task !== undefined) {
    return task;
  }

  throw new BeadsAdapterError(
    "not-found",
    `Beads task "${taskId}" was not found in workspace "${resolve(workspacePath)}"`,
  );
}

export async function updateBeadsTask(
  workspacePath: string,
  taskId: string,
  options: UpdateBeadsTaskOptions,
): Promise<BeadsTask> {
  if (options.status === undefined && options.claim !== true) {
    throw new BeadsAdapterError(
      "missing-update",
      `No beads task update was requested for "${taskId}"`,
    );
  }

  const args = [
    "update",
    "--actor",
    resolveBeadsActor(options.actor, options.env),
    taskId,
  ];

  if (options.claim === true) {
    args.push("--claim");
  }

  if (options.status !== undefined) {
    args.push("--status", options.status);
  }

  const tasks = await runBeadsTaskListCommand(workspacePath, args, options);
  const [task] = tasks;
  if (task !== undefined) {
    return task;
  }

  throw new BeadsAdapterError(
    "invalid-response",
    `The beads update for task "${taskId}" did not return a task payload`,
  );
}

export async function createBeadsTask(
  workspacePath: string,
  options: CreateBeadsTaskOptions,
): Promise<BeadsTask> {
  const args = [
    "create",
    "--actor",
    resolveBeadsActor(options.actor, options.env),
    options.title,
  ];

  if (options.priority !== undefined) {
    args.push("--priority", String(options.priority));
  }

  if (options.issueType !== undefined) {
    args.push("--type", options.issueType);
  }

  if (options.assignee !== undefined) {
    args.push("--assignee", options.assignee);
  }

  if (options.labels !== undefined && options.labels.length > 0) {
    args.push("--labels", options.labels.join(","));
  }

  if (options.parentTaskId !== undefined) {
    args.push("--parent", options.parentTaskId);
  }

  if (options.description !== undefined) {
    args.push("--description", options.description);
  }

  const payload = await runBeadsJsonCommand(workspacePath, args, options);
  const taskId = extractCreatedBeadsTaskId(payload, formatBrCommand(args));

  return getBeadsTask(workspacePath, taskId, options);
}

export async function addBeadsDependency(
  workspacePath: string,
  taskId: string,
  dependsOnTaskId: string,
  options: AddBeadsDependencyOptions = {},
): Promise<AddBeadsDependencyResult> {
  const dependencyType =
    options.dependencyType ?? BEADS_DEPENDENCY_TYPE_DISCOVERED_FROM;

  const payload = await runBeadsJsonCommand(
    workspacePath,
    ["dep", "add", taskId, dependsOnTaskId, "--type", dependencyType],
    options,
  );

  return normalizeAddBeadsDependencyResult(
    payload,
    formatBrCommand([
      "dep",
      "add",
      taskId,
      dependsOnTaskId,
      "--type",
      dependencyType,
      "--json",
    ]),
  );
}

export async function createRemedialBeadsTask(
  workspacePath: string,
  options: CreateRemedialBeadsTaskOptions,
): Promise<BeadsTask> {
  const task = await createBeadsTask(workspacePath, {
    runner: options.runner,
    actor: options.actor,
    env: options.env,
    title: options.title,
    description: options.description,
    priority: options.priority,
    issueType: options.issueType,
    assignee: options.assignee,
    labels: options.labels,
    parentTaskId: options.originalTaskId,
  });

  if (task.parentTaskId !== options.originalTaskId) {
    throw new BeadsAdapterError(
      "invalid-response",
      `Expected remedial beads task "${task.id}" to have parent "${options.originalTaskId}"`,
    );
  }

  return task;
}

export async function listClaimableBeadsTasks(
  workspacePath: string,
  options: BeadsCommandOptions = {},
): Promise<ListClaimableBeadsTasksResult> {
  const [readyTasks, blockedTasks] = await Promise.all([
    listReadyBeadsTasks(workspacePath, options),
    listBlockedBeadsTasks(workspacePath, options),
  ]);
  const blockedTaskIds = new Set(blockedTasks.map((task) => task.id));
  const claimableTasks = readyTasks.filter(
    (task) =>
      task.status === BEADS_TASK_STATUS_OPEN && !blockedTaskIds.has(task.id),
  );

  return {
    readyTasks,
    blockedTasks,
    claimableTasks,
  };
}

/**
 * Claim one ready/open task for a standing code agent.
 *
 * The flow is intentionally concrete:
 * 1. query `br ready` and `br blocked`
 * 2. try the ready/open candidates in order
 * 3. use `br update --claim` so the status transition to `in_progress` stays
 *    atomic within beads
 * 4. if the update fails and the task is no longer open, treat it as a lost
 *    race and continue to the next candidate
 */
export async function claimNextReadyBeadsTask(
  workspacePath: string,
  options: ClaimNextReadyBeadsTaskOptions = {},
): Promise<ClaimNextReadyBeadsTaskResult> {
  const selection = await listClaimableBeadsTasks(workspacePath, options);
  const attemptedTaskIds: string[] = [];
  const lostRaceTaskIds: string[] = [];

  for (const candidate of selection.claimableTasks) {
    attemptedTaskIds.push(candidate.id);

    try {
      const task = await updateBeadsTask(workspacePath, candidate.id, {
        runner: options.runner,
        actor: options.actor,
        env: options.env,
        claim: true,
      });

      return {
        ...selection,
        task,
        attemptedTaskIds,
        lostRaceTaskIds,
      };
    } catch (err: unknown) {
      const currentTask = await tryGetBeadsTask(
        workspacePath,
        candidate.id,
        options,
      );
      if (
        currentTask !== undefined &&
        currentTask.status !== BEADS_TASK_STATUS_OPEN
      ) {
        lostRaceTaskIds.push(candidate.id);
        continue;
      }

      throw new BeadsAdapterError(
        "claim-failed",
        `Failed to claim beads task "${candidate.id}"`,
        { cause: err },
      );
    }
  }

  return {
    ...selection,
    task: undefined,
    attemptedTaskIds,
    lostRaceTaskIds,
  };
}

async function tryGetBeadsTask(
  workspacePath: string,
  taskId: string,
  options: BeadsCommandOptions,
): Promise<BeadsTask | undefined> {
  try {
    return await getBeadsTask(workspacePath, taskId, options);
  } catch {
    return undefined;
  }
}

async function runBeadsTaskListCommand(
  workspacePath: string,
  args: string[],
  options: BeadsCommandOptions,
): Promise<BeadsTask[]> {
  const payload = await runBeadsJsonCommand(workspacePath, args, options);
  return normalizeBeadsTaskList(payload, formatBrCommand(args));
}

async function runBeadsJsonCommand(
  workspacePath: string,
  args: string[],
  options: BeadsCommandOptions,
): Promise<unknown> {
  const runner = options.runner ?? defaultCommandRunner;
  const resolvedWorkspacePath = resolve(workspacePath);
  const commandArgs = ensureJsonFlag(args);
  const { stdout } = await runner("br", commandArgs, {
    cwd: resolvedWorkspacePath,
  });

  try {
    return JSON.parse(stdout);
  } catch (err: unknown) {
    throw new BeadsAdapterError(
      "invalid-json",
      `Failed to parse JSON output from "${formatBrCommand(commandArgs)}"`,
      { cause: err },
    );
  }
}

function ensureJsonFlag(args: string[]): string[] {
  return args.includes("--json") ? [...args] : [...args, "--json"];
}

function formatBrCommand(args: string[]): string {
  return `br ${args.join(" ")}`;
}

function normalizeBeadsTaskList(value: unknown, command: string): BeadsTask[] {
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      normalizeBeadsTask(entry, `${command} response[${index}]`),
    );
  }

  if (isJsonRecord(value)) {
    return [normalizeBeadsTask(value, `${command} response`)];
  }

  throw new BeadsAdapterError(
    "invalid-response",
    `Expected ${command} to return a JSON object or array`,
  );
}

function normalizeBeadsTask(value: unknown, path: string): BeadsTask {
  if (!isJsonRecord(value)) {
    throw new BeadsAdapterError(
      "invalid-response",
      `Expected ${path} to be an object`,
    );
  }

  return {
    id: readRequiredString(value, "id", path),
    title: readRequiredString(value, "title", path),
    status: readRequiredString(value, "status", path),
    priority: readRequiredNumber(value, "priority", path),
    description: readOptionalString(value, "description", path),
    issueType: readOptionalString(value, "issue_type", path),
    assignee: readOptionalString(value, "assignee", path),
    parentTaskId: readOptionalString(value, "parent", path),
    labels: readOptionalStringArray(value, "labels", path),
    dependencies: readOptionalDependencyArray(value, "dependencies", path),
  };
}

function readOptionalDependencyArray(
  record: JsonRecord,
  fieldName: string,
  path: string,
): BeadsTaskDependency[] {
  const value = record[fieldName];
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new BeadsAdapterError(
      "invalid-response",
      `Expected ${path}.${fieldName} to be an array`,
    );
  }

  return value.map((entry, index) =>
    normalizeDependency(entry, `${path}.${fieldName}[${index}]`),
  );
}

function normalizeDependency(
  value: unknown,
  path: string,
): BeadsTaskDependency {
  if (!isJsonRecord(value)) {
    throw new BeadsAdapterError(
      "invalid-response",
      `Expected ${path} to be an object`,
    );
  }

  return {
    id: readRequiredString(value, "id", path),
    title: readOptionalString(value, "title", path),
    status: readOptionalString(value, "status", path),
    priority: readOptionalNumber(value, "priority", path),
    dependencyType: readOptionalString(value, "dependency_type", path),
  };
}

function readOptionalStringArray(
  record: JsonRecord,
  fieldName: string,
  path: string,
): string[] {
  const value = record[fieldName];
  if (value === undefined) {
    return [];
  }

  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new BeadsAdapterError(
      "invalid-response",
      `Expected ${path}.${fieldName} to be a string array`,
    );
  }

  return [...value];
}

function readRequiredString(
  record: JsonRecord,
  fieldName: string,
  path: string,
): string {
  const value = record[fieldName];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BeadsAdapterError(
      "invalid-response",
      `Expected ${path}.${fieldName} to be a non-empty string`,
    );
  }

  return value;
}

function readOptionalString(
  record: JsonRecord,
  fieldName: string,
  path: string,
): string | undefined {
  const value = record[fieldName];
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new BeadsAdapterError(
      "invalid-response",
      `Expected ${path}.${fieldName} to be a string`,
    );
  }

  return value.trim().length > 0 ? value : undefined;
}

function readRequiredNumber(
  record: JsonRecord,
  fieldName: string,
  path: string,
): number {
  const value = record[fieldName];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BeadsAdapterError(
      "invalid-response",
      `Expected ${path}.${fieldName} to be a finite number`,
    );
  }

  return value;
}

function readOptionalNumber(
  record: JsonRecord,
  fieldName: string,
  path: string,
): number | undefined {
  const value = record[fieldName];
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BeadsAdapterError(
      "invalid-response",
      `Expected ${path}.${fieldName} to be a finite number`,
    );
  }

  return value;
}

function extractCreatedBeadsTaskId(value: unknown, command: string): string {
  if (Array.isArray(value)) {
    const [task] = value;
    if (task !== undefined) {
      return extractCreatedBeadsTaskId(task, `${command} response[0]`);
    }

    throw new BeadsAdapterError(
      "invalid-response",
      `Expected ${command} to return at least one created task`,
    );
  }

  if (!isJsonRecord(value)) {
    throw new BeadsAdapterError(
      "invalid-response",
      `Expected ${command} to return a JSON object or array`,
    );
  }

  return readRequiredString(value, "id", `${command} response`);
}

function normalizeAddBeadsDependencyResult(
  value: unknown,
  command: string,
): AddBeadsDependencyResult {
  if (!isJsonRecord(value)) {
    throw new BeadsAdapterError(
      "invalid-response",
      `Expected ${command} to return an object`,
    );
  }

  return {
    status: readRequiredString(value, "status", `${command} response`),
    issueId: readRequiredString(value, "issue_id", `${command} response`),
    dependsOnId: readRequiredString(
      value,
      "depends_on_id",
      `${command} response`,
    ),
    dependencyType: readRequiredString(value, "type", `${command} response`),
    action: readRequiredString(value, "action", `${command} response`),
  };
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

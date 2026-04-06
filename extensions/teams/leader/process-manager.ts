/**
 * Child-process spawn helpers for team member runtimes.
 *
 * TF-11 establishes the transport contract between the leader and SDK-backed
 * child runtimes:
 * - prefer runnable JavaScript entrypoints for spawned children
 * - fall back to the TypeScript source only when the current runtime can
 *   execute it directly (local Bun-based development)
 * - pass role/team/task/env arguments explicitly
 * - capture stdout, stderr, exit codes, signals, and spawn errors for later
 *   lifecycle handling by the leader
 */

import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  type MemberProcessRole,
  TEAM_CHILD_AGENT_NAME_ENV_VAR,
  TEAM_CHILD_ROLE_ENV_VAR,
  TEAM_CHILD_TASK_ID_ENV_VAR,
  TEAM_CHILD_TEAM_NAME_ENV_VAR,
} from "../agents/runtime-entry.ts";
import type { ToolName } from "../config/schema.ts";
import type { SupportedThinkingLevel } from "./create-team.ts";

export type ChildRuntimeMetadata = {
  role: MemberProcessRole;
  teamName: string;
  agentName: string;
  workspacePath: string;
  cwd: string;
  taskId?: string;
  model: string;
  thinkingLevel: SupportedThinkingLevel;
  tools: readonly ToolName[];
  env: Record<string, string>;
};

export type ResolveRuntimeEntryPathOptions = {
  runtimeEntryPath?: string;
  processManagerModuleUrl?: string;
  fileExists?: (path: string) => boolean;
  supportsTypeScriptEntrypoints?: boolean;
};

export type ResolvedRuntimeEntryPath = {
  path: string;
  language: "javascript" | "typescript";
};

export type SpawnChildRuntimeOptions = {
  role: MemberProcessRole;
  teamName: string;
  agentName: string;
  workspacePath: string;
  cwd?: string;
  taskId?: string;
  model: string;
  thinkingLevel: SupportedThinkingLevel;
  tools: readonly ToolName[];
  env?: Record<string, string>;
  runtimeEntryPath?: string;
  execPath?: string;
  baseEnv?: NodeJS.ProcessEnv;
  supportsTypeScriptEntrypoints?: boolean;
  /**
   * Maximum retained stdout/stderr bytes per stream.
   *
   * Long-lived standing agents may run indefinitely, so process-manager keeps
   * only the most recent output up to this limit.
   */
  outputLimitBytes?: number;
  /** Signals the leader intends to use for clean shutdowns. */
  expectedExitSignals?: readonly NodeJS.Signals[];
  spawnImpl?: SpawnProcess;
};

export type ChildRuntimeExit = {
  metadata: ChildRuntimeMetadata;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  error?: Error;
  crashed: boolean;
  expectedExit: boolean;
};

type SpawnedChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export type SpawnedChildRuntime = {
  child: SpawnedChildProcess;
  metadata: ChildRuntimeMetadata;
  completion: Promise<ChildRuntimeExit>;
};

export type SpawnProcess = typeof spawn;

export const DEFAULT_CHILD_RUNTIME_OUTPUT_LIMIT_BYTES = 64 * 1024;

export class TeamProcessManagerError extends Error {
  readonly code: "runtime-entry-missing";

  constructor(
    code: TeamProcessManagerError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TeamProcessManagerError";
    this.code = code;
  }
}

/**
 * Resolve the child-runtime module path.
 *
 * Production packages should provide a sibling `runtime-entry.js` file. When
 * developing locally under Bun, the resolver may fall back to `runtime-entry.ts`
 * because Bun can execute TypeScript directly without `tsx`.
 */
export function resolveRuntimeEntryPath(
  options: ResolveRuntimeEntryPathOptions = {},
): ResolvedRuntimeEntryPath {
  const fileExists = options.fileExists ?? existsSync;
  if (options.runtimeEntryPath !== undefined) {
    const explicitPath = resolve(options.runtimeEntryPath);
    if (!fileExists(explicitPath)) {
      throw new TeamProcessManagerError(
        "runtime-entry-missing",
        `Child runtime entrypoint "${explicitPath}" was not found`,
      );
    }

    return {
      path: explicitPath,
      language: explicitPath.endsWith(".ts") ? "typescript" : "javascript",
    };
  }

  const moduleUrl = options.processManagerModuleUrl ?? import.meta.url;
  const sourcePath = fileURLToPath(
    new URL("../agents/runtime-entry.ts", moduleUrl),
  );
  const jsPath = sourcePath.replace(/\.ts$/, ".js");

  if (fileExists(jsPath)) {
    return {
      path: jsPath,
      language: "javascript",
    };
  }

  const supportsTypeScriptEntrypoints =
    options.supportsTypeScriptEntrypoints ?? Boolean(process.versions.bun);
  if (supportsTypeScriptEntrypoints && fileExists(sourcePath)) {
    return {
      path: sourcePath,
      language: "typescript",
    };
  }

  throw new TeamProcessManagerError(
    "runtime-entry-missing",
    `No runnable JavaScript child runtime entrypoint was found next to "${sourcePath}". ` +
      `Publish the compiled runtime-entry.js file, or run under Bun during local development.`,
  );
}

/** Build the explicit CLI flags passed to the child runtime. */
export function buildChildRuntimeArgs(
  metadata: ChildRuntimeMetadata,
): string[] {
  const args = [
    "--role",
    metadata.role,
    "--team",
    metadata.teamName,
    "--agent",
    metadata.agentName,
    "--workspace",
    metadata.workspacePath,
    "--cwd",
    metadata.cwd,
    "--model",
    metadata.model,
    "--thinking",
    metadata.thinkingLevel,
    "--tools",
    metadata.tools.join(","),
  ];

  if (metadata.taskId !== undefined) {
    args.push("--task", metadata.taskId);
  }

  for (const [key, value] of Object.entries(metadata.env).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    args.push("--env", `${key}=${value}`);
  }

  return args;
}

/** Build the child process environment block. */
export function buildChildRuntimeEnv(
  metadata: ChildRuntimeMetadata,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...metadata.env,
    [TEAM_CHILD_ROLE_ENV_VAR]: metadata.role,
    [TEAM_CHILD_TEAM_NAME_ENV_VAR]: metadata.teamName,
    [TEAM_CHILD_AGENT_NAME_ENV_VAR]: metadata.agentName,
  };

  if (metadata.taskId !== undefined) {
    env[TEAM_CHILD_TASK_ID_ENV_VAR] = metadata.taskId;
  } else {
    delete env[TEAM_CHILD_TASK_ID_ENV_VAR];
  }

  return env;
}

/** Spawn a team child runtime and capture its eventual completion details. */
export function spawnChildRuntime(
  options: SpawnChildRuntimeOptions,
): SpawnedChildRuntime {
  const metadata = normalizeChildRuntimeMetadata(options);
  const entryPath = resolveRuntimeEntryPath({
    runtimeEntryPath: options.runtimeEntryPath,
    supportsTypeScriptEntrypoints: options.supportsTypeScriptEntrypoints,
  });
  const command = options.execPath ?? process.execPath;
  const args = [entryPath.path, ...buildChildRuntimeArgs(metadata)];
  const spawnProcess = options.spawnImpl ?? defaultSpawn;

  const child = spawnProcess(command, args, {
    cwd: metadata.cwd,
    env: buildChildRuntimeEnv(metadata, options.baseEnv),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"] as const,
  }) as unknown as SpawnedChildProcess;

  const completion = buildCompletionPromise(child, metadata, options);

  return {
    child,
    metadata,
    completion,
  };
}

function buildCompletionPromise(
  child: SpawnedChildProcess,
  metadata: ChildRuntimeMetadata,
  options: Pick<
    SpawnChildRuntimeOptions,
    "outputLimitBytes" | "expectedExitSignals"
  >,
): Promise<ChildRuntimeExit> {
  const outputLimitBytes =
    options.outputLimitBytes ?? DEFAULT_CHILD_RUNTIME_OUTPUT_LIMIT_BYTES;
  const expectedExitSignals = new Set(options.expectedExitSignals ?? []);

  let stdout = "";
  let stderr = "";
  let stdoutTruncated = false;
  let stderrTruncated = false;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk: string | Buffer) => {
    const next = appendCapturedOutput(stdout, chunk, outputLimitBytes);
    stdout = next.output;
    stdoutTruncated ||= next.truncated;
  });
  child.stderr.on("data", (chunk: string | Buffer) => {
    const next = appendCapturedOutput(stderr, chunk, outputLimitBytes);
    stderr = next.output;
    stderrTruncated ||= next.truncated;
  });

  return new Promise<ChildRuntimeExit>((resolveCompletion) => {
    let settled = false;

    const finish = (result: Omit<ChildRuntimeExit, "metadata">): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolveCompletion({
        ...result,
        metadata,
      });
    };

    child.on("error", (error: Error) => {
      finish({
        code: null,
        signal: null,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        error,
        crashed: true,
        expectedExit: false,
      });
    });

    child.on("close", (code, signal) => {
      const expectedExit =
        (code === 0 && signal === null) ||
        (signal !== null && expectedExitSignals.has(signal));
      finish({
        code,
        signal,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        crashed: !expectedExit,
        expectedExit,
      });
    });
  });
}

function appendCapturedOutput(
  currentOutput: string,
  chunk: string | Buffer,
  outputLimitBytes: number,
): { output: string; truncated: boolean } {
  const nextChunk = chunk.toString();
  const combinedOutput = currentOutput + nextChunk;

  if (Buffer.byteLength(combinedOutput, "utf8") <= outputLimitBytes) {
    return {
      output: combinedOutput,
      truncated: false,
    };
  }

  const truncatedOutput = Buffer.from(combinedOutput, "utf8")
    .subarray(-outputLimitBytes)
    .toString("utf8");
  return {
    output: truncatedOutput,
    truncated: true,
  };
}

function normalizeChildRuntimeMetadata(
  options: SpawnChildRuntimeOptions,
): ChildRuntimeMetadata {
  return {
    role: options.role,
    teamName: options.teamName,
    agentName: options.agentName,
    workspacePath: resolve(options.workspacePath),
    cwd: resolve(options.cwd ?? options.workspacePath),
    taskId: options.taskId,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    tools: [...options.tools],
    env: { ...(options.env ?? {}) },
  };
}

const defaultSpawn: SpawnProcess = spawn;

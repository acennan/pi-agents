import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildChildRuntimeArgs,
  buildChildRuntimeEnv,
  resolveRuntimeEntryPath,
  spawnChildRuntime,
} from "../leader/process-manager.ts";

const TEST_ROOT = join(tmpdir(), "pi-teams-process-manager-test-tmp");

beforeEach(async () => {
  await mkdir(TEST_ROOT, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

describe("resolveRuntimeEntryPath", () => {
  it("prefers a runnable JavaScript runtime entrypoint when present", async () => {
    const leaderDir = join(TEST_ROOT, "entry-js", "leader");
    const agentsDir = join(TEST_ROOT, "entry-js", "agents");
    await mkdir(leaderDir, { recursive: true });
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, "runtime-entry.ts"),
      "export {};\n",
      "utf8",
    );
    await writeFile(
      join(agentsDir, "runtime-entry.js"),
      "export {};\n",
      "utf8",
    );

    const result = resolveRuntimeEntryPath({
      processManagerModuleUrl: pathToFileURL(
        join(leaderDir, "process-manager.ts"),
      ).href,
      fileExists: (path) => path.endsWith("runtime-entry.js"),
      supportsTypeScriptEntrypoints: true,
    });

    expect(result.language).toBe("javascript");
    expect(result.path).toBe(join(agentsDir, "runtime-entry.js"));
  });

  it("falls back to the TypeScript source only when direct execution is supported", () => {
    const leaderDir = join(TEST_ROOT, "entry-ts", "leader");
    const agentsDir = join(TEST_ROOT, "entry-ts", "agents");
    const result = resolveRuntimeEntryPath({
      processManagerModuleUrl: pathToFileURL(
        join(leaderDir, "process-manager.ts"),
      ).href,
      fileExists: (path) => path === join(agentsDir, "runtime-entry.ts"),
      supportsTypeScriptEntrypoints: true,
    });

    expect(result).toEqual({
      path: join(agentsDir, "runtime-entry.ts"),
      language: "typescript",
    });
  });

  it("rejects missing JavaScript entrypoints when TypeScript execution is unavailable", () => {
    const leaderDir = join(TEST_ROOT, "entry-missing", "leader");
    const agentsDir = join(TEST_ROOT, "entry-missing", "agents");

    expect(() =>
      resolveRuntimeEntryPath({
        processManagerModuleUrl: pathToFileURL(
          join(leaderDir, "process-manager.ts"),
        ).href,
        fileExists: (path) => path === join(agentsDir, "runtime-entry.ts"),
        supportsTypeScriptEntrypoints: false,
      }),
    ).toThrow("No runnable JavaScript child runtime entrypoint");
  });
});

describe("buildChildRuntimeArgs/buildChildRuntimeEnv", () => {
  it("serializes explicit role/team/task/env values for the child runtime", () => {
    const metadata = {
      role: "code" as const,
      teamName: "alpha",
      agentName: "code-1",
      workspacePath: "/tmp/workspace",
      cwd: "/tmp/workspace/task-1",
      taskId: "pi-agents-321",
      model: "anthropic/claude-opus-4-5",
      thinkingLevel: "medium" as const,
      tools: ["read", "bash", "edit"] as const,
      env: {
        PI_TEAM_MAX_REVIEW_CYCLES: "3",
        CUSTOM_FLAG: "enabled",
      },
    };

    expect(buildChildRuntimeArgs(metadata)).toEqual([
      "--role",
      "code",
      "--team",
      "alpha",
      "--agent",
      "code-1",
      "--workspace",
      "/tmp/workspace",
      "--cwd",
      "/tmp/workspace/task-1",
      "--model",
      "anthropic/claude-opus-4-5",
      "--thinking",
      "medium",
      "--tools",
      "read,bash,edit",
      "--task",
      "pi-agents-321",
      "--env",
      "CUSTOM_FLAG=enabled",
      "--env",
      "PI_TEAM_MAX_REVIEW_CYCLES=3",
    ]);

    expect(
      buildChildRuntimeEnv(metadata, {
        PATH: "/usr/bin",
        PI_TEAM_TASK_ID: "stale-task-id",
      }),
    ).toMatchObject({
      PATH: "/usr/bin",
      PI_TEAM_ROLE: "code",
      PI_TEAM_NAME: "alpha",
      PI_TEAM_AGENT_NAME: "code-1",
      PI_TEAM_TASK_ID: "pi-agents-321",
      PI_TEAM_MAX_REVIEW_CYCLES: "3",
      CUSTOM_FLAG: "enabled",
    });
  });
});

describe("spawnChildRuntime", () => {
  it("spawns the runtime with explicit args and captures stdout/stderr", async () => {
    const fixturePath = join(TEST_ROOT, "fixtures", "capture-runtime.js");
    await mkdir(dirname(fixturePath), { recursive: true });
    await writeFile(
      fixturePath,
      [
        "process.stdout.write(JSON.stringify({",
        "  argv: process.argv.slice(2),",
        "  env: {",
        "    role: process.env.PI_TEAM_ROLE,",
        "    team: process.env.PI_TEAM_NAME,",
        "    agent: process.env.PI_TEAM_AGENT_NAME,",
        "    task: process.env.PI_TEAM_TASK_ID,",
        "    extra: process.env.EXTRA_TEAM_ENV,",
        "  },",
        '}) + "\\n");',
        'process.stderr.write("child-stderr");',
      ].join("\n"),
      "utf8",
    );

    const { completion } = spawnChildRuntime({
      role: "code",
      teamName: "alpha",
      agentName: "code-1",
      workspacePath: TEST_ROOT,
      cwd: TEST_ROOT,
      taskId: "pi-agents-321",
      model: "anthropic/claude-opus-4-5",
      thinkingLevel: "medium",
      tools: ["read", "bash"],
      env: {
        EXTRA_TEAM_ENV: "enabled",
      },
      runtimeEntryPath: fixturePath,
    });

    const result = await completion;
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.crashed).toBe(false);
    expect(result.expectedExit).toBe(true);
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stderrTruncated).toBe(false);
    expect(result.stderr).toBe("child-stderr");

    const payload = JSON.parse(result.stdout.trim()) as {
      argv: string[];
      env: Record<string, string>;
    };
    expect(payload.argv).toEqual([
      "--role",
      "code",
      "--team",
      "alpha",
      "--agent",
      "code-1",
      "--workspace",
      TEST_ROOT,
      "--cwd",
      TEST_ROOT,
      "--model",
      "anthropic/claude-opus-4-5",
      "--thinking",
      "medium",
      "--tools",
      "read,bash",
      "--task",
      "pi-agents-321",
      "--env",
      "EXTRA_TEAM_ENV=enabled",
    ]);
    expect(payload.env).toEqual({
      role: "code",
      team: "alpha",
      agent: "code-1",
      task: "pi-agents-321",
      extra: "enabled",
    });
  });

  it("captures spawn failures as runtime errors", async () => {
    const fixturePath = join(TEST_ROOT, "fixtures", "missing-runtime.js");
    await mkdir(dirname(fixturePath), { recursive: true });
    await writeFile(fixturePath, "process.exit(0);\n", "utf8");

    const { completion } = spawnChildRuntime({
      role: "commit",
      teamName: "alpha",
      agentName: "commit-1",
      workspacePath: TEST_ROOT,
      model: "anthropic/claude-opus-4-5",
      thinkingLevel: "off",
      tools: ["read", "bash"],
      runtimeEntryPath: fixturePath,
      execPath: join(TEST_ROOT, "definitely-missing-binary"),
    });

    const result = await completion;
    expect(result.crashed).toBe(true);
    expect(result.expectedExit).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.code).toBeNull();
  });

  it("caps retained stdout/stderr for long-running runtimes", async () => {
    const fixturePath = join(TEST_ROOT, "fixtures", "noisy-runtime.js");
    await mkdir(dirname(fixturePath), { recursive: true });
    await writeFile(
      fixturePath,
      [
        'process.stdout.write("1234567890ABCDE");',
        'process.stdout.write("FGHIJ");',
        'process.stderr.write("stderr-1234567890");',
      ].join("\n"),
      "utf8",
    );

    const { completion } = spawnChildRuntime({
      role: "code",
      teamName: "alpha",
      agentName: "code-1",
      workspacePath: TEST_ROOT,
      cwd: TEST_ROOT,
      model: "anthropic/claude-opus-4-5",
      thinkingLevel: "medium",
      tools: ["read"],
      runtimeEntryPath: fixturePath,
      outputLimitBytes: 10,
    });

    const result = await completion;
    expect(result.stdout).toBe("ABCDEFGHIJ");
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderr).toBe("1234567890");
    expect(result.stderrTruncated).toBe(true);
  });

  it("treats expected shutdown signals as non-crashing exits", async () => {
    const fixturePath = join(TEST_ROOT, "fixtures", "signal-runtime.js");
    await mkdir(dirname(fixturePath), { recursive: true });
    await writeFile(fixturePath, "setInterval(() => {}, 1000);\n", "utf8");

    const spawned = spawnChildRuntime({
      role: "code",
      teamName: "alpha",
      agentName: "code-1",
      workspacePath: TEST_ROOT,
      cwd: TEST_ROOT,
      model: "anthropic/claude-opus-4-5",
      thinkingLevel: "medium",
      tools: ["read"],
      runtimeEntryPath: fixturePath,
      expectedExitSignals: ["SIGTERM"],
    });

    spawned.child.kill("SIGTERM");
    const result = await spawned.completion;
    expect(result.signal).toBe("SIGTERM");
    expect(result.expectedExit).toBe(true);
    expect(result.crashed).toBe(false);
  });
});

/**
 * YAML config parsing and validation for team configurations (TF-03).
 *
 * The loader reads a YAML string or file path, normalises documented YAML
 * aliases into the internal schema shape, validates the result, emits warnings
 * when entries inherit unrestricted leader access, and optionally verifies that
 * referenced prompt-template files exist.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  type AgentEntry,
  type TeamConfig,
  TeamConfigSchema,
} from "./schema.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Successful result returned by the loader. */
export type LoadResult = {
  /** The validated, type-safe team configuration. */
  config: TeamConfig;
  /** Non-fatal warnings that the caller should surface to the user. */
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse and validate a YAML string as a `TeamConfig`.
 *
 * Returns `{ config, warnings }` on success.
 * Throws `TeamConfigError` with an actionable message on invalid input.
 */
export function parseTeamConfig(
  yaml: string,
  promptTemplatesDir?: string,
): LoadResult {
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new TeamConfigError(`YAML parse error: ${message}`, { cause: err });
  }

  return validateTeamConfigValue(raw, promptTemplatesDir);
}

/**
 * Validate a parsed config object and optionally verify referenced
 * prompt-template files.
 *
 * This is useful when the config has already been parsed (for example when
 * loading the persisted snapshot from `team-config.yaml` during restart).
 */
export function validateTeamConfigValue(
  value: unknown,
  promptTemplatesDir?: string,
): LoadResult {
  const normalized = normalizeTeamConfig(value);
  const result = TeamConfigSchema.safeParse(normalized);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
        return `  - ${path}${issue.message}`;
      })
      .join("\n");
    throw new TeamConfigError(`Invalid team configuration:\n${issues}`);
  }

  const config = result.data;

  if (promptTemplatesDir !== undefined) {
    checkPromptTemplateFiles(config, promptTemplatesDir);
  }

  return {
    config,
    warnings: collectWarnings(config),
  };
}

/**
 * Load and validate a `TeamConfig` from a YAML file.
 *
 * Returns `{ config, warnings }` on success.
 * Throws `TeamConfigError` with an actionable message on file-read error or
 * invalid config.
 */
export async function loadTeamConfigFile(
  filePath: string,
  promptTemplatesDir?: string,
): Promise<LoadResult> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new TeamConfigError(
      `Cannot read config file "${filePath}": ${message}`,
      { cause: err },
    );
  }

  return parseTeamConfig(content, promptTemplatesDir);
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/** Thrown when a team config cannot be parsed or fails validation. */
export class TeamConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TeamConfigError";
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalise documented YAML aliases into the internal schema shape.
 *
 * Supported aliases:
 * - `sub-agents` -> `subAgents`
 * - `thinkingLevel` -> `thinking`
 * - legacy camelCase `subAgents`
 */
function normalizeTeamConfig(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  const normalized: Record<string, unknown> = {};

  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = normalizeTopLevelKey(rawKey);
    const nextValue =
      key === "agents" || key === "subAgents"
        ? Array.isArray(rawValue)
          ? rawValue.map((entry, index) =>
              normalizeEntry(entry, `${rawKey}[${index}]`),
            )
          : rawValue
        : rawValue;

    assignNormalizedKey(normalized, key, rawKey, nextValue, "team config");
  }

  return normalized;
}

function normalizeEntry(value: unknown, context: string): unknown {
  if (!isRecord(value)) {
    return value;
  }

  const normalized: Record<string, unknown> = {};

  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = normalizeEntryKey(rawKey);
    assignNormalizedKey(normalized, key, rawKey, rawValue, context);
  }

  return normalized;
}

function normalizeTopLevelKey(rawKey: string): string {
  switch (rawKey) {
    case "sub-agents":
    case "subAgents":
      return "subAgents";
    case "thinkingLevel":
      return "thinking";
    default:
      return rawKey;
  }
}

function normalizeEntryKey(rawKey: string): string {
  switch (rawKey) {
    case "thinkingLevel":
      return "thinking";
    default:
      return rawKey;
  }
}

function assignNormalizedKey(
  target: Record<string, unknown>,
  normalizedKey: string,
  rawKey: string,
  value: unknown,
  context: string,
): void {
  if (normalizedKey in target) {
    throw new TeamConfigError(
      `Invalid ${context}: multiple fields map to "${normalizedKey}" (including "${rawKey}")`,
    );
  }
  target[normalizedKey] = value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Verify that every `promptTemplate` filename referenced in the config exists
 * as a file inside `templatesDir`.
 */
function checkPromptTemplateFiles(
  config: TeamConfig,
  templatesDir: string,
): void {
  const normalizedTemplatesDir = resolve(templatesDir);
  const allEntries = [
    ...config.agents.map((entry) => ({ entry, kind: "Agent" as const })),
    ...(config.subAgents ?? []).map((entry) => ({
      entry,
      kind: "Sub-agent" as const,
    })),
  ];

  for (const { entry, kind } of allEntries) {
    if (entry.promptTemplate === undefined) {
      continue;
    }

    const fullPath = resolve(normalizedTemplatesDir, entry.promptTemplate);
    const relativePath = relative(normalizedTemplatesDir, fullPath);
    if (relativePath.startsWith("..")) {
      throw new TeamConfigError(
        `${kind} "${entry.type}" (nameTemplate: "${entry.nameTemplate}") references prompt template ` +
          `"${entry.promptTemplate}" outside "${normalizedTemplatesDir}"`,
      );
    }

    if (!existsSync(fullPath)) {
      throw new TeamConfigError(
        `${kind} "${entry.type}" (nameTemplate: "${entry.nameTemplate}") references prompt template ` +
          `"${entry.promptTemplate}" which was not found in "${normalizedTemplatesDir}"`,
      );
    }
  }
}

/**
 * Collect non-fatal warnings from a validated config.
 *
 * Warn only when an entry omits `tools` and there is no top-level fallback,
 * because that means the spawned runtime will inherit full leader access.
 */
function collectWarnings(config: TeamConfig): string[] {
  const warnings: string[] = [];

  const checkEntry = (entry: AgentEntry, kind: "Agent" | "Sub-agent") => {
    if (entry.tools === undefined && config.tools === undefined) {
      warnings.push(
        `${kind} "${entry.type}" (nameTemplate: "${entry.nameTemplate}") does not specify a ` +
          `tools list — it will inherit full leader access`,
      );
    }
  };

  for (const entry of config.agents) {
    checkEntry(entry, "Agent");
  }

  for (const entry of config.subAgents ?? []) {
    checkEntry(entry, "Sub-agent");
  }

  return warnings;
}

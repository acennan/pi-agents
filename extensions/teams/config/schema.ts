/**
 * Zod schema and derived types for team configuration.
 *
 * The documented YAML format uses kebab-case for `sub-agents`, plain
 * `nameTemplate` prefixes such as `code`, and optional top-level / per-entry
 * `tools`, `model`, and `thinking` inheritance.
 *
 * The loader normalises YAML aliases into the internal camelCase shape used by
 * this module before validation:
 *
 * - `sub-agents` -> `subAgents`
 * - `thinkingLevel` -> `thinking`
 * - `default-*-agent` type names -> short internal type names
 */

import { basename } from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** All tool names recognised by the Pi coding agent. */
export const TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
] as const;

/** All valid internal agent and sub-agent role names. */
export const AGENT_TYPES = [
  "code",
  "simplify",
  "review",
  "test",
  "commit",
] as const;

/** The documented YAML type names accepted by the loader. */
export const YAML_AGENT_TYPE_NAMES = [
  "default-code-agent",
  "default-simplify-agent",
  "default-review-agent",
  "default-test-agent",
  "default-commit-agent",
] as const;

const RAW_AGENT_TYPES = [...AGENT_TYPES, ...YAML_AGENT_TYPE_NAMES] as const;

const YAML_AGENT_TYPE_TO_INTERNAL = {
  "default-code-agent": "code",
  "default-simplify-agent": "simplify",
  "default-review-agent": "review",
  "default-test-agent": "test",
  "default-commit-agent": "commit",
} as const;

// ---------------------------------------------------------------------------
// Derived primitive types
// ---------------------------------------------------------------------------

export type ToolName = (typeof TOOL_NAMES)[number];
export type AgentType = (typeof AGENT_TYPES)[number];
type RawAgentType = (typeof RAW_AGENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Zod leaf schemas
// ---------------------------------------------------------------------------

export const ToolNameSchema = z.enum(TOOL_NAMES);

const RawAgentTypeSchema = z.enum(RAW_AGENT_TYPES);

const PromptTemplateSchema = z
  .string()
  .min(1, "promptTemplate must not be empty")
  .refine((value) => value.endsWith(".md"), {
    message: "promptTemplate must be a .md filename",
  })
  .refine((value) => basename(value) === value, {
    message: "promptTemplate must be a filename only",
  });

// ---------------------------------------------------------------------------
// AgentEntry schema
// ---------------------------------------------------------------------------

export const AgentEntrySchema = z
  .object({
    /** Agent role. */
    type: RawAgentTypeSchema.transform(normalizeAgentType),
    /**
     * Name template for constructed instance names.
     *
     * The documented format uses a base name such as `code`, which expands to
     * `code-1`, `code-2`, ... Later compatibility code also accepts legacy
     * templates that already include `{n}`.
     */
    nameTemplate: z.string().min(1, "nameTemplate must not be empty"),
    /** Human-readable description of the entry. */
    description: z.string().min(1).optional(),
    /** Number of standing agents created from this entry. Defaults to 1. */
    count: z.number().int().min(1, "count must be at least 1").default(1),
    /**
     * Maximum number of concurrent instances allowed for this entry.
     *
     * For documented sub-agent configs this controls how many named slots may
     * exist concurrently (e.g. `review-1`, `review-2`, ...).
     */
    maxAllowed: z.number().int().min(1).optional(),
    /**
     * Explicit tool list for agents spawned from this entry.
     * When absent, the entry inherits the top-level tools list when present,
     * otherwise it inherits full leader access.
     */
    tools: z.array(ToolNameSchema).optional(),
    /** Model override for this entry. */
    model: z.string().min(1).optional(),
    /** Thinking-level override for this entry. */
    thinking: z.string().min(1).optional(),
    /** Filename of the prompt template in the shared prompt-template directory. */
    promptTemplate: PromptTemplateSchema.optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.maxAllowed !== undefined && entry.maxAllowed < entry.count) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `maxAllowed (${entry.maxAllowed}) must be >= count (${entry.count})`,
        path: ["maxAllowed"],
      });
    }
  });

// ---------------------------------------------------------------------------
// TeamConfig schema
// ---------------------------------------------------------------------------

export const TeamConfigSchema = z
  .object({
    /** Reusable template name from the YAML file. */
    name: z.string().min(1).optional(),
    /** Human-readable description of the team template. */
    description: z.string().min(1).optional(),
    /** Optional default tools inherited by entries that do not override them. */
    tools: z.array(ToolNameSchema).optional(),
    /** Default model inherited by entries that do not override it. */
    model: z.string().min(1).optional(),
    /** Default thinking level inherited by entries that do not override it. */
    thinking: z.string().min(1).optional(),
    /** Standing agent definitions (always-running processes, typically code agents). */
    agents: z
      .array(AgentEntrySchema)
      .min(1, "agents must contain at least one entry"),
    /** Short-lived sub-agent definitions (spawned on demand). */
    subAgents: z.array(AgentEntrySchema).optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const seen = new Set<string>();

    for (let index = 0; index < config.agents.length; index++) {
      const entry = config.agents[index];
      if (entry === undefined) continue;
      for (const name of expandNames(entry, "agent")) {
        if (seen.has(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Constructed instance name "${name}" is not unique — check nameTemplate and count across all agents and sub-agents`,
            path: ["agents", index, "nameTemplate"],
          });
        }
        seen.add(name);
      }
    }

    for (let index = 0; index < (config.subAgents ?? []).length; index++) {
      const entry = config.subAgents?.[index];
      if (entry === undefined) continue;
      for (const name of expandNames(entry, "subAgent")) {
        if (seen.has(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Constructed instance name "${name}" is not unique — check nameTemplate and count across all agents and sub-agents`,
            path: ["subAgents", index, "nameTemplate"],
          });
        }
        seen.add(name);
      }
    }
  });

// ---------------------------------------------------------------------------
// TypeScript types inferred from schemas
// ---------------------------------------------------------------------------

export type AgentEntry = z.infer<typeof AgentEntrySchema>;
export type TeamConfig = z.infer<typeof TeamConfigSchema>;

// ---------------------------------------------------------------------------
// Resolved / expanded types
// ---------------------------------------------------------------------------

/**
 * A concrete agent instance produced by expanding a config entry.
 *
 * Inherited top-level defaults are applied during expansion.
 */
export type ResolvedAgentDef = {
  /** Concrete instance name, e.g. `code-1`. */
  name: string;
  /** Human-readable description, if specified. */
  description: string | undefined;
  /** Agent role. */
  type: AgentType;
  /** Effective tool list after applying top-level inheritance. */
  tools: ToolName[] | undefined;
  /** Effective model after applying top-level inheritance. */
  model: string | undefined;
  /** Effective thinking level after applying top-level inheritance. */
  thinking: string | undefined;
  /** Prompt template filename, if specified. */
  promptTemplate: string | undefined;
  /** Maximum concurrent instances allowed for this entry, when specified. */
  maxAllowed: number | undefined;
};

export type EntryDefaults = {
  tools?: ToolName[];
  model?: string;
  thinking?: string;
};

export type EntryKind = "agent" | "subAgent";

// ---------------------------------------------------------------------------
// Expansion helpers
// ---------------------------------------------------------------------------

/** Expand a documented or legacy name template for one concrete instance index. */
export function expandInstanceName(
  nameTemplate: string,
  index: number,
): string {
  return nameTemplate.includes("{n}")
    ? nameTemplate.replaceAll("{n}", String(index))
    : `${nameTemplate}-${index}`;
}

/** Return the number of named instances represented by an entry. */
export function getEntryInstanceCount(
  entry: AgentEntry,
  kind: EntryKind,
): number {
  return kind === "subAgent" ? (entry.maxAllowed ?? entry.count) : entry.count;
}

/** Expand a single `AgentEntry` into its concrete `ResolvedAgentDef` instances. */
export function expandEntry(
  entry: AgentEntry,
  defaults: EntryDefaults = {},
  kind: EntryKind = "agent",
): ResolvedAgentDef[] {
  const defs: ResolvedAgentDef[] = [];
  const instanceCount = getEntryInstanceCount(entry, kind);

  for (let index = 1; index <= instanceCount; index++) {
    defs.push({
      name: expandInstanceName(entry.nameTemplate, index),
      description: entry.description,
      type: entry.type,
      tools: entry.tools ?? defaults.tools,
      model: entry.model ?? defaults.model,
      thinking: entry.thinking ?? defaults.thinking,
      promptTemplate: entry.promptTemplate,
      maxAllowed: entry.maxAllowed,
    });
  }

  return defs;
}

/** Expand all agents and sub-agents in a `TeamConfig` into concrete definitions. */
export function expandTeamConfig(config: TeamConfig): {
  agents: ResolvedAgentDef[];
  subAgents: ResolvedAgentDef[];
} {
  const defaults: EntryDefaults = {
    tools: config.tools,
    model: config.model,
    thinking: config.thinking,
  };

  return {
    agents: config.agents.flatMap((entry) =>
      expandEntry(entry, defaults, "agent"),
    ),
    subAgents: (config.subAgents ?? []).flatMap((entry) =>
      expandEntry(entry, defaults, "subAgent"),
    ),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizeAgentType(type: RawAgentType): AgentType {
  return type in YAML_AGENT_TYPE_TO_INTERNAL
    ? YAML_AGENT_TYPE_TO_INTERNAL[
        type as keyof typeof YAML_AGENT_TYPE_TO_INTERNAL
      ]
    : (type as AgentType);
}

function expandNames(entry: AgentEntry, kind: EntryKind): string[] {
  const names: string[] = [];
  const instanceCount = getEntryInstanceCount(entry, kind);

  for (let index = 1; index <= instanceCount; index++) {
    names.push(expandInstanceName(entry.nameTemplate, index));
  }

  return names;
}

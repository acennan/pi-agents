import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadTeamConfigFile,
  parseTeamConfig,
  TeamConfigError,
} from "../config/loader.ts";
import {
  expandEntry,
  expandInstanceName,
  expandTeamConfig,
  getEntryInstanceCount,
  TeamConfigSchema,
} from "../config/schema.ts";

const CONFIG_DIR = resolve(__dirname, "../config");

function documentedMinimalYaml(overrides = ""): string {
  return `
name: sample-team
description: Sample config used in tests
agents:
  - nameTemplate: code
    type: default-code-agent
    tools: [read, write, edit, bash, grep, find, ls]
    promptTemplate: code-prompt.md
${overrides}
`.trim();
}

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `pi-agents-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("parseTeamConfig — documented YAML shape", () => {
  it("parses the documented top-level and sub-agent keys", () => {
    const yaml = `
name: default-team
description: Example config
tools: [read, grep]
model: claude-opus-4
thinking: medium
agents:
  - nameTemplate: code
    description: Standing code agent
    type: default-code-agent
    tools: [read, write, edit, bash, grep, find, ls]
    promptTemplate: code-prompt.md
sub-agents:
  - nameTemplate: review
    description: Review worker
    type: default-review-agent
    maxAllowed: 2
    model: claude-sonnet-4
    thinking: low
    promptTemplate: review-prompt.md
`.trim();

    const { config, warnings } = parseTeamConfig(yaml);
    expect(config.name).toBe("default-team");
    expect(config.description).toBe("Example config");
    expect(config.tools).toEqual(["read", "grep"]);
    expect(config.model).toBe("claude-opus-4");
    expect(config.thinking).toBe("medium");
    expect(config.subAgents).toHaveLength(1);
    expect(config.subAgents?.[0]?.type).toBe("review");
    expect(config.subAgents?.[0]?.maxAllowed).toBe(2);
    expect(config.subAgents?.[0]?.model).toBe("claude-sonnet-4");
    expect(config.subAgents?.[0]?.thinking).toBe("low");
    expect(warnings).toHaveLength(0);
  });

  it("accepts legacy camelCase aliases for backwards compatibility", () => {
    const yaml = `
model: claude-opus-4
thinkingLevel: high
agents:
  - nameTemplate: code
    type: code
    tools: [read]
subAgents:
  - nameTemplate: review
    type: review
    maxAllowed: 1
    tools: [read, grep, find, ls]
`.trim();

    const { config } = parseTeamConfig(yaml);
    expect(config.thinking).toBe("high");
    expect(config.subAgents).toHaveLength(1);
    expect(config.subAgents?.[0]?.type).toBe("review");
  });

  it("rejects conflicting aliases for the same top-level field", () => {
    const yaml = `
thinking: low
thinkingLevel: high
agents:
  - nameTemplate: code
    type: code
    tools: [read]
`.trim();

    expect(() => parseTeamConfig(yaml)).toThrow(TeamConfigError);
    expect(() => parseTeamConfig(yaml)).toThrow(
      /multiple fields map to "thinking"/,
    );
  });

  it("rejects conflicting aliases for the same entry field", () => {
    const yaml = `
agents:
  - nameTemplate: code
    type: code
    tools: [read]
    thinking: low
    thinkingLevel: high
`.trim();

    expect(() => parseTeamConfig(yaml)).toThrow(TeamConfigError);
    expect(() => parseTeamConfig(yaml)).toThrow(
      /multiple fields map to "thinking"/,
    );
  });
});

describe("parseTeamConfig — strict validation", () => {
  it("rejects unknown top-level fields instead of silently dropping them", () => {
    const yaml = `
agents:
  - nameTemplate: code
    type: code
    tools: [read]
extraField: true
`.trim();

    expect(() => parseTeamConfig(yaml)).toThrow(TeamConfigError);
    expect(() => parseTeamConfig(yaml)).toThrow(/Unrecognized key/);
  });

  it("rejects unknown entry fields instead of silently dropping them", () => {
    const yaml = `
agents:
  - nameTemplate: code
    type: code
    tools: [read]
    extraField: true
`.trim();

    expect(() => parseTeamConfig(yaml)).toThrow(TeamConfigError);
    expect(() => parseTeamConfig(yaml)).toThrow(/Unrecognized key/);
  });

  it("rejects an unknown agent type", () => {
    const yaml = `
agents:
  - nameTemplate: architect
    type: architect
    tools: [read]
`.trim();

    expect(() => parseTeamConfig(yaml)).toThrow(TeamConfigError);
  });

  it("rejects an unknown tool name", () => {
    const yaml = `
agents:
  - nameTemplate: code
    type: code
    tools: [read, curl]
`.trim();

    expect(() => parseTeamConfig(yaml)).toThrow(TeamConfigError);
  });

  it("throws TeamConfigError on malformed YAML", () => {
    expect(() => parseTeamConfig("agents: [unclosed")).toThrow(TeamConfigError);
    expect(() => parseTeamConfig("agents: [unclosed")).toThrow(
      /YAML parse error/,
    );
  });
});

describe("parseTeamConfig — nameTemplate and count semantics", () => {
  it("accepts documented nameTemplate prefixes without a {n} placeholder", () => {
    const { config } = parseTeamConfig(
      `
agents:
  - nameTemplate: code
    type: code
    tools: [read]
`.trim(),
    );

    expect(config.agents[0]?.nameTemplate).toBe("code");
  });

  it("defaults count to 1 when omitted", () => {
    const { config } = parseTeamConfig(
      `
agents:
  - nameTemplate: code
    type: code
    tools: [read]
`.trim(),
    );

    expect(config.agents[0]?.count).toBe(1);
  });

  it("still supports legacy templates containing {n}", () => {
    const { config } = parseTeamConfig(
      `
agents:
  - nameTemplate: code-{n}
    type: code
    tools: [read]
`.trim(),
    );

    expect(config.agents[0]?.nameTemplate).toBe("code-{n}");
  });

  it("rejects count of zero", () => {
    const yaml = `
agents:
  - nameTemplate: code
    type: code
    count: 0
    tools: [read]
`.trim();

    expect(() => parseTeamConfig(yaml)).toThrow(TeamConfigError);
  });

  it("rejects maxAllowed less than count", () => {
    const yaml = `
agents:
  - nameTemplate: code
    type: code
    count: 3
    maxAllowed: 2
    tools: [read]
`.trim();

    expect(() => parseTeamConfig(yaml)).toThrow(TeamConfigError);
    expect(() => parseTeamConfig(yaml)).toThrow(/maxAllowed/);
  });
});

describe("parseTeamConfig — instance name uniqueness", () => {
  it("rejects duplicate instance names across agents", () => {
    const yaml = `
agents:
  - nameTemplate: code
    type: code
    count: 2
    tools: [read]
  - nameTemplate: code
    type: code
    tools: [write]
`.trim();

    expect(() => parseTeamConfig(yaml)).toThrow(TeamConfigError);
    expect(() => parseTeamConfig(yaml)).toThrow(/not unique/);
  });

  it("rejects duplicate instance names across agents and sub-agents", () => {
    const yaml = `
agents:
  - nameTemplate: worker
    type: code
    tools: [read]
sub-agents:
  - nameTemplate: worker
    type: default-review-agent
    maxAllowed: 1
    tools: [read, grep, find, ls]
`.trim();

    expect(() => parseTeamConfig(yaml)).toThrow(TeamConfigError);
    expect(() => parseTeamConfig(yaml)).toThrow(/not unique/);
  });

  it("includes the colliding nameTemplate path in uniqueness errors", () => {
    const result = TeamConfigSchema.safeParse({
      agents: [
        { nameTemplate: "code", type: "code", count: 2, tools: ["read"] },
        { nameTemplate: "code", type: "code", tools: ["write"] },
      ],
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    const issue = result.error.issues.find((item) =>
      item.message.includes("not unique"),
    );
    expect(issue?.path).toEqual(["agents", 1, "nameTemplate"]);
  });

  it("points to subAgents when a sub-agent collides", () => {
    const result = TeamConfigSchema.safeParse({
      agents: [{ nameTemplate: "worker", type: "code", tools: ["read"] }],
      subAgents: [
        {
          nameTemplate: "worker",
          type: "review",
          maxAllowed: 1,
          tools: ["read", "grep", "find", "ls"],
        },
      ],
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    const issue = result.error.issues.find((item) =>
      item.message.includes("not unique"),
    );
    expect(issue?.path).toEqual(["subAgents", 0, "nameTemplate"]);
  });
});

describe("expand helpers", () => {
  it("expands documented nameTemplate prefixes to numbered names", () => {
    expect(expandInstanceName("code", 1)).toBe("code-1");
    expect(expandInstanceName("review", 2)).toBe("review-2");
  });

  it("keeps legacy {n} templates working", () => {
    expect(expandInstanceName("code-{n}", 2)).toBe("code-2");
  });

  it("uses count for standing agents", () => {
    const { config } = parseTeamConfig(
      `
agents:
  - nameTemplate: code
    type: code
    count: 3
    tools: [read]
`.trim(),
    );

    const [agent] = config.agents;
    expect(agent).toBeDefined();
    if (agent === undefined) {
      throw new Error("Expected first agent to be defined");
    }
    expect(getEntryInstanceCount(agent, "agent")).toBe(3);
  });

  it("uses maxAllowed for sub-agent expansion", () => {
    const { config } = parseTeamConfig(
      `
agents:
  - nameTemplate: code
    type: code
    tools: [read]
sub-agents:
  - nameTemplate: review
    type: review
    maxAllowed: 2
    tools: [read, grep, find, ls]
`.trim(),
    );

    const [subAgent] = config.subAgents ?? [];
    expect(subAgent).toBeDefined();
    if (subAgent === undefined) {
      throw new Error("Expected first sub-agent to be defined");
    }
    expect(getEntryInstanceCount(subAgent, "subAgent")).toBe(2);
  });

  it("applies top-level tools/model/thinking inheritance during expansion", () => {
    const { config } = parseTeamConfig(
      `
tools: [read, grep]
model: claude-opus-4
thinking: medium
agents:
  - nameTemplate: code
    type: code
sub-agents:
  - nameTemplate: review
    type: review
    maxAllowed: 2
    model: claude-sonnet-4
    tools: [read, grep, find, ls]
`.trim(),
    );

    const { agents, subAgents } = expandTeamConfig(config);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      name: "code-1",
      tools: ["read", "grep"],
      model: "claude-opus-4",
      thinking: "medium",
    });
    expect(subAgents).toHaveLength(2);
    expect(subAgents[0]).toMatchObject({
      name: "review-1",
      tools: ["read", "grep", "find", "ls"],
      model: "claude-sonnet-4",
      thinking: "medium",
      maxAllowed: 2,
    });
  });

  it("expands a single entry with inherited defaults", () => {
    const defs = expandEntry(
      {
        nameTemplate: "code",
        type: "code",
        count: 1,
      },
      {
        tools: ["read", "write"],
        model: "claude-opus-4",
        thinking: "high",
      },
    );

    expect(defs[0]).toEqual({
      name: "code-1",
      description: undefined,
      type: "code",
      tools: ["read", "write"],
      model: "claude-opus-4",
      thinking: "high",
      promptTemplate: undefined,
      maxAllowed: undefined,
    });
  });
});

describe("parseTeamConfig — warnings", () => {
  it("warns when an entry omits tools and no top-level tools exist", () => {
    const { warnings } = parseTeamConfig(
      `
agents:
  - nameTemplate: code
    type: code
`.trim(),
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/full leader access/);
  });

  it("does not warn when an omitted entry tool list inherits top-level tools", () => {
    const { warnings } = parseTeamConfig(
      `
tools: [read, grep]
agents:
  - nameTemplate: code
    type: code
`.trim(),
    );

    expect(warnings).toHaveLength(0);
  });

  it("warns for sub-agents that omit tools with no top-level fallback", () => {
    const { warnings } = parseTeamConfig(
      `
agents:
  - nameTemplate: code
    type: code
    tools: [read]
sub-agents:
  - nameTemplate: review
    type: review
`.trim(),
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Sub-agent/);
  });
});

describe("parseTeamConfig — promptTemplate validation", () => {
  it("rejects promptTemplate values without a .md extension", () => {
    const yaml = `
agents:
  - nameTemplate: code
    type: code
    tools: [read]
    promptTemplate: code-prompt
`.trim();

    expect(() => parseTeamConfig(yaml)).toThrow(TeamConfigError);
  });

  it("rejects promptTemplate paths that are not bare filenames", () => {
    const yaml = `
agents:
  - nameTemplate: code
    type: code
    tools: [read]
    promptTemplate: ../escape/outside.md
`.trim();

    expect(() => parseTeamConfig(yaml)).toThrow(TeamConfigError);
    expect(() => parseTeamConfig(yaml)).toThrow(/filename only/);
  });

  it("verifies referenced templates exist in the provided directory", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "code-prompt.md"), "# code\n");
      expect(() => parseTeamConfig(documentedMinimalYaml(), dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when a referenced template is missing", () => {
    const dir = makeTempDir();
    try {
      expect(() => parseTeamConfig(documentedMinimalYaml(), dir)).toThrow(
        TeamConfigError,
      );
      expect(() => parseTeamConfig(documentedMinimalYaml(), dir)).toThrow(
        /code-prompt\.md/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checks sub-agent templates as well as agent templates", () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "code-prompt.md"), "# code\n");
      const yaml = `
agents:
  - nameTemplate: code
    type: code
    tools: [read]
    promptTemplate: code-prompt.md
sub-agents:
  - nameTemplate: review
    type: review
    maxAllowed: 1
    tools: [read, grep, find, ls]
    promptTemplate: review-prompt.md
`.trim();

      expect(() => parseTeamConfig(yaml, dir)).toThrow(TeamConfigError);
      expect(() => parseTeamConfig(yaml, dir)).toThrow(/review-prompt\.md/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadTeamConfigFile", () => {
  it("loads the bundled default-team.yaml successfully", async () => {
    const { config, warnings } = await loadTeamConfigFile(
      join(CONFIG_DIR, "default-team.yaml"),
    );

    expect(config.name).toBe("default-team");
    expect(config.description).toMatch(/default team/i);
    expect(config.agents).toHaveLength(1);
    expect(config.subAgents).toHaveLength(4);
    expect(warnings).toHaveLength(0);
  });

  it("throws TeamConfigError when the file does not exist", async () => {
    await expect(
      loadTeamConfigFile("/nonexistent/path/team.yaml"),
    ).rejects.toThrow(TeamConfigError);
    await expect(
      loadTeamConfigFile("/nonexistent/path/team.yaml"),
    ).rejects.toThrow(/Cannot read config file/);
  });

  it("forwards promptTemplatesDir and rejects missing bundled templates", async () => {
    const dir = makeTempDir();
    try {
      await expect(
        loadTeamConfigFile(join(CONFIG_DIR, "default-team.yaml"), dir),
      ).rejects.toThrow(TeamConfigError);
      await expect(
        loadTeamConfigFile(join(CONFIG_DIR, "default-team.yaml"), dir),
      ).rejects.toThrow(/not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("default-team.yaml", () => {
  async function loadDefault() {
    return loadTeamConfigFile(join(CONFIG_DIR, "default-team.yaml"));
  }

  it("uses the documented config shape and normalises agent types", async () => {
    const { config } = await loadDefault();

    expect(config.agents[0]?.nameTemplate).toBe("code");
    expect(config.agents[0]?.type).toBe("code");
    expect(config.subAgents?.map((entry) => entry.type)).toEqual([
      "review",
      "simplify",
      "test",
      "commit",
    ]);
  });

  it("carries explicit tool lists for every entry", async () => {
    const { config } = await loadDefault();

    for (const entry of config.agents) {
      expect(entry.tools).toBeDefined();
    }
    for (const entry of config.subAgents ?? []) {
      expect(entry.tools).toBeDefined();
    }
  });

  it("expands to the expected concrete instance names", async () => {
    const { config } = await loadDefault();
    const { agents, subAgents } = expandTeamConfig(config);

    expect(agents.map((entry) => entry.name)).toEqual(["code-1", "code-2"]);
    expect(subAgents.map((entry) => entry.name)).toEqual([
      "review-1",
      "simplify-1",
      "test-1",
      "commit-1",
    ]);
  });
});

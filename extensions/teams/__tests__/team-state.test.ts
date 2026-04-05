import type {
  ExtensionCommandContext,
  ExtensionUIContext,
} from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  createTeamModeAutocompleteProvider,
  createTeamModeHelpText,
  createTeamModeHotkeysText,
  parseCreateCommandArgs,
  parseRestartCommandArgs,
  resolveCreateCommandPaths,
  TEAM_MODE_FREE_TEXT_MESSAGE,
  TEAM_MODE_OPERATOR_SUBCOMMANDS,
  TEAM_MODE_SLASH_COMMAND_MESSAGE,
  TeamModeState,
  validateTeamModeInput,
} from "../leader/team-state.ts";

function createStubCommandContext(): {
  ctx: ExtensionCommandContext;
  setEditorComponent: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
  setWidget: ReturnType<typeof vi.fn>;
} {
  const setEditorComponent = vi.fn();
  const setStatus = vi.fn();
  const setWidget = vi.fn();
  const notify = vi.fn();

  const ui = {
    notify,
    setEditorComponent,
    setStatus,
    setWidget,
    theme: {
      fg: (_color: string, text: string) => text,
    },
  } as unknown as ExtensionUIContext;

  return {
    ctx: {
      ui,
      cwd: "/workspace",
    } as unknown as ExtensionCommandContext,
    setEditorComponent,
    setStatus,
    setWidget,
  };
}

describe("team-state helpers", () => {
  describe("validateTeamModeInput", () => {
    it("allows /team commands", () => {
      expect(validateTeamModeInput("/team help")).toEqual({ kind: "accept" });
    });

    it("rejects free-text input with guidance", () => {
      expect(validateTeamModeInput("hello team")).toEqual({
        kind: "reject",
        message: TEAM_MODE_FREE_TEXT_MESSAGE,
        type: "info",
      });
    });

    it("rejects non-team slash commands", () => {
      expect(validateTeamModeInput("/help")).toEqual({
        kind: "reject",
        message: TEAM_MODE_SLASH_COMMAND_MESSAGE,
        type: "warning",
      });
    });

    it("ignores empty submissions", () => {
      expect(validateTeamModeInput("   ")).toEqual({ kind: "ignore" });
    });
  });

  describe("team-mode text", () => {
    it("lists the supported operator subcommands in help output", () => {
      const text = createTeamModeHelpText();
      for (const { name } of TEAM_MODE_OPERATOR_SUBCOMMANDS) {
        expect(text).toContain(name);
      }
    });

    it("includes shortcut guidance in hotkeys output", () => {
      const text = createTeamModeHotkeysText();
      expect(text).toContain("Enter");
      expect(text).toContain("Shift+Enter");
      expect(text).toContain("Tab");
    });
  });

  describe("argument parsing", () => {
    it("parses create command flags", () => {
      expect(
        parseCreateCommandArgs(
          "--name alpha --config ./team.yaml --worktree-dir ./wt --model anthropic/model --thinking high",
        ),
      ).toEqual({
        name: "alpha",
        configPath: "./team.yaml",
        worktreeDir: "./wt",
        model: "anthropic/model",
        thinkingLevel: "high",
      });
    });

    it("parses quoted create command values", () => {
      expect(
        parseCreateCommandArgs(
          '--name "alpha squad" --config "./team config.yaml"',
        ),
      ).toEqual({
        name: "alpha squad",
        configPath: "./team config.yaml",
      });
    });

    it("requires a team name for create", () => {
      expect(() => parseCreateCommandArgs("--config team.yaml")).toThrow(
        "/team create requires --name <team-name>",
      );
    });

    it("parses restart command args", () => {
      expect(parseRestartCommandArgs("alpha-team")).toEqual({
        teamName: "alpha-team",
      });
    });

    it("rejects missing restart team names", () => {
      expect(() => parseRestartCommandArgs("")).toThrow(
        "/team restart requires <team-name>",
      );
    });

    it("rejects extra restart command arguments", () => {
      expect(() => parseRestartCommandArgs("alpha-team extra")).toThrow(
        "/team restart accepts exactly one <team-name>",
      );
    });

    it("resolves default and explicit create paths", () => {
      expect(resolveCreateCommandPaths("/repo", "alpha", {})).toEqual({
        configPath: undefined,
        worktreeDir: expect.stringContaining("alpha/worktrees"),
      });
      expect(
        resolveCreateCommandPaths("/repo", "alpha", {
          configPath: "./team.yaml",
          worktreeDir: "./custom-wt",
        }),
      ).toEqual({
        configPath: "/repo/team.yaml",
        worktreeDir: "/repo/custom-wt",
      });
    });
  });

  describe("autocomplete", () => {
    it("only offers the /team command at the top level", async () => {
      const provider = createTeamModeAutocompleteProvider("/workspace");
      const controller = new AbortController();

      const suggestions = await provider.getSuggestions(["/"], 0, 1, {
        signal: controller.signal,
      });

      expect(suggestions?.items.map((item) => item.value)).toEqual(["team"]);
    });

    it("offers the restricted team subcommands after /team", async () => {
      const provider = createTeamModeAutocompleteProvider("/workspace");
      const controller = new AbortController();

      const suggestions = await provider.getSuggestions(["/team s"], 0, 7, {
        signal: controller.signal,
      });

      expect(suggestions?.items.map((item) => item.value)).toEqual([
        "send",
        "steer",
        "stop",
      ]);
    });
  });

  describe("TeamModeState", () => {
    it("activates and deactivates team mode through supported UI hooks", async () => {
      const removeRuntimeLock = vi.fn(async () => true);
      const state = new TeamModeState({ removeRuntimeLock });
      const { ctx, setEditorComponent, setStatus, setWidget } =
        createStubCommandContext();

      await state.activate(ctx, {
        snapshot: {
          name: "alpha",
          workspacePath: "/workspace",
          worktreeDir: "/workspace/worktrees",
          model: "anthropic/model",
          thinkingLevel: "medium",
          createdAt: new Date().toISOString(),
          config: { agents: [] },
        },
      });

      expect(state.isActive()).toBe(true);
      expect(setEditorComponent).toHaveBeenCalledTimes(1);
      expect(setWidget).toHaveBeenCalledTimes(1);
      expect(setStatus).toHaveBeenCalledWith("team-mode", "team:alpha");

      await state.deactivate(ctx);

      expect(state.isActive()).toBe(false);
      expect(setEditorComponent).toHaveBeenLastCalledWith(undefined);
      expect(setWidget).toHaveBeenLastCalledWith("team-dashboard", undefined);
      expect(setStatus).toHaveBeenLastCalledWith("team-mode", undefined);
      expect(removeRuntimeLock).toHaveBeenCalledWith("alpha");
    });
  });
});

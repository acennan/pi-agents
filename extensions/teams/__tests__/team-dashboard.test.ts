import type { Theme } from "@mariozechner/pi-coding-agent";
import { type Terminal, TUI } from "@mariozechner/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { TeamDashboardComponent } from "../leader/team-dashboard.ts";

function createTestTui(): TUI {
  const terminal: Terminal = {
    columns: 80,
    rows: 24,
    kittyProtocolActive: false,
    start: () => {},
    drainInput: async () => {},
    stop: () => {},
    write: () => {},
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
  };

  return new TUI(terminal);
}

function createTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
}

describe("TeamDashboardComponent", () => {
  it("renders the active team and empty event state", () => {
    const dashboard = new TeamDashboardComponent(
      createTestTui(),
      createTheme(),
      "alpha",
    );

    expect(dashboard.render(80).join("\n")).toContain("Team: alpha");
    expect(dashboard.render(80).join("\n")).toContain("No events yet");
  });

  it("requests a render when state changes", () => {
    const tui = createTestTui();
    const requestRender = vi.spyOn(tui, "requestRender");
    const dashboard = new TeamDashboardComponent(tui, createTheme(), "alpha");

    dashboard.updateAgent();
    dashboard.updateTask();
    dashboard.setTeamStatus("Paused");
    dashboard.addEvent("entered team mode");

    expect(requestRender).toHaveBeenCalledTimes(4);
    expect(dashboard.render(80).join("\n")).toContain("Paused");
    expect(dashboard.render(80).join("\n")).toContain("entered team mode");
  });
});

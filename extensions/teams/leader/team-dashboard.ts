import type { Theme } from "@mariozechner/pi-coding-agent";
import {
  type Component,
  type TUI,
  truncateToWidth,
} from "@mariozechner/pi-tui";

const MAX_VISIBLE_EVENTS = 3;

/**
 * Minimal team dashboard widget used while team mode is active.
 *
 * TF-06 only needs a lightweight, supported UI surface above the editor so the
 * operator can see that the session is in restricted team mode. Later tasks
 * expand this component into the richer dashboard documented for TF-07+.
 */
export class TeamDashboardComponent implements Component {
  readonly #tui: TUI;
  readonly #theme: Theme;
  readonly #teamName: string;

  #teamStatus: string;
  #events: string[] = [];

  constructor(tui: TUI, theme: Theme, teamName: string, teamStatus = "Active") {
    this.#tui = tui;
    this.#theme = theme;
    this.#teamName = teamName;
    this.#teamStatus = teamStatus;
  }

  updateAgent(): void {
    this.#tui.requestRender();
  }

  updateTask(): void {
    this.#tui.requestRender();
  }

  addEvent(event: string): void {
    this.#events.push(event);
    this.#tui.requestRender();
  }

  setTeamStatus(status: string): void {
    this.#teamStatus = status;
    this.#tui.requestRender();
  }

  render(width: number): string[] {
    const header = truncateToWidth(
      `${this.#theme.fg("accent", this.#theme.bold(`Team: ${this.#teamName}`))} ${this.#theme.fg("muted", `[${this.#teamStatus}]`)}`,
      width,
    );
    const guidance = truncateToWidth(
      this.#theme.fg(
        "dim",
        "Restricted to /team commands while the team is active.",
      ),
      width,
    );

    const events = this.#events.slice(-MAX_VISIBLE_EVENTS);
    const eventLines =
      events.length === 0
        ? [truncateToWidth(this.#theme.fg("muted", "No events yet"), width)]
        : events.map((event) =>
            truncateToWidth(`${this.#theme.fg("muted", "•")} ${event}`, width),
          );

    return [header, guidance, ...eventLines];
  }

  invalidate(): void {
    // This component derives its output directly from current state and theme.
  }
}

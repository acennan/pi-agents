# TUI Changes for Team Dashboard

This document describes the technical implementation of the team dashboard UI, as specified in the `## User Interface` section of `TEAMS_PROPOSAL.md`. It is intended as a reference for implementors.

## TUI Framework Overview

The application uses a custom TUI framework (`@mariozechner/pi-tui`, `packages/tui/`) that renders to the terminal via ANSI escape sequences with synchronized output (`CSI ?2026h/l`). Key properties:

- **Single vertical column** — no horizontal splits, grids, or tabs exist.
- **Differential rendering** — `TUI.doRender()` compares new lines against `previousLines` and only writes changed lines. Updates are coalesced: `TUI.requestRender()` schedules a single render on `process.nextTick`.
- **Component interface**: every component implements `render(width: number): string[]` (returns rendered lines) and optionally `handleInput(data: string): void`. `invalidate()` marks the component dirty.
- **Overlay system** — `TUI.showOverlay(component, options)` composites modal content on top of the base layout. Used for selectors (model, session, settings). Overlays have an `OverlayHandle` with `hide()`, `focus()`, `unfocus()`.

## Current Layout

Created in `InteractiveMode.init()` (`packages/coding-agent/src/modes/interactive/interactive-mode.ts`):

```
ui (TUI root — packages/tui/src/tui.ts)
  ├── headerContainer       logo, keybinding hints
  ├── chatContainer         conversation messages and tool executions  ← replaced in team mode
  ├── pendingMessagesContainer
  ├── statusContainer       status line text
  ├── widgetContainerAbove  extension widgets
  ├── editorContainer       CustomEditor
  ├── widgetContainerBelow  extension widgets
  └── footer                FooterComponent (cwd, tokens, git branch)
```

## Key Existing Components

| Component | File | Notes |
|-----------|------|-------|
| `Container` | `packages/tui/src/tui.ts` | Vertically concatenates children |
| `Text` | `packages/tui/src/components/text.ts` | Static text, optional color fn, padding |
| `Box` | `packages/tui/src/components/box.ts` | Padded container with background |
| `Spacer` | `packages/tui/src/components/spacer.ts` | Empty line |
| `Loader` | `packages/tui/src/components/loader.ts` | Braille spinner, 80ms interval |
| `Markdown` | `packages/tui/src/components/markdown.ts` | Markdown via `marked` + ANSI |
| `SelectList` | `packages/tui/src/components/select-list.ts` | Scrollable filterable list |
| `DynamicBorder` | `packages/coding-agent/src/modes/interactive/components/dynamic-border.ts` | Full-width horizontal divider |
| `AssistantMessageComponent` | `packages/coding-agent/src/modes/interactive/components/assistant-message.ts` | Streaming assistant output |
| `FooterComponent` | `packages/coding-agent/src/modes/interactive/components/footer.ts` | Bottom status bar |
| `CustomEditor` | `packages/coding-agent/src/modes/interactive/components/custom-editor.ts` | Editor with app keybindings |

Theme tokens (success, error, warning, muted, mdHeading, etc.) are accessed via the theme object in `InteractiveMode`.

## New File: `team-dashboard.ts`

**Path**: `packages/coding-agent/src/modes/interactive/components/team-dashboard.ts`

Contains `TeamDashboardComponent` and four internal sub-components. All sub-components implement the `Component` interface.

### `TeamDashboardComponent`

Top-level component added as the sole child of `chatContainer` when team mode is active. Holds references to the four sub-components and the `TUI` instance (for `requestRender()`).

```typescript
class TeamDashboardComponent implements Component {
    private header: TeamHeaderComponent;
    private agentsPanel: TeamAgentsPanelComponent;
    private tasksPanel: TeamTasksPanelComponent;
    private eventLog: TeamEventLogComponent;

    // Called by team event handlers in InteractiveMode
    updateAgent(id: string, status: AgentStatus, currentTask?: string): void;
    updateTask(id: string, status: TaskStatus, assignee?: string): void;
    addEvent(timestamp: Date, description: string): void;
    setTeamStatus(status: "Active" | "Stopping" | "Stopped"): void;

    render(width: number): string[];
    handleInput(data: string): void; // delegates arrow keys to eventLog scroll
    invalidate(): void;
}
```

`render()` concatenates: header lines, a `DynamicBorder`, agents panel lines, a `DynamicBorder`, tasks panel lines, a `DynamicBorder`, event log lines.

### `TeamHeaderComponent`

Renders a single highlighted line:

```
 Team: {name}  [{completed}/{total} tasks]  {status}
```

- `{status}` colored via theme: `success` → Active, `warning` → Stopping, `error` → Stopped.
- Backed by mutable state; `setText()` triggers `invalidate()`.

### `TeamAgentsPanelComponent`

Renders a section header (`AGENTS` in `mdHeading` color) followed by one row per agent:

```
  {name}   {dot} {statusLabel}  {taskRef}
```

- Status dot: `●` in `success` for Working, `○` in `muted` for Idle, `●` in `error` for Crashed.
- Name column is fixed-width (max agent name length + 2, capped at 20 chars).
- If agents overflow available height, the last visible row is replaced with `  ... and N more` in `muted`. A `ctrl+a` keybinding opens a `SelectList` overlay with all agents.

### `TeamTasksPanelComponent`

Renders a section header (`TASKS` in `mdHeading` color) followed by one row per task:

```
  #{id} {icon} {statusLabel}  ({assignee})
```

- Icons: `⏳` for in-progress/in-review, `✓` in `success` for complete, `○` in `muted` for pending, `✗` in `error` for failed.
- Ordering: active first, then pending, then completed. Completed tasks are collapsed to a summary line (`✓ N completed tasks`) when they would overflow.
- Overflow: `  ... and N more` in `muted`; `ctrl+t` opens a full `SelectList` overlay.

### `TeamEventLogComponent`

Renders a section header (`EVENT LOG` in `mdHeading` color, with optional scroll indicator) followed by the most recent N timestamped events:

```
  HH:MM  {description}
```

- Events stored in a ring buffer (capacity 50). Only tail events that fit available height (minimum 3, maximum 50) are rendered.
- `scrollOffset: number` (0 = pinned to bottom). Arrow keys adjust it; scroll indicator `[8–12 of 31]` appears in `muted` when not at bottom.
- Timestamps rendered in `muted` color.

## Modified Files

### `interactive-mode.ts`

**Path**: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

Add the following to `InteractiveMode`:

```typescript
private teamDashboard: TeamDashboardComponent | undefined;
private teamModeActive = false;
```

**Entering team mode** (call from `/team create` / `/team restart` handlers):

```typescript
private enterTeamMode(initialState: TeamState): void {
    this.chatContainer.clear();
    this.pendingMessagesContainer.clear();
    this.teamDashboard = new TeamDashboardComponent(this.ui, this.theme, initialState);
    this.chatContainer.addChild(this.teamDashboard);
    this.teamModeActive = true;
    this.ui.requestRender();
}
```

**Exiting team mode** (call from `/team stop` after confirmation):

```typescript
private exitTeamMode(): void {
    this.chatContainer.clear();
    this.teamDashboard = undefined;
    this.teamModeActive = false;
    this.renderInitialMessages(); // restore chat history
    this.ui.requestRender();
}
```

**Editor input guard** — in `setupEditorSubmitHandler()`, wrap the existing submit logic:

```typescript
if (this.teamModeActive) {
    if (!text.startsWith("/team") && !text.startsWith("/help")) {
        const msg = text.startsWith("/")
            ? "Only /team commands are available during team mode"
            : "Use /team send <agent> <message> to communicate with agents";
        this.lastStatusText?.setText(msg);
        this.ui.requestRender();
        return;
    }
}
// existing submit logic continues...
```

**Key handler additions** — in `setupKeyHandlers()`, guard with `this.teamModeActive`:

```typescript
this.ui.addInputListener((key) => {
    if (!this.teamModeActive || !this.teamDashboard) return false;
    if (key === keybindings.get("app.team.scrollLogUp"))   { this.teamDashboard.scrollLog(-1); return true; }
    if (key === keybindings.get("app.team.scrollLogDown"))  { this.teamDashboard.scrollLog(+1); return true; }
    if (key === keybindings.get("app.team.agentList"))      { this.teamDashboard.openAgentOverlay(); return true; }
    if (key === keybindings.get("app.team.taskList"))       { this.teamDashboard.openTaskOverlay(); return true; }
    return false;
});
```

**Team event subscription** — subscribe to team events and forward to the dashboard:

```typescript
teamProcess.onAgentStatus((id, status, task) => this.teamDashboard?.updateAgent(id, status, task));
teamProcess.onTaskStatus((id, status, assignee) => this.teamDashboard?.updateTask(id, status, assignee));
teamProcess.onEvent((ts, desc) => this.teamDashboard?.addEvent(ts, desc));
```

### `keybindings.ts`

**Path**: `packages/coding-agent/src/core/keybindings.ts`

Add team keybinding definitions alongside existing app bindings:

```typescript
"app.team.scrollLogUp":   { default: "up",     description: "Scroll team event log up" },
"app.team.scrollLogDown": { default: "down",    description: "Scroll team event log down" },
"app.team.agentList":     { default: "ctrl+a",  description: "Open full agent list" },
"app.team.taskList":      { default: "ctrl+t",  description: "Open full task list" },
```

These are only dispatched when `teamModeActive` is true (handled in the input listener guard above), so they do not conflict with existing bindings in normal mode.

## Autocomplete

When `teamModeActive` is true, swap the editor's autocomplete provider to a `TeamCommandAutocompleteProvider` that suggests only `/team` subcommands:

- `send`, `steer`, `broadcast`, `stop`, `restart`, `delete`

This is done by calling `this.editor.setAutocompleteProvider(teamProvider)` on entering team mode and restoring the original provider on exit.

The `getArgumentCompletions` for each subcommand can return the current list of agent names (for `send`, `steer`) or agent types (for `broadcast`), sourced from the `TeamDashboardComponent`'s internal agent state.

## Data Flow Summary

```
TeamProcess (child processes / mailbox polling)
    │
    ▼  onAgentStatus / onTaskStatus / onEvent
InteractiveMode
    │
    ▼  updateAgent / updateTask / addEvent
TeamDashboardComponent
    │  invalidate() + ui.requestRender()
    ▼
TUI.doRender()  →  terminal output
```

## Rendering Budget

The dashboard fills whatever vertical space `chatContainer` occupies. Height is determined at render time from the `width` parameter and terminal rows (`process.stdout.rows`). Sub-components compute their rendered line count and truncate with overflow indicators if they exceed their allocated share. A simple equal-thirds split (agents : tasks : log) is a reasonable starting point; this can be made configurable later.

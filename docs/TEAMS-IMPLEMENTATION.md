# Teams Feature Plan

---

Derived from `docs/TEAMS-PROPOSAL.md` and checked against the currently documented Pi SDK and extension capabilities in:

- `docs/pi-mono/README-agent.md`
- `docs/pi-mono/README-ai.md`
- `docs/pi-mono/README-coding-agent.md`
- `docs/pi-mono/README-tui.md`
- `../pi-mono/packages/coding-agent/docs/extensions.md`
- `../pi-mono/packages/coding-agent/docs/sdk.md`
- `../pi-mono/packages/coding-agent/docs/tui.md`
- `../pi-mono/packages/coding-agent/examples/extensions/subagent/README.md`
- `../pi-mono/packages/coding-agent/examples/extensions/subagent/index.ts`
- `../pi-mono/packages/coding-agent/examples/extensions/plan-mode/README.md`
- `../pi-mono/packages/coding-agent/examples/extensions/plan-mode/index.ts`

## Goal

Turn the proposal into an implementation-ready feature backlog where:

- every feature slice is **3 hours or less**
- dependencies are explicit
- features only depend on **documented SDK / extension APIs** (or public shipped extension API type surfaces where prose docs lag) unless explicitly called out as deferred
- **no SDK changes are required or allowed**
- the result is implementable as a Pi extension plus SDK-powered child runtimes

---

## SDK-grounded decisions

### 0. No SDK changes

This feature must be implemented entirely with the documented Pi SDK, extension API, and TUI API as they already exist.

That means:
- do not add new SDK APIs for teams
- do not patch Pi core internals to make the feature work
- prefer existing SDK capabilities such as `createAgentSession()`, `followUp()`, `steer()`, `reset()`, and `transformContext` over reimplementing agent-loop behavior outside the SDK

### 1. `/team` should be implemented as one extension command

Use `pi.registerCommand("team", ...)` with subcommand parsing and `getArgumentCompletions`.

Why:
- this is directly supported by the extension API
- it avoids patching built-in slash command handling
- it matches how Pi exposes extension commands today

Reference patterns:
- command registration: `../pi-mono/packages/coding-agent/examples/extensions/plan-mode/index.ts`
- command autocomplete support: `../pi-mono/packages/coding-agent/docs/extensions.md`

### 2. Team-mode UI must use supported extension composition

The current extension API documents or publicly exposes through its `ExtensionUI` type surface:
- `ctx.ui.setStatus()`
- `ctx.ui.setWidget()`
- `ctx.ui.setFooter()`
- `ctx.ui.setHeader()`
- `ctx.ui.custom(..., { overlay: true })`
- `ctx.ui.setEditorComponent()`
- `ctx.ui.onTerminalInput()` (public on `ExtensionUI` in `../pi-mono/packages/coding-agent/src/core/extensions/types.ts`)

It does **not** document a stable API for permanently replacing the main chat/message pane.

**Therefore the MVP dashboard should be implemented as:**
- a persistent widget above the editor
- status/footer/header updates
- overlays for full agent/task/event views
- a custom team editor that enforces input restrictions

**Not in MVP:** direct replacement of the core chat container through private `InteractiveMode` internals.

This is the biggest change from `TEAMS_PROPOSAL.md`, and it is intentional so the plan stays aligned with supported SDK functionality.

### 3. Long-lived member agents should use the SDK directly, without changing it

The proposal requires capabilities such as:
- `agent.reset()`
- `agent.state.messages = []`
- `transformContext` pruning
- steering and follow-up queue semantics

Those are SDK / `@mariozechner/pi-agent-core` features, not extension-only features.

So the recommended runtime split is:
- **leader:** Pi extension running in the user session
- **member agents:** child Node processes using `createAgentSession()` / `Agent` directly

This still matches the proposal's requirement that agents are separate processes managed by the leader via `child_process`, while keeping the implementation inside the supported SDK surface and avoiding SDK changes.

### 4. Steering semantics must follow the SDK exactly

Per the SDK:
- steering interrupts **between turns**
- current tool calls finish first
- steering is injected on the next turn

So `/team steer` must not promise immediate mid-tool interruption.

### 5. Team-mode help and exit handling should stay under `/team`

While team mode is active, all operator commands should remain under the `/team` namespace so the restricted editor only has to allow one command family.

So the extension should support:
- `/team help`
- `/team hotkeys`
- `/team exit`

This intentionally avoids depending on built-in `/help`, `/hotkeys`, or `/exit` behaviour while team mode is active.

### 6. File locking is first-class, not polish

The proposal requires mailbox and cursor safety across processes. This should be implemented early using `proper-lockfile`, with one shared helper used by:
- mailbox append/read
- cursor updates
- event log append
- team lease / runtime lock updates
- any other shared JSONL/YAML writes

For mailbox reads, reading new entries and advancing the cursor should happen under one lock scope. If the lock cannot be obtained, retry after 5 seconds; the maximum number of retry cycles is controlled by `PI_MAILBOX_LOCK_ATTEMPTS` and defaults to `5`.

### 7. Beads integration must use supported CLI features plus team-owned lineage state

The added beads CLI reference changes the implementation approach in one important way: the team system should only rely on supported `br` concepts.

Use this contract:
- **task claiming / lifecycle:** `open`, `in_progress`, `deferred`, `closed`
- **dependency-blocked work:** query via `br ready` / `br blocked`
- **remedial-task parentage:** `--parent <id>` / `parent-child`
- **team `caused-by` link:** `dep add <new> <original> --type discovered-from`
- **integration-ready persistence:** label `team:test-passed`
- **max review cycle reached:** set status `deferred`, add label `team:blocked-max-review-cycles`, add explanatory comment
- **lineage metadata** (worktree path, branch name, lineage root ID, review cycle count): store in team-owned state under `~/.pi/teams/<team-name>/state/`, not in beads

This keeps the implementation aligned with the documented `br` CLI instead of assuming custom metadata APIs.

### 8. The leader owns durable workflow state transitions

To keep concurrency manageable, the leader should be the single authority for durable workflow state.

Leader-owned durable state includes:
- beads status changes
- beads labels and comments used by the workflow
- remedial-task creation and dependency/link creation
- team-owned lineage state
- integration queue state
- active-team lease state
- dashboard/task model state derived from the authoritative workflow model

The active-team lease / runtime lock is separate from beads task state. A clean `/team stop` removes it, `/team pause` preserves it, and validated restart/delete flows may clear stale lease records.

Agent responsibilities should therefore be split as follows:
- code agents may atomically claim tasks and make code commits in their task worktrees
- simplify agents may make simplification commits in the task worktree
- review and test agents emit findings only
- commit agents run git integration steps and emit success/failure only
- the leader applies the resulting durable state transitions after receiving those agent results

This rule should be reflected consistently throughout implementation and tests.

### 9. Tool lists are the enforcement mechanism for read-only agent roles

The Pi coding agent exposes seven named tools: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. These names are passed directly to `AgentConfig.tools` when each child runtime is created. Omitting the `tools` field causes the child to inherit full access from the leader session.

Tool lists must be set explicitly for each agent and sub-agent in the team configuration:

| Role | Tools |
|---|---|
| Code agent | `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` |
| Simplify agent | `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` |
| Review agent | `read`, `grep`, `find`, `ls` |
| Test agent | `read`, `bash`, `grep`, `find`, `ls` |
| Commit agent | `read`, `bash` |

The review agent has no write tools and no `bash` access — it cannot modify files at the runtime level, not only by prompt instruction. The commit agent has `bash` for git commands and `read` for inspecting the repo state, but no write/edit access to source files.

The config loader (TF-03) must reject any agent or sub-agent entry that does not specify an explicit `tools` list, or must warn clearly that the default inherits full leader access. The default team YAML must always carry explicit tool lists for all agent and sub-agent entries.

---

## Recommended repository layout

```text
extensions/
  teams/
    index.ts
    command-router.ts
    roles.ts
    config/
      schema.ts
      loader.ts
      defaults.ts
      default-team.yaml
      prompt-templates/
        code-prompt.md
        simplify-prompt.md
        review-prompt.md
        test-prompt.md
        commit-prompt.md
    storage/
      team-home.ts
      locks.ts
      jsonl.ts
      event-log.ts
      team-lease.ts
    leader/
      team-manager.ts
      team-state.ts
      team-dashboard.ts
      team-overlays.ts
      process-manager.ts
      integration-queue.ts
      create-team.ts
      restart-team.ts
      stop-team.ts
      delete-team.ts
    agents/
      runtime-entry.ts
      mailbox.ts
      context-pruning.ts
      code-agent.ts
      simplify-agent.ts
      review-agent.ts
      test-agent.ts
      commit-agent.ts
    tasks/
      beads.ts
      lineage.ts
      lineage-state.ts
      summaries.ts
    git/
      worktree.ts
      integrate.ts
    __tests__/
      fixtures/
      team-create.test.ts
      mailbox.test.ts
      code-agent.test.ts
      pipeline.test.ts
      restart.test.ts
      stop-delete.test.ts
```

This structure keeps:
- extension-facing code under `leader/`
- SDK child runtime code under `agents/`
- workspace state and persistence helpers under `storage/`
- git/beads concerns isolated from UI code

---

## Phase plan

### Phase 1 — Foundation and team creation

| ID | Feature | Primary files | Timebox | Depends on | Notes |
|---|---|---|---:|---|---|
| TF-01 | Extension skeleton, `/team` router, process-role guard | `extensions/teams/index.ts`, `extensions/teams/command-router.ts`, `extensions/teams/roles.ts` | 2.5h | None | Registers `/team`; rejects all team commands when running in a member-agent process instead of the leader. |
| TF-02 | Team home directory creation and persisted team snapshot | `extensions/teams/storage/team-home.ts`, `extensions/teams/leader/create-team.ts` | 2.5h | TF-01 | Creates `~/.pi/teams/<team-name>` structure, fails if that team name already exists, and stores an authoritative `team-config.yaml` containing the team instance name, resolved absolute workspace path, resolved absolute worktree dir, resolved leader default model/thinking values, original config source path when provided, and the full config snapshot used at team creation time. On team creation, copies bundled prompt templates from the extension source into `~/.pi/teams/prompt-templates/` (shared across all teams); the `archives/` directory is created lazily on first `--archive` use rather than at team creation time. |
| TF-03 | YAML config parsing, inheritance rules, prompt-template validation | `extensions/teams/config/schema.ts`, `extensions/teams/config/loader.ts`, `extensions/teams/config/default-team.yaml` | 3h | TF-01 | Validates `agents`, `sub-agents`, `count`, `maxAllowed`, type enums, top-level inheritance, prompt template existence. Uniqueness is enforced on the *constructed instance names* produced by `nameTemplate` expansion (e.g. `code-1`, `code-2`), not on the `nameTemplate` field itself — multiple entries may share the same `nameTemplate` value when their configurations differ, each contributing its own `count` of agents. Tool names must be validated against the known set: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. Any agent or sub-agent entry that omits the `tools` field must produce a warning that full leader access will be inherited; the default team YAML always supplies explicit tool lists for every entry. |
| TF-04 | Preflight validation for `/team create` and `/team restart` | `extensions/teams/leader/create-team.ts`, `extensions/teams/leader/restart-team.ts`, `extensions/teams/tasks/beads.ts`, `extensions/teams/git/worktree.ts` | 3h | TF-02, TF-03 | Verifies git repo, `main`, writable worktree dir, beads availability, valid model, valid thinking level, prompt-template references, and that the requested team name is not already in use before spawning anything. |
| TF-05 | Shared locking, JSONL, and event-log helpers | `extensions/teams/storage/locks.ts`, `extensions/teams/storage/jsonl.ts`, `extensions/teams/storage/event-log.ts` | 2.5h | TF-02 | Introduces `proper-lockfile` helpers and append-only event logging used by later features. Mailbox readers must read pending entries and advance the cursor under one lock scope, retrying after 5 seconds when contested; `PI_MAILBOX_LOCK_ATTEMPTS` controls the maximum retry cycles and defaults to `5`. |
| TF-05A | Active-team lease and stale-lock recovery rules | `extensions/teams/storage/team-lease.ts`, `extensions/teams/leader/create-team.ts`, `extensions/teams/leader/restart-team.ts`, `extensions/teams/leader/delete-team.ts` | 2h | TF-05 | Persists a runtime lock record for leader/session ownership (separate from beads task state), prevents multiple leaders from controlling one team, preserves the lock during `/team pause`, removes it on clean `/team stop`, and defines explicit stale-lock cleanup on validated restart/delete. The `runtime-lock.json` file must record at minimum: `sessionId` (string), `pid` (number), and `createdAt` (ISO 8601 timestamp). |
| TF-06 | Team-mode custom editor, restricted autocomplete, and `/team`-only operator commands | `extensions/teams/leader/team-dashboard.ts`, `extensions/teams/leader/team-state.ts` | 3h | TF-01 | Replaces the editor in team mode, allows only `/team ...` subcommands, and keeps editor focus by default when team mode starts. Implements `/team help` output listing all supported subcommands with short descriptions, `/team hotkeys` for team-mode shortcut help, and `/team exit` which instructs the user to stop the team first. Provides team-specific command completion for the following `/team` subcommands: `send`, `steer`, `broadcast`, `stop`, `pause`, `resume`, `restart`, `delete`, `help`, `hotkeys`, `exit`. Free-text input shows `Use /team send <agent> <message> to communicate with agents`; non-`/team` slash commands show `Only /team commands are available during team mode`. |

#### Phase 1 acceptance

By the end of Phase 1 you can:
- run `/team create --name ...`
- validate config, model, and thinking values before startup
- persist a restartable config snapshot
- prevent a second leader from attaching to the same team accidentally
- enter a restricted team mode without spawning agents yet

---

### Phase 2 — Supported leader UI

| ID | Feature | Primary files | Timebox | Depends on | Notes |
|---|---|---|---:|---|---|
| TF-07 | Dashboard summary widget and footer/status wiring | `extensions/teams/leader/team-dashboard.ts`, `extensions/teams/leader/team-state.ts` | 3h | TF-06 | Uses `setWidget`, `setStatus`, and `setFooter` to show team name, status, agent summaries, task summaries, and last events. The `TeamDashboardComponent` must expose `updateAgent()`, `updateTask()`, `addEvent()`, and `setTeamStatus()` methods, each calling `tui.requestRender()` after updating internal state. Empty states render `No agents yet` / `No tasks yet` in muted text. Standing code agents use `●` (green = Working, dim = Idle, red = Crashed); sub-agents use `◆` (cyan) while active and are hidden when they exit. Task rows use the following status icons: `⏳` pending, `⚙️` coding, `✂️` simplifying, `🔍` in review, `✍️` testing, `🔗` integrating, `✅` complete, `⛔️` blocked. Fine-grained row-layout polish such as fixed-width name padding and icon refinement is non-blocking and can follow the first working dashboard pass later in Phase 2. |
| TF-08 | Event-log ring buffer and keyboard navigation | `extensions/teams/leader/team-dashboard.ts` | 2h | TF-07 | Ring buffer capacity is 50 entries. Uses `ctx.ui.onTerminalInput()` (public on the extension UI type surface) for keyboard handling when the dashboard has focus. The editor remains focused by default when team mode starts; `tab` toggles focus between editor and dashboard. `up`/`down` scroll the event log only while the dashboard has focus. Scroll position indicator shows `[8–12 of 31]` format when scrolled away from bottom. Terminal resize re-renders at new width with no cached widths. |
| TF-09 | Agent/task full-list overlays | `extensions/teams/leader/team-overlays.ts`, `extensions/teams/leader/team-dashboard.ts` | 2h | TF-07 | Uses `ctx.ui.custom(..., { overlay: true })` and `SelectList`-style overlays for full agent and task lists. Key bindings: `ctrl+a` opens the full agent-list overlay; `ctrl+t` opens the full task-list overlay. |
| TF-07A | Completed task collapsing in the tasks panel | `extensions/teams/leader/team-dashboard.ts` | 1h | TF-07 | Active tasks appear first; completed tasks are collapsed into a summary line (`✓ N completed tasks`) when they would overflow the available vertical space. |
| TF-10 | Idle/no-work and attention-needed states | `extensions/teams/leader/team-state.ts`, `extensions/teams/leader/team-dashboard.ts` | 2h | TF-07 | Renders explicit states for: `Active`, `Paused`, `Stopping`, `All done` (all tasks complete, waiting for user), `Blocked` (one or more tasks are `deferred` with `team:blocked-max-review-cycles`), and `Action needed` (integration failure or other user intervention required). When the team transitions to `All done`, an explicit event-log entry must be appended and the dashboard header updated — the state change must be visible without the user inspecting the task list. |

#### Phase 2 acceptance

By the end of Phase 2 the leader session has a usable, SDK-supported operator UI, without depending on private interactive-mode internals.

---

### Phase 3 — Child runtime and transport

| ID | Feature | Primary files | Timebox | Depends on | Notes |
|---|---|---|---:|---|---|
| TF-11 | SDK child-runtime bootstrap and spawn helper | `extensions/teams/agents/runtime-entry.ts`, `extensions/teams/leader/process-manager.ts` | 3h | TF-04 | Defines how the leader launches compiled/runnable JS child runtimes, passes role/team/task/env args, and captures exits/errors without requiring `tsx` or another dev-time runner on user machines. |
| TF-12 | Mailbox inbox/cursor files with lock-safe append/read | `extensions/teams/agents/mailbox.ts`, `extensions/teams/storage/locks.ts` | 3h | TF-05, TF-11 | Implements append-only inbox JSONL, cursor JSON, lock discipline, and mailbox cleanup rules for short-lived subagents. Each JSONL entry must conform to `{ timestamp, sender, receiver, subject, message }`; the `subject` field acts as message type (e.g. `task-25-coding-complete`). Standing code agents and active sub-agents use the same mailbox helper and poll their mailbox every `PI_TEAM_MAILBOX_POLL_SECS` seconds (default: 5). Inbox reads and cursor advancement happen under one lock scope with the retry rules from TF-05. Sub-agent inbox and cursor files are removed on clean exit; on crash they are deleted by the leader during crash recovery or restart before replacement sub-agents are spawned so no stale mailbox state is reused. **The leader also has its own inbox (`leader-inbox.jsonl`) and cursor (`leader-cursor.json`).** Agents report results back to the leader by appending to the leader's inbox using the same JSONL format and lock discipline. The leader polls its inbox on the same interval as standing agents. This makes all inter-process communication auditable through a single mechanism regardless of direction. |
| TF-13 | Standing code-agent spawn and lifecycle tracking | `extensions/teams/leader/process-manager.ts`, `extensions/teams/leader/team-manager.ts` | 3h | TF-11 | Spawns code agents at team startup, tracks PID/process handles, records crashes, and enforces one active team per leader session. |
| TF-14 | `/team send`, `/team steer`, `/team broadcast` routing | `extensions/teams/command-router.ts`, `extensions/teams/leader/team-manager.ts`, `extensions/teams/agents/mailbox.ts` | 2.5h | TF-12, TF-13 | Delivers queued messages to idle code agents and in-flight steer messages to active agents/subagents; rejects invalid broadcast types. Each agent runtime sets `agent.followUpMode = "one-at-a-time"` during startup. Mailbox `send` / queued-work messages map to `agent.followUp(message)` and steering messages map to `agent.steer(message)`. Broadcast remains allowed while paused and queues normally for code agents; while stopping, inbound send/steer/broadcast messages are ignored. This keeps mailbox transport and SDK queue semantics consistent across code agents and sub-agents. |
| TF-15 | Pause/resume state changes and broadcasts | `extensions/teams/leader/team-manager.ts`, `extensions/teams/command-router.ts` | 2h | TF-13, TF-14 | Broadcasts `team-paused` / `team-resumed`, updates dashboard state, and prevents new task claiming while paused. Message queues continue to operate while paused; pausing only stops further task claims. If `/team resume` is called when the team is not paused, the command informs the user and does nothing. |

#### Phase 3 acceptance

By the end of Phase 3 the leader can create a team, spawn standing workers, and communicate with them using documented SDK queue semantics.

---

### Phase 4 — Code-agent loop and task pipeline

| ID | Feature | Primary files | Timebox | Depends on | Notes |
|---|---|---|---:|---|---|
| TF-16 | Beads task selection and atomic `open` claim adapter | `extensions/teams/tasks/beads.ts`, `extensions/teams/agents/code-agent.ts` | 3h | TF-13 | Wraps the existing `br` beads CLI for reads/claims, ignores non-open and dependency-blocked work, and normalizes task metadata access. The adapter must implement the code-agent claim flow concretely: choose from ready/open candidate tasks, attempt the status transition to `in_progress` for one chosen task, and treat a failed transition as a lost race that causes the code agent to retry with another candidate. This task-claim step is the only beads write that code agents perform directly. |
| TF-16A | Beads lineage contract and team-owned lineage state | `extensions/teams/tasks/beads.ts`, `extensions/teams/tasks/lineage-state.ts`, `extensions/teams/tasks/lineage.ts` | 2.5h | TF-16 | Maps remedial tasks onto `parent-child` + `discovered-from`, persists lineage branch/worktree/root-task/review-cycle data under team state, and uses labels instead of custom beads metadata. |
| TF-17 | Lineage worktree/branch creation and remedial reuse | `extensions/teams/tasks/lineage.ts`, `extensions/teams/git/worktree.ts`, `extensions/teams/agents/code-agent.ts` | 3h | TF-16A | Creates new `task-<id>` worktrees on `main`, persists lineage metadata, and reuses existing lineage worktree/branch for remedial tasks. |
| TF-18 | Code-agent completion contract | `extensions/teams/agents/code-agent.ts`, `extensions/teams/tasks/summaries.ts`, `extensions/teams/agents/context-pruning.ts` | 3h | TF-17 | On completion: append/update summary file, commit changes, report touched files to leader, call `agent.reset()`, and if `reset()` does not clear message history also set `agent.state.messages = []` before the next task. Configure a `transformContext` hook to prune old messages between tasks to limit token usage. |
| TF-19 | Simplify subagent runner | `extensions/teams/agents/simplify-agent.ts`, `extensions/teams/leader/team-manager.ts`, `extensions/teams/tasks/summaries.ts` | 2.5h | TF-18 | Runs `code-simplifier` on the touched-file list, commits if needed, appends summary notes, and reports updated file list to leader. |
| TF-20 | Review subagent runner with remedial-task creation and cycle limit | `extensions/teams/agents/review-agent.ts`, `extensions/teams/leader/team-manager.ts`, `extensions/teams/tasks/beads.ts`, `extensions/teams/tasks/summaries.ts`, `extensions/teams/tasks/lineage-state.ts` | 3h | TF-19 | Appends structured review findings, emits them to the leader, and has the leader close the original task, create the remedial task using `parent-child` + `discovered-from`, increment lineage `review_cycle_count` in team state, and defer/label work when the cycle limit is exceeded. |
| TF-21 | Test subagent runner with remedial-task creation and cycle limit | `extensions/teams/agents/test-agent.ts`, `extensions/teams/leader/team-manager.ts`, `extensions/teams/tasks/beads.ts`, `extensions/teams/tasks/summaries.ts`, `extensions/teams/tasks/lineage-state.ts` | 3h | TF-20 | Runs scoped tests, appends structured test findings, emits them to the leader, and has the leader create remedial work on failure using supported beads relationships while incrementing the same lineage-level cycle counter in team state. |
| TF-22 | Commit subagent, sequential integration queue, and `team:test-passed` persistence | `extensions/teams/agents/commit-agent.ts`, `extensions/teams/git/integrate.ts`, `extensions/teams/leader/integration-queue.ts`, `extensions/teams/leader/team-manager.ts` | 3h | TF-21 | Rebase-on-main, `git merge --ff-only`, successful cleanup, queue serialization, `team:test-passed` label persistence, and leader-owned close/cleanup handling without auto-resolution. The commit agent has no beads interaction; all beads state changes (close, label removal) are applied by the leader after receiving the agent's success/failure report. The commit-prompt.md template receives 4 parameters: task identifier (`$1`), resolved branch name (`$2`), resolved worktree path (`$3`), and main repo working directory (`$4`). Integration failures (rebase conflict or ff-merge failure) are **not** counted as review cycles and must not increment `review_cycle_count`; they are a distinct failure mode reported directly to the user for manual resolution. |

#### Phase 4 acceptance

By the end of Phase 4 one full lineage can flow:

`code -> simplify -> review -> test -> commit`

including remedial-task creation through supported beads relationships and lineage-state reuse without requiring custom beads metadata.

---

### Phase 5 — Lifecycle commands and recovery

| ID | Feature | Primary files | Timebox | Depends on | Notes |
|---|---|---|---:|---|---|
| TF-23 | `/team stop` semantics for code/simplify/review/test/commit agents | `extensions/teams/leader/stop-team.ts`, `extensions/teams/leader/process-manager.ts`, `extensions/teams/git/worktree.ts`, `extensions/teams/tasks/beads.ts` | 3h | TF-22 | Implements role-specific stop behavior. **Code agent stop**: roll back any in-progress changes, reset task to `open`. **Simplify stop**: hard-reset task worktree to the code agent's last commit, reset task to `open`. **Review stop**: discard partial review state, reset task to `open`. **Test stop**: discard partial test state, reset task to `open`. **Commit stop**: allow to complete or abort cleanly; if not possible, run `git rebase --abort` in the task worktree and `git merge --abort` in the main repo if active, leave task `in_progress` for user resolution. Note: stop resets review and test tasks to `open` (unlike crash recovery, which leaves them `in_progress`). After all agents have stopped, remove the inbox and cursor files for any sub-agents that were active at stop time. |
| TF-24 | `/team restart` from persisted snapshot with workspace realpath validation | `extensions/teams/leader/restart-team.ts`, `extensions/teams/leader/team-manager.ts`, `extensions/teams/storage/team-home.ts`, `extensions/teams/storage/team-lease.ts`, `extensions/teams/tasks/beads.ts` | 3h | TF-22, TF-05A | Restarts from the authoritative stored `team-config.yaml`, rejects cross-workspace attach, reports stale `in_progress` tasks, clears stale team leases safely, deletes stale sub-agent inbox/cursor files, and requeues `team:test-passed` work. |
| TF-25 | `/team delete` and optional archive mode | `extensions/teams/leader/delete-team.ts`, `extensions/teams/storage/team-home.ts`, `extensions/teams/git/worktree.ts` | 2.5h | TF-24 | Refuses deletion of the currently active team (user must stop it first); deleting a different inactive team while another is active is explicitly permitted. Archives config/mailboxes/logs/summaries to zip under `~/.pi/teams/archives/` when `--archive` is supplied; the archives directory is created lazily if it does not exist. Removes the runtime lock before file deletion and removes worktrees cleanly using git commands. If deletion fails partway through (e.g. a worktree removal error or zip write failure), the user must be informed with the reason and a list of any files or directories that remain for manual cleanup. |
| TF-26 | Code-agent per-task timeout and crash recovery | `extensions/teams/leader/team-manager.ts`, `extensions/teams/leader/process-manager.ts`, `extensions/teams/git/worktree.ts`, `extensions/teams/tasks/beads.ts` | 2.5h | TF-18 | Applies `PI_TEAM_TASK_TIMEOUT_MINS` (default: 60) to code agents only: kills the stuck process, hard-resets the task lineage branch and worktree, marks the task `open`, spawns a replacement agent, logs the timeout event. |
| TF-26A | Sub-agent crash recovery (simplify, review, test, commit) | `extensions/teams/leader/team-manager.ts`, `extensions/teams/leader/process-manager.ts`, `extensions/teams/git/worktree.ts` | 2h | TF-26 | Implements the distinct crash recovery path for each short-lived sub-agent type. **Simplify crash**: hard-reset task worktree to the code agent's last commit, then spawn the review agent using the code agent's original file list. **Review crash**: discard partial review state, leave task `in_progress`, spawn a fresh review agent for the same task. **Test crash**: discard partial test state, leave task `in_progress`, spawn a fresh test agent for the same task. **Commit crash**: leave task `in_progress`, run `git rebase --abort` in the task worktree if a rebase is active, clean up any partial merge state in the main repo, retain the integration queue entry, notify the user. |
| TF-27 | SIGINT/SIGTERM best-effort shutdown | `extensions/teams/index.ts`, `extensions/teams/leader/team-manager.ts`, `extensions/teams/leader/process-manager.ts` | 2h | TF-23 | On leader exit, sends abort signals to all standing agents, waits up to 5 seconds for graceful exit, then kills remaining processes. Leaves unresolved `in_progress` work for later restart reconciliation. **This is intentionally a subset of `/team stop`**: worktree reset and task rollback are explicitly skipped in the signal handler. Full cleanup is deferred to the next `/team restart`, which will report stale `in_progress` tasks to the user. |
| TF-28 | End-to-end tests, fixtures, and operator docs | `extensions/teams/__tests__/...`, `docs/TEAMS-FEATURES.md`, `docs/TEAMS_PROPOSAL.md` | 3h | TF-22, TF-24, TF-25, TF-26 | Adds deterministic test harness and user-facing documentation for create, pause/resume, restart, stop, delete, and failure handling. |

#### Phase 5 acceptance

By the end of Phase 5 the system is safe to stop, restart, and clean up, and it has a testable recovery story covering crash paths for all five agent types.

---

## Concrete sub-slices for the largest backlog items

The following table breaks down the largest backlog rows into concrete implementation slices so the work can still be executed in chunks of 3 hours or less.

| Umbrella | Sub-slice | Scope |
|---|---|---|
| TF-20 | TF-20a | Review runner, structured findings format, summary append |
| TF-20 | TF-20b | Remedial task creation using `--parent` + `discovered-from` |
| TF-20 | TF-20c | `review_cycle_count` increment and overflow handling (`deferred` + label + comment); limit controlled by `PI_TEAM_MAX_REVIEW_CYCLES` (default: 3) |
| TF-21 | TF-21a | Test runner, scoped execution, structured findings format |
| TF-21 | TF-21b | Test-failure remedial task creation and cycle-count increment |
| TF-22 | TF-22a | Commit runner (rebase, ff-merge, cleanup, failure reporting) |
| TF-22 | TF-22b | Sequential integration queue and `team:test-passed` label persistence |
| TF-23 | TF-23a | Stop behavior for code/simplify/review/test agents |
| TF-23 | TF-23b | Stop behavior for commit-stage edge cases |
| TF-24 | TF-24a | Restart from snapshot + workspace realpath validation |
| TF-24 | TF-24b | Stale lease recovery, stale `in_progress` reporting, `team:test-passed` queue rebuild |
| TF-26A | TF-26Aa | Simplify crash: hard-reset worktree, forward to review with code agent's original file list |
| TF-26A | TF-26Ab | Review/test crash: discard partial state, re-spawn same sub-agent type |
| TF-26A | TF-26Ac | Commit crash: cleanup rebase/merge state, retain queue entry, notify user |
| TF-28 | TF-28a | Deterministic test harness and fixtures |
| TF-28 | TF-28b | Operator docs, proposal/plan reconciliation, usage guidance |

---

## Dependency summary

### Critical path

`TF-01 -> TF-02 -> TF-03 -> TF-04 -> TF-05 -> TF-05A -> TF-06 -> TF-11 -> TF-13 -> TF-16 -> TF-16A -> TF-17 -> TF-18 -> TF-19 -> TF-20 -> TF-21 -> TF-22 -> TF-23 -> TF-24 -> TF-28`

Note: TF-06 (team-mode editor) is on the critical path because no user-facing team workflow is testable without it. TF-07 through TF-10 (dashboard polish) are parallelizable once TF-06 is done and the state model from Phase 4 stabilises.

### Parallelizable groups

These can be worked in parallel once their dependencies are met:

- **UI parallel group:** `TF-07`, `TF-08`, `TF-09`, `TF-10`
- **Transport parallel group:** `TF-12`, `TF-14`, `TF-15` after `TF-11`/`TF-13`
- **Recovery parallel group:** `TF-25`, `TF-26`, `TF-26A`, `TF-27` after `TF-23`/`TF-24`

---

## Feature notes by proposal area

### Commands

| Proposal command | Covered by |
|---|---|
| `/team create` | TF-01 to TF-04 |
| `/team stop` | TF-23 |
| `/team pause` / `/team resume` | TF-15 |
| `/team restart` | TF-24 |
| `/team delete [--archive]` | TF-25 |
| `/team send` / `/team steer` / `/team broadcast` | TF-14 |

### Team config and defaults

Covered by:
- TF-02: persisted snapshot
- TF-03: schema/inheritance/defaults
- TF-28: docs and operator guidance

### Agent spawning and lifecycle

Covered by:
- TF-11: child runtime bootstrap
- TF-13: standing worker lifecycle
- TF-19 to TF-22: subagent pipeline
- TF-23 / TF-26 / TF-26A / TF-27: stop, timeout, crash (code and sub-agent), shutdown recovery

### Beads integration

Covered by:
- TF-16: task claiming
- TF-16A / TF-17: lineage-state contract and reuse
- TF-20 / TF-21: remedial tasks and cycle counting
- TF-22 / TF-24: `team:test-passed` persistence and restart queue rebuild

### UI

Covered by:
- TF-06: restricted editor
- TF-07 to TF-10: supported dashboard, overlays, scroll, idle states

---

## Explicit non-MVP items

These should **not** be part of the first implementation pass unless the project is willing to modify Pi core internals beyond documented extension APIs.

1. **Permanent replacement of the chat/message pane**
   - Reason: not exposed as a documented extension API.

2. **Any solution that depends on private `InteractiveMode` container structure**
   - Reason: brittle and outside the documented extension surface.

3. **Attachment to an already-running team from a different leader session**
   - Reason: proposal forbids it and it adds state-reconciliation complexity early.

4. **Proposal Phase 2 items**
   - pre-flight conflict detection
   - `/team retry <task-id>`
   - priority-aware scheduling
   - richer drill-down UI beyond overlays

---

## Testing strategy

### Unit tests

Use isolated tests for:
- config validation
- mailbox locking and cursor movement
- lineage metadata reads/writes
- event-log append behavior
- queue ordering
- leader-owned state transition helpers

### Deterministic SDK tests

Use the Pi AI faux provider (`registerFauxProvider()`) for child-runtime tests so agent loops can be replayed deterministically.

Good fits:
- code-agent happy path
- simplify no-op vs simplify-change
- review fail / review pass
- test fail / test pass
- commit success / rebase failure / ff-merge failure

### Workspace fixture tests

Use temporary directories with:
- a real git repo and `main`
- a temporary beads DB
- temporary `~/.pi/teams/...` state

These should cover:
- create / restart / delete
- task timeout rollback
- mailbox recovery after crash
- stale team-lease recovery
- `team:test-passed` queue rebuild on restart

### Operator-path tests

Use higher-level tests for:
- team-mode command restriction
- `/team send` / `/team steer` routing
- pause/resume behavior
- stop behavior across each agent type
- review/test result handling where only the leader mutates durable workflow state

---

## Resolved implementation decisions

These decisions are now fixed for implementation:

1. **Packaging of child runtimes**
   - Ship runnable JS for child processes.
   - Do not require `tsx` or another dev-time TypeScript runner on user machines.

2. **Beads integration boundary**
   - Wrap the existing beads CLI, `br`, behind `extensions/teams/tasks/beads.ts`.
   - Use only supported `br` concepts: statuses, dependencies, labels, comments, and parent-child relationships.
   - Keep lineage metadata in `extensions/teams/tasks/lineage-state.ts`, not in assumed custom beads metadata fields.
   - Keep the rest of the team system isolated from raw CLI invocation details.

3. **Durable state authority**
   - The leader is the sole writer of durable workflow state outside the narrow exceptions already defined for task claiming and git commits inside worktrees.
   - Review/test/commit subagents report results; the leader applies the resulting beads, lineage-state, queue, lease, queue-entry, and transient-label updates.

4. **Prompt-template source of truth**
   - Treat the existing prompt files in `docs/` as the authoring source.
   - On team creation, copy bundled templates from the extension source into `~/.pi/teams/prompt-templates/` (shared location, not per-team) so runtime behaviour is decoupled from future source changes.
   - Prompt parameter conventions: code-prompt receives worktrees dir (`$1`) and summaries dir (`$2`); simplify/review/test prompts receive task ID (`$1`), worktree path (`$2`), changed file list (`$3`), summaries dir (`$4`); commit-prompt receives task ID (`$1`), resolved branch name (`$2`), resolved worktree path (`$3`), and main repo working directory (`$4`).

5. **Team-mode operator command surface**
   - While team mode is active, only `/team ...` commands are accepted by the custom editor.
   - Team help and utility affordances are exposed as `/team help`, `/team hotkeys`, and `/team exit`.
   - Editor focus is the default on entry to team mode; `tab` moves focus between editor and dashboard.

6. **Runtime lock semantics**
   - The active-team runtime lock is separate from beads task state.
   - `/team pause` preserves the runtime lock; clean `/team stop` removes it.
   - Validated `/team restart` may clear a stale runtime lock before resuming the team.
   - `/team delete` removes the runtime lock before deleting team files.

---

## Recommended implementation order

If work starts immediately, the best order is:

1. TF-01 to TF-06, including TF-05A
2. TF-11 to TF-15
3. TF-16 to TF-18, including TF-16A
4. TF-19 to TF-22
5. TF-23 to TF-28
6. Fill out UI polish in TF-07 to TF-10 in parallel once the state model stabilizes

This keeps the critical path focused on:
- reliable team creation
- reliable child runtime control
- reliable pipeline transitions
- reliable recovery

before spending time on UI polish.

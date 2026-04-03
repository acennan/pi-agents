# Teams Backlog

Implementation backlog derived from:

- `docs/TEAMS-PROPOSAL.md`
- `docs/TEAMS-IMPLEMENTATION.md`
- `docs/BEADS-CLI-REFERENCE.md`

This backlog is organized as small, dependency-aware work items intended for implementation without any SDK changes.

## Rules

- No SDK changes
- Use only documented Pi SDK / extension / TUI APIs (or public shipped extension API type surfaces where prose docs lag)
- Use only supported `br` CLI features
- Leader owns durable workflow state transitions
- Child agents use existing SDK functionality rather than reimplementing agent-loop semantics

## Status legend

- `todo` — not started
- `blocked` — waiting on dependencies
- `ready` — all dependencies satisfied
- `done` — implemented

---

## Phase 1 — Foundation and team creation

### TF-01 — `/team` command skeleton
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** todo
- **Depends on:** none
- **Estimate:** 2.5h
- **Primary files:** `extensions/teams/index.ts`, `extensions/teams/command-router.ts`, `extensions/teams/roles.ts`
- **Deliverable:** register `/team`, parse subcommands, reject team commands in member-agent processes
- **Acceptance:**
  - `/team` is registered through extension command APIs
  - team commands fail in member processes with a clear user message
  - command router is testable independently of runtime spawning

### TF-02 — Team home + persisted team snapshot
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-01
- **Estimate:** 2.5h
- **Primary files:** `extensions/teams/storage/team-home.ts`, `extensions/teams/leader/create-team.ts`
- **Deliverable:** create `~/.pi/teams/<team-name>` and persist `team-config.yaml`
- **Acceptance:**
  - team directories are created idempotently
  - `team-config.yaml` stores the team instance name, resolved absolute workspace path, resolved absolute worktree dir, resolved leader model/thinking defaults, original config source when present, and the full config snapshot used at creation time
  - duplicate team names are rejected cleanly
  - bundled prompt templates are copied from the extension source into `~/.pi/teams/prompt-templates/` on team creation
  - `~/.pi/teams/archives/` is created lazily on first `--archive` use, not assumed to exist

### TF-03 — Team config loader and validation
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-01
- **Estimate:** 3h
- **Primary files:** `extensions/teams/config/schema.ts`, `extensions/teams/config/loader.ts`, `extensions/teams/config/default-team.yaml`
- **Deliverable:** validate YAML config, inheritance, counts, limits, prompt templates, type enums, and tool lists
- **Acceptance:**
  - valid configs expand to concrete agent definitions
  - invalid types/counts/templates are rejected with actionable errors
  - uniqueness is enforced on *constructed instance names* (e.g. `code-1`, `code-2`), not on the `nameTemplate` field itself — multiple entries may share the same `nameTemplate` when their configurations differ
  - tool names are validated against the known set: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`; unknown names are rejected
  - an agent or sub-agent entry that omits `tools` produces a clear warning that it will inherit full leader access
  - the default team YAML carries explicit tool lists for every entry

### TF-04 — Create/restart preflight validation
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-02, TF-03
- **Estimate:** 3h
- **Primary files:** `extensions/teams/leader/create-team.ts`, `extensions/teams/leader/restart-team.ts`, `extensions/teams/tasks/beads.ts`, `extensions/teams/git/worktree.ts`
- **Deliverable:** verify git, `main`, worktree dir, beads, model, thinking, prompt templates before startup
- **Acceptance:**
  - invalid workspace/setup fails before any agent spawn
  - restart validates current workspace realpath against stored snapshot
  - all preflight failures are surfaced clearly to the user

### TF-05 — Shared locks, JSONL, and event log helpers
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-02
- **Estimate:** 2.5h
- **Primary files:** `extensions/teams/storage/locks.ts`, `extensions/teams/storage/jsonl.ts`, `extensions/teams/storage/event-log.ts`
- **Deliverable:** shared `proper-lockfile` helpers for append/read/update operations
- **Acceptance:**
  - mailbox, cursor, event-log, and state writes use a common locking helper
  - append-only JSONL writes are safe under concurrent access
  - stale lock behavior is defined and test-covered

### TF-05A — Active-team lease and stale-lock recovery
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-05
- **Estimate:** 2h
- **Primary files:** `extensions/teams/storage/team-lease.ts`, `extensions/teams/leader/create-team.ts`, `extensions/teams/leader/restart-team.ts`, `extensions/teams/leader/delete-team.ts`
- **Deliverable:** `runtime-lock.json` ownership record and stale-lock recovery rules
- **Acceptance:**
  - a second leader cannot attach to an active team
  - the runtime lock is explicitly separate from beads task state
  - `/team pause` preserves the runtime lock and clean `/team stop` removes it
  - stale team locks are only cleared during validated restart/delete recovery flows
  - create/restart/delete all respect the lease file
  - `runtime-lock.json` records at minimum: `sessionId` (string), `pid` (number), `createdAt` (ISO 8601 timestamp)

### TF-06 — Team-mode custom editor, restricted autocomplete, and `/team`-only operator commands
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-01
- **Estimate:** 3h
- **Primary files:** `extensions/teams/leader/team-dashboard.ts`, `extensions/teams/leader/team-state.ts`
- **Deliverable:** restricted editor in team mode with team-scoped operator commands
- **Acceptance:**
  - only `/team ...` subcommands are accepted in team mode
  - editor focus is the default when team mode starts
  - `/team help` outputs a list of all supported subcommands with short descriptions
  - `/team hotkeys` shows team-mode shortcut help
  - `/team exit` instructs the user to stop the team first
  - free-text input shows `Use /team send <agent> <message> to communicate with agents`
  - non-`/team` slash commands show `Only /team commands are available during team mode`
  - team subcommand autocomplete covers: `send`, `steer`, `broadcast`, `stop`, `pause`, `resume`, `restart`, `delete`, `help`, `hotkeys`, `exit`

---

## Phase 2 — Supported leader UI

### TF-07 — Dashboard summary widget
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-06
- **Estimate:** 3h
- **Primary files:** `extensions/teams/leader/team-dashboard.ts`, `extensions/teams/leader/team-state.ts`
- **Deliverable:** widget + status/footer wiring for team state
- **Acceptance:**
  - dashboard renders via supported extension UI APIs
  - team name, status, agent summary, task summary, and recent events update live
  - no private chat-pane replacement is used
  - `TeamDashboardComponent` exposes `updateAgent()`, `updateTask()`, `addEvent()`, and `setTeamStatus()` methods, each calling `tui.requestRender()` after updating state
  - standing code agents use `●` (green = Working, dim = Idle, red = Crashed); sub-agents use `◆` (cyan) while active and are hidden on exit
  - task rows use the following status icons: `⏳` pending, `⚙️` coding, `✂️` simplifying, `🔍` in review, `✍️` testing, `🔗` integrating, `✅` complete, `⛔️` blocked
  - empty state shows `No agents yet` / `No tasks yet` in muted text
  - fine-grained row-layout polish such as fixed-width name padding is explicitly deferred until after the first working dashboard pass

### TF-07A — Completed task collapsing in the tasks panel
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-07
- **Estimate:** 1h
- **Primary files:** `extensions/teams/leader/team-dashboard.ts`
- **Deliverable:** completed tasks collapse into a summary line when they overflow
- **Acceptance:**
  - active tasks are always shown first
  - completed tasks are collapsed into `✓ N completed tasks` when they would overflow the available vertical space
  - the summary line is shown in muted text

### TF-08 — Event-log ring buffer and keyboard navigation
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-07
- **Estimate:** 2h
- **Primary files:** `extensions/teams/leader/team-dashboard.ts`
- **Deliverable:** scrollable event log with keyboard input and focus toggle
- **Acceptance:**
  - ring buffer capacity is 50 entries
  - keyboard handling uses `ctx.ui.onTerminalInput()` from the public extension UI type surface
  - editor is focused by default on entering team mode
  - `up`/`down` scroll the event log only when dashboard focus owns the input
  - `tab` toggles focus between dashboard and editor
  - scroll position indicator renders as `[8–12 of 31]` format when scrolled from bottom
  - terminal resize re-renders at new width with no cached widths
  - render updates are coalesced cleanly

### TF-09 — Agent/task overlays
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-07
- **Estimate:** 2h
- **Primary files:** `extensions/teams/leader/team-overlays.ts`, `extensions/teams/leader/team-dashboard.ts`
- **Deliverable:** full-list overlays for agents and tasks
- **Acceptance:**
  - overlays use supported extension overlay APIs
  - `ctrl+a` and `ctrl+t` open the appropriate overlay
  - overlays close cleanly and restore focus

### TF-10 — Idle and attention-needed states
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-07
- **Estimate:** 2h
- **Primary files:** `extensions/teams/leader/team-state.ts`, `extensions/teams/leader/team-dashboard.ts`
- **Deliverable:** explicit paused/idle/all-done/blocked/action-needed rendering
- **Acceptance:**
  - dashboard renders all named states: `Active`, `Paused`, `Stopping`, `All done`, `Blocked`, `Action needed`
  - `Blocked` is shown when one or more tasks are `deferred` with the `team:blocked-max-review-cycles` label
  - when the team transitions to `All done`, an event-log entry is appended and the dashboard header updates — the transition must be visible without inspecting the task list
  - `Action needed` covers integration failures and other conditions requiring user intervention

---

## Phase 3 — Child runtime and transport

### TF-11 — SDK child runtime bootstrap
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-04
- **Estimate:** 3h
- **Primary files:** `extensions/teams/agents/runtime-entry.ts`, `extensions/teams/leader/process-manager.ts`
- **Deliverable:** spawnable SDK-powered child runtime entrypoint
- **Acceptance:**
  - child processes launch runnable JS without requiring `tsx`
  - role/team/task/env args are passed explicitly
  - exits/errors are captured by the leader

### TF-12 — Mailboxes and cursors
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-05, TF-11
- **Estimate:** 3h
- **Primary files:** `extensions/teams/agents/mailbox.ts`, `extensions/teams/storage/locks.ts`
- **Deliverable:** lock-safe inbox JSONL + cursor JSON implementation for all agents including the leader
- **Acceptance:**
  - append/read/advance are lock-safe
  - inbox reads and cursor advancement happen under one lock scope with the retry rules from TF-05
  - each JSONL entry conforms to `{ timestamp, sender, receiver, subject, message }` where `subject` acts as message type (e.g. `task-25-coding-complete`)
  - standing code agents and active sub-agents use the same mailbox helper and poll every `PI_TEAM_MAILBOX_POLL_SECS` seconds (default: 5)
  - the leader has its own `leader-inbox.jsonl` and `leader-cursor.json`; agents report results to the leader by appending to the leader's inbox using the same JSONL format and lock discipline
  - the leader polls its inbox on the same interval as standing agents
  - sub-agent inbox and cursor files are removed on clean exit; on crash they are deleted by the leader during recovery or restart before replacement sub-agents are spawned
  - message loss and duplicate processing are covered by tests

### TF-13 — Standing code-agent lifecycle tracking
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-11
- **Estimate:** 3h
- **Primary files:** `extensions/teams/leader/process-manager.ts`, `extensions/teams/leader/team-manager.ts`
- **Deliverable:** spawn and monitor standing code agents
- **Acceptance:**
  - startup creates configured code-agent processes
  - crashes/exits are recorded and surfaced
  - one active team per leader session is enforced

### TF-14 — `/team send`, `/team steer`, `/team broadcast`
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-12, TF-13
- **Estimate:** 2.5h
- **Primary files:** `extensions/teams/command-router.ts`, `extensions/teams/leader/team-manager.ts`, `extensions/teams/agents/mailbox.ts`
- **Deliverable:** operator messaging commands with SDK queue mapping
- **Acceptance:**
  - send/steer/broadcast route to the right mailbox targets
  - invalid broadcast types fail cleanly
  - steer semantics match the SDK: interrupt between turns only
  - each agent runtime sets `agent.followUpMode = "one-at-a-time"` during startup
  - `send` / queued-work entries are mapped to `agent.followUp(message)`
  - steering entries are mapped to `agent.steer(message)`
  - broadcast remains allowed while paused and queues normally for code agents
  - inbound send/steer/broadcast messages are ignored while stopping

### TF-15 — Pause/resume
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-13, TF-14
- **Estimate:** 2h
- **Primary files:** `extensions/teams/leader/team-manager.ts`, `extensions/teams/command-router.ts`
- **Deliverable:** pause/resume control plane
- **Acceptance:**
  - pause prevents new claims without killing active work
  - message queues continue to operate while paused
  - resume re-enables claiming
  - if `/team resume` is called when the team is not paused, the user is informed and no state change occurs
  - dashboard status updates correctly

---

## Phase 4 — Pipeline and lineage handling

### TF-16 — Beads claim adapter
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-13
- **Estimate:** 3h
- **Primary files:** `extensions/teams/tasks/beads.ts`, `extensions/teams/agents/code-agent.ts`
- **Deliverable:** `br` wrapper for ready/claim/read/update flows
- **Acceptance:**
  - code agents claim only `open` work
  - dependency-blocked work is skipped via `br ready` / `br blocked`
  - the claim flow is concrete: choose from ready/open candidates, attempt the transition to `in_progress` for one selected task, and on failure treat it as a lost race and retry another candidate
  - this task-claim step is the only direct beads write performed by code agents

### TF-16A — Lineage contract and team-owned lineage state
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-16
- **Estimate:** 2.5h
- **Primary files:** `extensions/teams/tasks/beads.ts`, `extensions/teams/tasks/lineage-state.ts`, `extensions/teams/tasks/lineage.ts`
- **Deliverable:** team-owned lineage record and supported beads linkage contract
- **Acceptance:**
  - remedial tasks are represented using `--parent` and `discovered-from`
  - worktree path, branch, root task, and review cycle count live in team state
  - no assumed custom beads metadata is required

### TF-17 — Worktree/branch creation and reuse
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-16A
- **Estimate:** 3h
- **Primary files:** `extensions/teams/tasks/lineage.ts`, `extensions/teams/git/worktree.ts`, `extensions/teams/agents/code-agent.ts`
- **Deliverable:** new lineage creation and remedial reuse behavior
- **Acceptance:**
  - fresh tasks create `task-<id>` worktrees on `main`
  - remedial tasks reuse stored lineage branch/worktree
  - lineage state stays consistent through retries/restarts

### TF-18 — Code-agent completion contract
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-17
- **Estimate:** 3h
- **Primary files:** `extensions/teams/agents/code-agent.ts`, `extensions/teams/tasks/summaries.ts`, `extensions/teams/agents/context-pruning.ts`
- **Deliverable:** code-agent handoff contract to the leader
- **Acceptance:**
  - code changes are committed before completion is reported
  - summary file is created/updated
  - touched file list is reported to the leader
  - `agent.reset()` is called after each task; if it does not clear message history, `agent.state.messages = []` is also set
  - a `transformContext` hook is configured to prune old messages between tasks

### TF-19 — Simplify sub-agent runner
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-18
- **Estimate:** 2.5h
- **Primary files:** `extensions/teams/agents/simplify-agent.ts`, `extensions/teams/leader/team-manager.ts`, `extensions/teams/tasks/summaries.ts`
- **Deliverable:** simplification stage runner
- **Acceptance:**
  - simplifier runs on touched files in the same worktree
  - simplification commits are optional but supported
  - updated file list is returned to the leader

### TF-20a — Review runner and findings format
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-19
- **Estimate:** <=3h
- **Primary files:** `extensions/teams/agents/review-agent.ts`, `extensions/teams/tasks/summaries.ts`
- **Deliverable:** structured review findings output
- **Acceptance:**
  - review agent is launched with tools `read`, `grep`, `find`, `ls` only — it cannot write or execute shell commands at the runtime level
  - structured findings are appended to the summary file
  - findings are emitted back to the leader cleanly

### TF-20b — Review failure remedial task creation
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-20a
- **Estimate:** <=3h
- **Primary files:** `extensions/teams/leader/team-manager.ts`, `extensions/teams/tasks/beads.ts`, `extensions/teams/tasks/lineage-state.ts`
- **Deliverable:** leader-owned remedial task creation from review findings
- **Acceptance:**
  - leader closes original task
  - leader creates remedial task with parent-child + discovered-from
  - lineage state is updated for reuse

### TF-20c — Review cycle overflow handling
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-20b
- **Estimate:** <=3h
- **Primary files:** `extensions/teams/leader/team-manager.ts`, `extensions/teams/tasks/beads.ts`, `extensions/teams/tasks/lineage-state.ts`
- **Deliverable:** cycle count increment and overflow handling
- **Acceptance:**
  - leader increments `review_cycle_count` on each remedial task (review or test failure)
  - limit is read from `PI_TEAM_MAX_REVIEW_CYCLES` (default: 3)
  - overflow sets `deferred`, adds `team:blocked-max-review-cycles`, adds explanatory comment
  - dashboard shows the result as blocked/action-needed

### TF-21a — Test runner and findings format
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-20c
- **Estimate:** <=3h
- **Primary files:** `extensions/teams/agents/test-agent.ts`, `extensions/teams/tasks/summaries.ts`
- **Deliverable:** structured test findings output
- **Acceptance:**
  - test agent does not modify code
  - pass/fail findings are appended to the summary file
  - results are emitted back to the leader

### TF-21b — Test failure remedial task creation
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-21a
- **Estimate:** <=3h
- **Primary files:** `extensions/teams/leader/team-manager.ts`, `extensions/teams/tasks/beads.ts`, `extensions/teams/tasks/lineage-state.ts`
- **Deliverable:** leader-owned remedial task creation from test failures
- **Acceptance:**
  - leader closes original task
  - leader creates remedial task using supported beads relationships
  - cycle count and lineage state are updated consistently

### TF-22a — Commit runner
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-21b
- **Estimate:** <=3h
- **Primary files:** `extensions/teams/agents/commit-agent.ts`, `extensions/teams/git/integrate.ts`
- **Deliverable:** commit-stage git integration runner
- **Acceptance:**
  - commit agent is launched with tools `read`, `bash` only — no write or edit access to source files
  - rebase on `main` is attempted first
  - `git merge --ff-only` is used for integration
  - success/failure is reported back to the leader
  - no beads mutations happen in the commit agent
  - commit-prompt.md receives 4 parameters: task ID (`$1`), branch name (`$2`), worktree path (`$3`), main repo working directory (`$4`)
  - integration failures (rebase conflict or ff-merge failure) are **not** counted as review cycles and must not increment `review_cycle_count`; they are reported directly to the user for manual resolution

### TF-22b — Integration queue + `team:test-passed`
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-22a
- **Estimate:** <=3h
- **Primary files:** `extensions/teams/leader/integration-queue.ts`, `extensions/teams/leader/team-manager.ts`, `extensions/teams/tasks/beads.ts`
- **Deliverable:** serialized integration queue with restart-persistent ready-for-merge marking
- **Acceptance:**
  - leader labels passed tasks `team:test-passed`
  - only one commit agent runs at a time
  - leader closes tasks only after successful integration
  - leader removes queue entries and transient workflow labels based on the commit result

---

## Phase 5 — Lifecycle and recovery

### TF-23a — Stop behavior for code/simplify/review/test agents
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-22b
- **Estimate:** <=3h
- **Primary files:** `extensions/teams/leader/stop-team.ts`, `extensions/teams/leader/process-manager.ts`, `extensions/teams/git/worktree.ts`, `extensions/teams/tasks/beads.ts`
- **Deliverable:** stop behavior for non-commit roles
- **Acceptance:**
  - **Code agent stop**: in-progress code changes are rolled back and the task is reset to `open`
  - **Simplify stop**: task worktree is hard-reset to the code agent's last commit and the task is reset to `open`
  - **Review stop**: partial review state is discarded and the task is reset to `open`
  - **Test stop**: partial test state is discarded and the task is reset to `open`
  - note: stop resets review and test tasks to `open`, unlike crash recovery which leaves them `in_progress`
  - after all agents have stopped, inbox and cursor files for any sub-agents that were active at stop time are removed
  - user receives clear stop-completion feedback

### TF-23b — Stop behavior for commit-stage edge cases
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-23a
- **Estimate:** <=3h
- **Primary files:** `extensions/teams/leader/stop-team.ts`, `extensions/teams/git/worktree.ts`
- **Deliverable:** careful stop handling for rebase/merge edge cases
- **Acceptance:**
  - commit stage gets time to complete or abort cleanly
  - partial rebase/merge state is handled conservatively
  - unresolved commit-stage tasks remain inspectable by the user

### TF-24a — Restart from snapshot
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-22b, TF-05A
- **Estimate:** <=3h
- **Primary files:** `extensions/teams/leader/restart-team.ts`, `extensions/teams/storage/team-home.ts`, `extensions/teams/storage/team-lease.ts`
- **Deliverable:** restart from stored team snapshot
- **Acceptance:**
  - restart uses the authoritative stored config snapshot only
  - workspace realpath mismatch is rejected
  - team lease rules are enforced during restart

### TF-24b — Restart reconciliation
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-24a
- **Estimate:** <=3h
- **Primary files:** `extensions/teams/leader/restart-team.ts`, `extensions/teams/leader/team-manager.ts`, `extensions/teams/tasks/beads.ts`
- **Deliverable:** stale-work recovery and queue rebuild
- **Acceptance:**
  - stale `in_progress` tasks are reported
  - stale lease cleanup is handled safely
  - stale sub-agent inbox/cursor files are deleted before replacement sub-agents are spawned
  - `team:test-passed` work is requeued automatically

### TF-25 — Delete and archive
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-24b
- **Estimate:** 2.5h
- **Primary files:** `extensions/teams/leader/delete-team.ts`, `extensions/teams/storage/team-home.ts`, `extensions/teams/git/worktree.ts`
- **Deliverable:** delete inactive teams with optional archive mode
- **Acceptance:**
  - deleting the currently active team is rejected with a message to stop it first
  - deleting a different inactive team while another is active is explicitly permitted
  - archive mode zips config/mailboxes/logs/summaries under `~/.pi/teams/archives/`; the archives directory is created lazily if it does not yet exist
  - the runtime lock is removed before file deletion
  - worktrees are removed cleanly using git commands
  - if deletion fails partway through, the user is informed with the reason and a list of any files or directories that remain for manual cleanup

### TF-26 — Code-agent per-task timeout and crash recovery
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-18
- **Estimate:** 2.5h
- **Primary files:** `extensions/teams/leader/team-manager.ts`, `extensions/teams/leader/process-manager.ts`, `extensions/teams/git/worktree.ts`, `extensions/teams/tasks/beads.ts`
- **Deliverable:** per-task timeout handling for code agents
- **Acceptance:**
  - timeout threshold read from `PI_TEAM_TASK_TIMEOUT_MINS` (default: 60)
  - timed-out code agents are killed and replaced with a fresh process
  - task lineage branch and worktree are hard-reset
  - interrupted tasks return to `open` and a timeout event is logged

### TF-26A — Sub-agent crash recovery (simplify, review, test, commit)
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-26
- **Estimate:** 2h
- **Primary files:** `extensions/teams/leader/team-manager.ts`, `extensions/teams/leader/process-manager.ts`, `extensions/teams/git/worktree.ts`
- **Deliverable:** crash recovery for all four short-lived sub-agent types
- **Sub-slices:** TF-26Aa, TF-26Ab, TF-26Ac
- **Acceptance:**
  - **Simplify crash**: leader hard-resets the task worktree to the code agent's last commit, then spawns the review agent using the code agent's original file list
  - **Review crash**: leader discards partial review state, leaves task `in_progress`, spawns a fresh review agent for the same task
  - **Test crash**: leader discards partial test state, leaves task `in_progress`, spawns a fresh test agent for the same task
  - **Commit crash**: leader leaves task `in_progress`, runs `git rebase --abort` in the task worktree if a rebase is active, cleans up any partial merge state in the main repo, retains the integration queue entry, notifies the user

### TF-27 — SIGINT/SIGTERM best-effort shutdown
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-23b
- **Estimate:** 2h
- **Primary files:** `extensions/teams/index.ts`, `extensions/teams/leader/team-manager.ts`, `extensions/teams/leader/process-manager.ts`
- **Deliverable:** bounded shutdown behavior on leader exit
- **Acceptance:**
  - child shutdown is attempted for up to 5 seconds
  - remaining agents are killed if needed
  - unresolved work is left for restart reconciliation
  - worktree reset and task rollback are explicitly **not** performed in the signal handler — this is intentionally a subset of `/team stop`; full cleanup is deferred to the next `/team restart`

### TF-28a — Deterministic test harness and fixtures
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-22b, TF-24b, TF-25, TF-26, TF-26A
- **Estimate:** <=3h
- **Primary files:** `extensions/teams/__tests__/...`
- **Deliverable:** deterministic test harness using faux provider + workspace fixtures
- **Acceptance:**
  - happy-path and failure-path lineage tests exist
  - lease recovery, mailbox recovery, and queue rebuild are covered
  - leader-owned state transitions are explicitly tested

### TF-28b — Operator docs and reconciliation pass
- **Checkbox:** [ ]
- **Owner:** unassigned
- **Notes:** —
- **Status:** blocked
- **Depends on:** TF-28a
- **Estimate:** <=3h
- **Primary files:** `docs/TEAMS_PROPOSAL.md`, `docs/TEAMS-FEATURES.md`, `docs/TEAMS-BACKLOG.md`
- **Deliverable:** final operator-facing documentation set
- **Acceptance:**
  - proposal, features plan, and backlog stay aligned
  - restart/stop/delete/failure handling is documented clearly
  - no doc claims require unsupported SDK or beads features

---

## Recommended execution order

1. TF-01 → TF-06 (TF-06 is on the critical path — team mode is not testable without it)
2. TF-07, then TF-07A, TF-08, TF-09, TF-10 in parallel once team mode and the Phase 4 state model stabilise
3. TF-11 → TF-15
4. TF-16 → TF-19
5. TF-20a → TF-20c
6. TF-21a → TF-21b
7. TF-22a → TF-22b
8. TF-23a → TF-24b
9. TF-25, TF-26, TF-26A, TF-27 in parallel once TF-23/TF-24 are done
10. TF-28a → TF-28b

## Critical path

`TF-01 -> TF-02 -> TF-03 -> TF-04 -> TF-05 -> TF-05A -> TF-06 -> TF-11 -> TF-13 -> TF-16 -> TF-16A -> TF-17 -> TF-18 -> TF-19 -> TF-20a -> TF-20b -> TF-20c -> TF-21a -> TF-21b -> TF-22a -> TF-22b -> TF-23a -> TF-23b -> TF-24a -> TF-24b -> TF-28a -> TF-28b`

## Definition of done for the MVP

The MVP is done when:
- a team can be created and restarted from snapshot safely
- standing code agents and short-lived sub-agents run in separate SDK-powered child processes
- one lineage can flow `code -> simplify -> review -> test -> commit`
- remedial tasks use supported beads relationships only
- durable workflow state is leader-owned and restart-safe
- stop, timeout, crash recovery (all five agent types), restart, delete, and shutdown behaviors are covered by tests

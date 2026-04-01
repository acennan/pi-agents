# Proposed Changes to Support Autonomous Teams

The purpose of this change is to create a new extension for the Pi agent that will enable a user to create autonomous teams that can be tasked to implement code changes.

## Commands

The following `commands` should be supported:

```text
/team create --name <team-name> [--config <file>] [--worktree-dir <path>] [--model <provider>/<modelId>] [--thinking <level>]
/team stop
/team restart <team-name>
/team delete <team-name> [--archive]
/team send <agent-name> <msg...>
/team steer <agent-name> <msg...>
/team broadcast [<agent-type>] <msg...>
```

All commands must be run in the leader agent. If one is run in a member agent then the command should fail and the user should be informed.

Only one team may be active in a leader session at a time.

### create

Use this command to create a new team. The team will be created with the current session as the leader and will consist of all the member agents defined in the team YAML file. The `name` value is required, and the user should be informed if it is missing. In addition, the team name must be unique, as it is used to create a subdirectory in the `~/.pi/teams` directory.

If no `config` is supplied then use the default configuration.

The supplied `worktree-dir` value can either be absolute or relative to the user's current directory. If no path is supplied, then `~/.pi/teams/<team-name>/worktrees` will be used. Relative paths should be resolved to an absolute path before being stored in `~/.pi/teams/<team-name>/team-config.yaml`.

If a `model` is supplied, then this should be verified against the available models, and the user informed if it is not available. If no model is supplied, then the current session model should be used. The model will apply to the leader agent and all member agents that do not have a model specified. If a model is specified for a member agent, then that model must be used.

If a `thinking` level is supplied, then this should be verified against the available levels, and the user informed if it is not available. If no level is supplied, then the current session level should be used. The thinking level will apply to the leader agent and all member agents that do not have a thinking level specified. If a thinking level is specified for a member agent, then that thinking level must be used.

The team creation data should be stored in `~/.pi/teams/<team-name>/team-config.yaml` so that the team can be recreated later, even if the original source configuration has changed.

While a team is active, the user's session acts as the leader and is restricted to `/team` commands and `/help`. Normal chat and other commands are disabled until the team is stopped. `/exit` should instruct the user to stop the team first.

Once a team has finished processing all tasks, it should wait for further commands or tasks to be added. It is up to the user to stop the team.

### stop

Use this command to stop the current team. This should cleanly shut down the team and all of its member agents. No files should be deleted, and any resources should be released. Inform the user either once the team is stopped or if any errors occur.

If standing agents (coders, reviewers) are being interrupted, any code changes must be rolled back so that the worktree is in a consistent state, and the interrupted task should be reset as `open`. If a simplifier sub-agent is active, it may be interrupted immediately; since it works in the existing task worktree, the worktree should be hard-reset to the coder's last commit and the task reset to `open`. If a merger is active, it should be allowed to complete or abort cleanly before the stop is confirmed; if that is not possible, run `git merge --abort` in the worktree and leave the task as `in_progress` for the user to resolve.

### restart

Use this command to restart `team-name` using the values stored in `~/.pi/teams/<team-name>/team-config.yaml`. Restart must use the stored team snapshot rather than re-reading the original config source. Once restarted, it should continue to process tasks.

Teams can only be restarted from the same workspace they were created in. If the team was created in a different workspace, `/team restart` must fail and the user should be informed why.

If another team is already active in the current session, `/team restart` must fail.

Restart is not an attach mechanism for a team created in another leader session.

If the previous shutdown was unclean and tasks remain `in_progress`, those tasks should be reported to the user so they can decide what action to take. Tasks tagged `reviewer-approved` in beads should be re-added to the merge queue automatically, since their review is complete and they only need merging.

### delete

Use this command to delete all the files for a team. This should remove all files and directories associated with the team. Worktrees should be removed cleanly using the correct git commands.

If the team is active, the command should fail and the user should be asked to stop the team first.

If `--archive` is supplied, then before deleting the team, the `team-config.yaml` file, `summaries` directory, `mailboxes` directory, and `logs` directory should be moved into a zip archive named after the team and stored under `~/.pi/teams/archives`.

If the delete fails part-way through, the user should be informed so they can resolve the remaining files manually.

### send

Use this command to send a message to a specific standing member agent, identified by name. The command can only be run by the leader agent, who will be responsible for sending the message to the correct agent. The message is delivered when the agent is idle and is queued for its next turn. Ephemeral agents (merger, simplifier) cannot be targeted with this command.

### steer

Use this command to send a steering message to a specific standing member agent, identified by name. The command can only be run by the leader agent, who will be responsible for sending the message to the correct agent. Unlike `send`, a steer message is injected while the agent is actively processing. The intended SDK already supports this behaviour. Steering applies to all agent loops. Ephemeral agents (merger, simplifier) cannot be targeted with this command.

### broadcast

Use this command to send a message to all agents of a specific type. Supported types are `coder` and `reviewer`. Ephemeral agents (merger, simplifier) are short-lived and not addressable. If `<agent-type>` is omitted, the message should be sent to all standing member agents.

## Team Structure

When a team is created, its structure is defined by the provided YAML file. There will be a default team provided, but users are free to create their own.

The current user session is always the runtime leader. The YAML file defines worker agents only; it does not define a separate leader process.

The team configuration format is:

```yaml
name: <team template name>
description: <team description>
tools:
  - <tool name>
model: <model name>
thinking: <thinking level>
members:
  - name: <agent name>
    description: <agent description>
    type: coder | reviewer
    tools:
      - <tool name>
    model: <model name>
    thinking: <thinking level>
    promptTemplate: <prompt template filename>
```

Rules:
- `members` must always be a list of objects in the format above.
- The top-level `tools`, `model`, and `thinking` values are inherited from the leader when not defined on a member.
- Member-level values replace inherited values. In particular, `tools` are not additive.
- Each agent name must be unique. The configuration is invalid if names are duplicated.
- Worker agent `type` must be one of `coder` or `reviewer`. Merger and simplifier agents are ephemeral sub-agents spawned by the leader on demand and are not defined in the team configuration.
- `promptTemplate` is a filename only, referring to a file in the team prompt-template directory.
- The YAML `name` identifies the reusable template. The actual team instance name always comes from `/team create --name`.

If no values are supplied for the optional team fields, then the current session values should be used. Likewise, a member agent should inherit from the leader if no values are supplied.

## Default Team Configuration

The default team configuration is bundled with the extension and used when no `--config` file is supplied. Custom configs can be at any path — the `--config` flag accepts an arbitrary file path.

On team creation, the default configuration should be copied into the team area so that future extension updates do not affect existing teams.

The default configuration is:

```yaml
name: "default-team"
description: "The default team for the case that no user configuration has been supplied."
members:
  - name: "coder-1"
    description: "A coder that will implement a code change"
    type: "coder"
    promptTemplate: "coder-prompt.md"
  - name: "coder-2"
    description: "A coder that will implement a code change"
    type: "coder"
    promptTemplate: "coder-prompt.md"
  - name: "reviewer-1"
    description: "A reviewer that will review a code change"
    type: "reviewer"
    promptTemplate: "reviewer-prompt.md"
  - name: "reviewer-2"
    description: "A reviewer that will review a code change"
    type: "reviewer"
    promptTemplate: "reviewer-prompt.md"
```

Merger and simplifier agents are not listed here. They are always ephemeral and spawned by the leader as needed.

The actual team instance name should be taken from the value supplied in the `/team create --name` command.

## Agent Spawning

Member agents are spawned as separate `pi` processes, consistent with the existing subagent example extension. Each agent runs in its own process with its own session. The leader process manages the lifecycle of all member agent processes.

Merger and simplifier sub-agents are also spawned as separate `pi` processes but are short-lived. The leader creates them on demand; they exit after completing their single task. The leader is responsible for tracking their process handles and detecting unexpected exits.

## Agent Workflow

The full task lifecycle is a pipeline with four stages:

1. **Coder** — claims an `open` task, implements the change in a worktree, commits to the task branch, and notifies the leader.
2. **Simplifier** (ephemeral sub-agent, spawned by the leader after coder completion) — runs the `code-simplifier` skill against the changed files in the same task worktree and commits any improvements to the same task branch. This ensures the reviewer sees the complete, holistic change rather than reviewing coder output in isolation.
3. **Reviewer** — claims the review, inspects the task branch (including any simplifications), and either approves it or raises a remedial task and closes the original.
4. **Merger** (ephemeral sub-agent, spawned by the leader on reviewer approval) — merges the task branch into `main` and deletes the worktree on success, or cancels and informs the leader on failure.

Consider the case of the default team. That will create two coding agents and two reviewer agents, along with the team leader. It is likely that initially the reviewer agents will have nothing to do. In that case they should wait for review notifications from the leader. The coding agents will be able to each select an `open` task to work on independently.

### Coder Workflow

When a coder agent selects a task:
1. The coder atomically claims the task in the beads database. If the claim fails because another agent claimed it first, the coder selects the next `open` task.
2. If the task has a `caused-by` reference to a parent task, the coder reuses the parent task's existing worktree and branch (`<worktree-dir>/task-<parent-id>` on branch `task-<parent-id>`) rather than creating a new one. The parent worktree path is stored in the parent task's beads metadata. If no `caused-by` reference exists, the coder creates a new git worktree at `<worktree-dir>/task-<id>` on a branch named `task-<id>`, based on the current `main` branch.
3. The coder makes all code changes within that worktree.

Once the code change for a task has been completed, the coder agent should:
- Create a Markdown summary file named `task-<id>-summary.md` (using the current task's ID, not the parent's) in the `~/.pi/teams/<team-name>/summaries` directory. The reviewer will later append their findings to this same file, so the final summary contains both the code change description and the review outcome. For remedial tasks working in an existing worktree, this creates a new summary file alongside any existing ones from previous iterations.
- Commit the task changes to the task branch.
- Send a message to the leader agent to inform them that the task has been completed. This message should include the task identifier and the full list of files touched by the task so that reviewers know exactly which files to inspect.
- Leave the task as `in_progress`. The task will be marked `closed` by the merger after a successful merge to `main`.

The coding agent is now finished with this task. The agent's context should be cleared by creating a new session within the same process, equivalent to `/clear`, and it can then select a new task.

### Leader Coordination

**On coder completion:** When the leader receives a code-change-complete message, it spawns a simplifier sub-agent, passing the task identifier, the task worktree path, and the list of files touched by the task.

**On simplifier completion:** Whether or not the simplifier made changes, the leader broadcasts a review notification to all `reviewer` agents. The notification includes the task identifier, the task worktree path, and the full list of files touched (union of coder and simplifier changes). Reviewers race to claim the review. The leader updates the UI based on start and finish messages from agents.

**On reviewer approval:** When the leader receives a review-approved message, it tags the task in beads with `reviewer-approved` and adds it to an internal merge queue. The beads tag ensures that approved tasks survive a team restart and can be used to reconstruct the queue. The leader processes the merge queue sequentially — only one merger sub-agent may be active at a time — to avoid git conflicts between concurrent merges. The leader spawns a merger sub-agent for the next queued task when the previous merger has finished.

**On merger success:** The leader marks the task as `closed` in beads and logs the event.

**On merger failure:** The leader leaves the task as `in_progress`, appends an event to the log, and notifies the user with the reason. The worktree and branch are left intact for manual inspection. Once merge conflicts arise, resolution is the user's responsibility: they should merge the branch, delete the worktree, and update the task state in beads directly.

### Reviewer Workflow

Reviewers handle review notifications from the leader, issued after the simplifier pass completes (or is skipped due to a crash).

When a reviewer agent receives the broadcast notification:
1. The reviewer atomically claims the review using beads locking. If another reviewer claimed it first, this reviewer waits for the next notification.
2. The reviewer inspects the changes in the task worktree. The coder leaves the worktree intact specifically for this purpose.
3. The reviewer does not modify the code.
4. The reviewer uses the file list supplied by the leader (the union of coder and simplifier changes) to identify the full set of touched files for the review.
5. The reviewer appends their findings to the task summary file (`task-<id>-summary.md` for the current task ID).

If no issues are found:
- The reviewer informs the leader that the review is approved. The task remains `in_progress`; the leader will mark it `closed` after a successful merge.

If any issues are found:
- The task should be marked as `closed` in beads.
- A new task should be created in beads to address the issues.
- The new task should reference the original task using `caused-by`.
- The original task should reference the new task using a parent-child relationship.
- The new task's beads metadata should store the worktree path from the original task, so the coder can reuse it.
- The reviewer informs the leader that the review found issues and a new task has been raised. The leader does not queue the original task for merging.
- The remedial task enters the pipeline from the beginning: coder → simplifier → reviewer → merger, working in the same worktree and on the same branch as the original task. This ensures consistent behaviour regardless of whether a task is original or remedial.

The review agent is now finished with this task. The agent's context should be cleared by creating a new session within the same process, and it can then perform another review.

### Reviewer Cycling

There is a possibility that a review will fail on the original task, remedial changes will be made, and then the subsequent review of those will fail and so on. To prevent this, a mechanism is needed to track the number of review cycles a task lineage has generated. If the cycle count goes above a limit, then the current task should be marked as `blocked` with a comment explaining that the maximum review cycle limit was reached. The limit should be set by the environment variable `PI_TEAM_MAX_REVIEW_CYCLES`, or default to `3` if that is not set. The leader should notify the user when a task is blocked for this reason.

Review cycling applies only to the coder→simplifier→reviewer→remedial task loop. Merge failures are not counted as review cycles; they are a distinct failure mode reported directly to the user.

### Merger Sub-Agent Workflow

The merger is an ephemeral sub-agent spawned by the leader after a reviewer approves a task. It is a basic agent equipped with the `commit` skill. There is at most one merger running at any time; the leader queues additional approved tasks and processes them sequentially, which also guarantees exclusive use of the main repo working directory.

When the leader spawns a merger, it passes:
- the task identifier
- the task branch name (`task-<id>`)
- the worktree path (`<worktree-dir>/task-<id>`)
- the main repo working directory path

The merger then:
1. Runs `git merge --no-ff task-<id>` in the main repo working directory, using the `commit` skill to produce a well-formed merge commit message.
2. If the merge succeeds:
   - Deletes the task worktree using `git worktree remove <worktree-path>`.
   - Deletes the task branch.
   - Informs the leader of success.
3. If the merge fails (conflict or other error):
   - Aborts the merge (`git merge --abort`) in the main repo working directory.
   - Leaves the worktree and branch intact for the user to inspect.
   - Informs the leader of failure with the reason.
   - Exits.

The merger has no persistent state and no beads interaction. Task state transitions are performed by the leader. Pushing to a remote is not the merger's responsibility; the user controls remote synchronisation.

### Code Simplifier Workflow

The simplifier is an ephemeral sub-agent spawned by the leader after coder completion. It runs inside the existing task worktree and commits to the same task branch, so the reviewer sees the coder's change and any simplifications as a single coherent unit. It is not a standing team member.

When the leader spawns a simplifier, it passes:
- the task identifier
- the task worktree path
- the list of files changed by the coder
- the team summaries directory

The simplifier then:
1. Runs the `code-simplifier` skill scoped to the changed file list within the task worktree.

If improvements are identified:
- Makes the changes in the worktree.
- Commits the changes to the task branch. The commit message should make clear this is a simplification pass.
- Appends a simplification section to the task summary file (`task-<id>-summary.md`) describing the changes made.
- Informs the leader of the updated file list (union of coder and simplifier changes).
- Exits.

If no improvements are found:
- Informs the leader that no changes were needed.
- Exits. No summary changes are made.

## Agent Prompts

Coder agents should use the `coder-prompt.md` template, passing the team worktrees directory as `$1` and the team summaries directory as `$2`.

Reviewer agents should use the `reviewer-prompt.md` template, passing the team worktrees directory as `$1` and the team summaries directory as `$2`.

Simplifier sub-agents should use the `simplifier-prompt.md` template, passing the task identifier as `$1`, the task worktree path as `$2`, the changed file list as `$3`, and the team summaries directory as `$4`.

Merger sub-agents should use the `merger-prompt.md` template, passing the task branch name as `$1` and the task worktree path as `$2`.

## Agent Recovery

**Standing agents (coders and reviewers):** The leader monitors the health of all member agent processes. If a standing agent process crashes mid-task, the leader will:
1. Hard-reset the task branch and worktree so that all task changes are discarded.
2. Mark the interrupted task as `open` in beads so another agent can pick it up.
3. Spawn a fresh replacement agent process.
4. Log the crash event to the team event log.

**Merger sub-agents:** If a merger crashes or exits without reporting a result, the leader treats it as a merge failure: the task remains `in_progress`, the merge queue entry is retained, and the user is notified. The worktree and branch are left intact. Any partial merge state should be cleaned up by running `git merge --abort` in the worktree before notifying the user.

**Simplifier sub-agents:** If a simplifier crashes, the leader hard-resets the task worktree to the coder's last commit (to remove any partial changes) before broadcasting the review notification using the coder's original file list. Simplification is opportunistic; the reviewer will still review the coder's change.

Worktrees are created by coders and deleted by the merger after a successful merge, or left intact on merge failure for the user to inspect. The simplifier works inside the existing task worktree and does not create or delete worktrees of its own.

## Tasks

The tasks that the team should work on will be stored in a beads database. Beads is installed per workspace, so when Pi is run in a workspace, the correct beads instance will be used automatically. Interaction with this database is detailed in the associated `beads` skill. Agents will be responsible for selecting the tasks to work on by querying the beads database.

The supported beads task states are:
- `open`
- `in_progress`
- `blocked`
- `deferred`
- `draft`
- `closed`
- `tombstone`
- `pinned`

For team processing:
- coders should only claim tasks that are `open`
- tasks being actively worked on remain `in_progress` through coding and review
- tasks are marked `closed` by the leader after a successful merge, not by the reviewer
- tasks that exceed the review cycle limit become `blocked`
- review-generated remedial work should be created as new tasks rather than new states on the original task

Task selection uses atomic claiming with beads locking to prevent race conditions. When an agent selects an `open` task, it must atomically claim it before beginning work. If the claim fails because another agent claimed it first, the agent selects the next `open` task instead. Once selected, a task will be marked as `in_progress`.

Coders should ignore tasks blocked by dependencies. The expectation is that beads dependency handling is sufficient to serialize risky work.

There is no separate beads `in_review` state. Review progress is coordinated by the leader and reflected in the team UI.

If all tasks are complete, then the team should inform the user and wait for further instructions. Only the user can stop the team.

## Directories

Unless otherwise specified, all team files and directories should be stored under `~/.pi/teams/<team-name>`. By default, this directory will have the following format:

```text
~
+-- .pi
| +-- teams
|   +-- prompt-templates
|   +-- archives
|   +-- <team-name>
|     +-- team-config.yaml
|     +-- mailboxes
|     +-- worktrees
|     +-- summaries
|     +-- logs
```

The `archives/` directory stores the `.zip` archives containing the generated documents for a deleted team, (`<team-name>.zip`).

The `logs/` directory contains a team event log (`events.jsonl`) that records timestamped JSON entries for task assignments, task state transitions, agent spawns and crashes, messages sent, and review results. This provides an audit trail for debugging and user visibility. Detailed issues should be inspected by opening the log file directly.

The `prompt-templates/` directory under `~/.pi/teams/` is specifically for team prompt templates. The default templates (`coder-prompt.md`, `reviewer-prompt.md`, `merger-prompt.md`, `simplifier-prompt.md`) are bundled with the extension and copied on team creation. These are separate from the general prompt template system at `~/.pi/agent/prompts/`.

## Team Configuration File

Each team must persist its creation and configuration data in `~/.pi/teams/<team-name>/team-config.yaml`.

This file should contain enough information to fully recreate the team at a later time, without depending on the original `--config` file or the current bundled default configuration.

At minimum, the file should store:
- the team instance name supplied via `/team create --name`
- the absolute path of the workspace in which the team was created
- the values used for `/team create`, including:
  - the resolved absolute `worktree-dir`
  - the model value used for the leader default
  - the thinking level used for the leader default
  - the original config source path if one was supplied
- the full team configuration snapshot used when the team was created, including all worker definitions and their settings

The stored team configuration snapshot must be sufficient to recreate the team even if:
- the original config file has been modified or deleted
- the bundled default team configuration has changed in a newer release
- prompt-template defaults have changed since the team was created

The purpose of `team-config.yaml` is to act as the authoritative record of how the team was created.

## Messages

Messages should be sent between agents via mailboxes. All mailboxes should be stored in the `~/.pi/teams/<team-name>/mailboxes` directory.

Each agent inbox will be an append-only JSONL file with a name of the form `<agent-name>-inbox.jsonl`. Each entry in the file will be a JSON object with the following format:

```json
{
  "timestamp": "2023-09-20T12:34:56Z",
  "sender": "agent1",
  "receiver": "agent2",
  "subject": "Message subject",
  "message": "Message body"
}
```

Each agent should also have a cursor file, for example `<agent-name>-cursor.json`, storing the last processed position in its inbox. Receivers should read from the last stored cursor position, process all new messages, and then advance the cursor. The SDK is responsible for prioritisation once a message has been delivered to the target agent.

Each agent should poll their mailbox for new messages every `PI_TEAM_MAILBOX_POLL_SECS` seconds, or every 5 seconds if that environment variable is not set. Each agent should have access to the mailbox of all other agents so they can write messages into the correct agent inbox.

Ephemeral agents (merger, simplifier) use the same mailbox system. The leader creates their inbox and cursor files when spawning them. On clean exit, the ephemeral agent's inbox and cursor files are removed. On crash, they are left in place and cleaned up by the leader during recovery.

It is important that messages do not get lost, so agents must obtain an exclusive lock on the mailbox file before appending messages or advancing read cursors.

## File Locking

To prevent data loss, any file that can be accessed by multiple agents must be locked before reading or writing. File locking must use the `proper-lockfile` npm package, which is already used elsewhere in the codebase, for example `auth-storage.ts` and `settings-manager.ts`. This package handles stale lock detection, cross-process locking, and retry logic consistently with the rest of the application.

## Branch and Worktree Semantics

Each active task has one task branch named `task-<id>` and one active worktree at `<worktree-dir>/task-<id>`. The simplifier commits to the same branch and worktree; it does not create additional branches or worktrees.

Remedial tasks (those with a `caused-by` reference) reuse the worktree and branch of the root task in their lineage. Multiple beads task IDs may therefore share a single worktree and branch. Each task ID still produces its own summary file.

Coders always branch from the current `main` branch. Remedial task coders continue on the existing branch.

The merger deletes both the worktree and branch after a successful merge. On failure, both are left intact for user inspection; the user is responsible for resolving conflicts, completing the merge, and updating the task state in beads.

Merges are serialised by the leader's merge queue to reduce the chance of conflicts, but the merger is still expected to handle conflicts gracefully by aborting and notifying the leader. The system does not otherwise prevent overlapping work across unrelated tasks and does not automatically rebase task branches.

## User Interface

When a team is active, the normal chat area is replaced by a **team dashboard** — a single full-width component that renders four vertically stacked sections separated by horizontal dividers. The editor, footer, and status containers remain unchanged.

```text
┌─────────────────────────────────────────────────┐
│  Team: my-team  [3/5 tasks]  Active             │
├─────────────────────────────────────────────────┤
│  AGENTS                                         │
│   coder-1      ● Working    task-27             │
│   coder-2      ○ Idle                           │
│   reviewer-1   ● Working    task-25             │
│   reviewer-2   ○ Idle                           │
│   simplifier   ◆ Running    task-27             │
│   merger       ◆ Running    task-25             │
├─────────────────────────────────────────────────┤
│  TASKS                                          │
│   #27 ⚙️ Simplifying  (simplifier)              │
│   #26 🔍 In review    (reviewer-1)              │
│   #25 ⏫ Merging      (merger)                  │
│   #24 ✅ Complete                               │
├─────────────────────────────────────────────────┤
│  EVENT LOG                                      │
│   12:34  simplifier started task-27             │
│   12:33  reviewer-1 approved task-26            │
│   12:30  coder-2 completed task-26              │
│   12:28  merger completed task-25               │
└─────────────────────────────────────────────────┘
> /team send coder-1 focus on error handling
```

### Dashboard Sections

**Header bar** — a single highlighted line showing the team name, task progress fraction, and the current team status (`Active`, `Stopping`). All three values update live as tasks complete and the team transitions state.

**Agents panel** — one row per agent showing name, a status indicator, the status label, and the current task ID if working. Standing agents use `●` (green for Working, dim for Idle, red for Crashed). Ephemeral agents (merger, simplifier) use `◆` (cyan) and are shown only while active; they disappear from the panel when they exit. Agent name column is fixed-width, padded to the longest name. If more agents exist than can fit vertically, a `... and N more` line appears in muted text.

**Tasks panel** — one row per task showing ID, a status icon, status label, and assignee in parentheses when assigned. Active tasks appear first; completed tasks are collapsed into a summary line (`✓ N completed tasks`) when they would overflow. Status icons: `○` pending, `⏳` coding, `⚙` simplifying, `👁` in review, `↑` merging, `✓` complete, `✗` blocked.

**Event log** — timestamped `HH:MM` entries rendered from a ring buffer with capacity 50. Only the most recent entries that fit the available vertical space are shown, with a minimum of 3. The section header shows a scroll position indicator (`[8–12 of 31]`) when scrolled away from the bottom.

### Transitions

**Entering team mode** (on `/team create` or `/team restart`): the `chatContainer` is cleared, a `TeamDashboardComponent` is created with initial state, added as the sole child of `chatContainer`, and the `teamModeActive` flag is set. The existing header, footer, and editor remain.

**Exiting team mode** (on `/team stop` once confirmed): the `chatContainer` is cleared, `teamModeActive` is unset, and the normal chat history is restored.

**Live updates**: the dashboard exposes `updateAgent()`, `updateTask()`, `addEvent()`, and `setTeamStatus()` methods. Each call invalidates the affected sub-component and queues a render via the TUI's coalesced render mechanism, so rapid event bursts do not cause excessive redraws.

### Editor Restrictions

While `teamModeActive` is true:
- Only `/team` commands and `/help` are accepted.
- `/exit` should instruct the user to stop the team first.
- Any other slash command shows a status line: `Only /team commands are available during team mode`.
- Free-text input shows: `Use /team send <agent> <message> to communicate with agents`.
- The editor's autocomplete provider is replaced with a team-specific provider suggesting only `/team` subcommands: `send`, `steer`, `broadcast`, `stop`, `restart`, `delete`.

### Keyboard Shortcuts

The following bindings are only active when `teamModeActive` is true:

| Key | Action |
|-----|--------|
| `up` / `down` | Scroll the event log (when editor is not focused) |
| `ctrl+a` | Open a full agent-list overlay (`SelectList`) |
| `ctrl+t` | Open a full task-list overlay (`SelectList`) |
| `tab` | Toggle focus between the dashboard and the editor |

### Edge Cases

- **Many agents or tasks**: panels truncate with an overflow indicator; full lists are available via the overlay shortcuts.
- **Agent crash**: the agent's row turns red; an event is appended to the log; the leader's recovery logic runs in the background.
- **Terminal resize**: all sections re-render at the new width on the next render pass — no cached widths.
- **Empty state**: agents panel shows `No agents yet` and tasks panel shows `No tasks yet` in muted text until data arrives.
- **Closing Pi while a team is active**: try to make this equivalent to `/team stop`. If that is not practical, treat it as an unclean shutdown.

## Example Extensions

The code contains a number of example extensions that demonstrate the use of the Pi agent. These can be found under `packages/coding-agent/examples/extensions`.

## Future Work

- Targeting specific tasks by tag or priority

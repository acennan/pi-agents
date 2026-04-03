# Proposed Changes to Support Autonomous Teams

---

The purpose of this change is to create a new extension for the Pi agent that enables a user to create autonomous teams that can be tasked with implementing code changes.

## Commands

The following `commands` should be supported:

```text
/team create --name <team-name> [--config <file>] [--worktree-dir <path>] [--model <provider>/<modelId>] [--thinking <level>]
/team stop
/team pause
/team resume
/team restart <team-name>
/team delete <team-name> [--archive]
/team send <agent-name> <msg...>
/team steer <agent-name> <msg...>
/team broadcast [<agent-type>] <msg...>
/team help
/team hotkeys
/team exit
```

All commands must be run in the leader agent. If one is run in a member agent, the command should fail and the user should be informed.

Only one team may be active in a leader session at a time.

### create

Use this command to create a new team. The team uses the current session as the leader and consists of all agents and sub-agents defined in the team YAML file. The `name` value is required, and the user should be informed if it is missing. In addition, the team name must be unique, as it is used to create a subdirectory in the `~/.pi/teams` directory.

If no `config` is supplied, use the default configuration.

The supplied `worktree-dir` value can be either absolute or relative to the user's current directory. If no path is supplied, `~/.pi/teams/<team-name>/worktrees` will be used. Relative paths should be resolved to an absolute path before being stored in `~/.pi/teams/<team-name>/team-config.yaml`.

If a `model` is supplied, it should be verified against the available models, and the user should be informed if it is not available. If no model is supplied, the current session model should be used. The model will apply to the leader agent and all agents and sub-agents that do not have a model specified. If a model is specified for an agent or sub-agent, that model must be used.

If a `thinking` level is supplied, it should be verified against the available levels, and the user should be informed if it is not available. If no level is supplied, the current session level should be used. The thinking level will apply to the leader agent and all agents and sub-agents that do not have a thinking level specified. If a thinking level is specified for an agent or sub-agent, that thinking level must be used.

The team creation data should be stored in `~/.pi/teams/<team-name>/team-config.yaml` so that the team can be recreated later, even if the original source configuration has changed.

While a team is active, the user's session acts as the leader and is restricted to `/team` commands only. Team-mode help and utility behaviour is exposed as `/team help`, `/team hotkeys`, and `/team exit`. Normal chat and other commands are disabled until the team is stopped. `/team exit` should instruct the user to stop the team first.

Once a team has finished processing all tasks, it should wait for further commands or tasks to be added. It is up to the user to stop the team.

### stop

Use this command to stop the current team. It should cleanly shut down the team and all of its agents. No files should be deleted, and any resources should be released. Inform the user once the team is stopped, or if any errors occur. Once stopping has begun, inbound `/team send`, `/team steer`, and `/team broadcast` messages should be ignored.

**Standing agents (code agents):** If a code agent is interrupted mid-task, any code changes must be rolled back so that the worktree is in a consistent state, and the interrupted task should be reset as `open`.

**Simplify sub-agents:** A simplify agent may be interrupted immediately. Since it works in the existing task worktree, the worktree should be hard-reset to the code agent's last commit and the task reset to `open`.

**Review sub-agents:** A review agent may be interrupted immediately. Any partial review state is discarded and the task reset to `open`.

**Test sub-agents:** A test agent may be interrupted immediately. Any partial test state is discarded and the task reset to `open`.

**Commit sub-agents:** A commit agent should be allowed to complete or abort cleanly before the stop is confirmed. If that is not possible, run `git rebase --abort` in the task worktree if a rebase is active, run `git merge --abort` in the main repo working directory if a merge is active, and leave the task as `in_progress` for the user to resolve.

### pause

Use this command to suspend new task claims without stopping the team. Code agents that are currently working will finish their current task and then go idle; they will not claim new tasks until the team is resumed. Sub-agents already running continue to completion. The leader continues to coordinate in-progress pipeline stages normally. Message queues continue to operate while paused; pausing only stops further task claims.

The leader broadcasts a `team-paused` message to all standing code agents via their mailboxes and updates the team status to `Paused` in the dashboard.

### resume

Use this command to resume task claiming after a pause. The leader broadcasts a `team-resumed` message to all standing code agents, which then resume their normal task-claim loop.

If the team is not paused, the command should inform the user and do nothing.

### restart

Use this command to restart `team-name` using the values stored in `~/.pi/teams/<team-name>/team-config.yaml`. Restart must use the stored team snapshot rather than re-reading the original config source. Once restarted, it should continue to process tasks.

Teams can only be restarted from the same workspace they were created in. The check compares the current working directory (resolved to a real absolute path via `fs.realpathSync`) against the stored workspace path in `team-config.yaml`. If they do not match, `/team restart` must fail and the user should be informed why.

If another team is already active in the current session, `/team restart` must fail.

Restart is not an attachment mechanism for a team created in another leader session.

If the previous shutdown was unclean and tasks remain `in_progress`, those tasks should be reported to the user so they can decide what action to take. Tasks labelled `team:test-passed` in beads should be re-added to the integration queue automatically, since their review and tests are complete, and they only need integration into `main`.

### delete

Use this command to delete all files for a team. It should remove all files and directories associated with the team. Worktrees should be removed cleanly using the correct git commands.

If the named team is currently active, the command should fail and the user should be asked to stop the team first. Deleting a different inactive team while another is active is permitted.

If `--archive` is supplied, before deleting the team, the `team-config.yaml` file, `summaries` directory, `mailboxes` directory, and `logs` directory should be moved into a zip archive named after the team and stored under `~/.pi/teams/archives`.

If the delete fails part-way through, the user should be informed so they can resolve the remaining files manually.

### send

Use this command to send a message to a specific agent or active sub-agent, identified by name. The command can only be run by the leader agent, who will be responsible for sending the message to the correct agent. For standing code agents, the message is delivered when the agent is idle and is queued for its next turn. For active sub-agents (simplify, review, test, commit), the message is delivered to their inbox while they are running.

### steer

Use this command to send a steering message to a specific agent or active sub-agent, identified by name. The command can only be run by the leader agent, who will be responsible for sending the message to the correct agent. Unlike `send`, a steer message is translated by the target agent process into an SDK `agent.steer(...)` call while the agent is active. Per the SDK, steering interrupts between turns: the current tool calls finish first, then the steering message is injected on the next turn. Steering applies to all agent loops.

### broadcast

Use this command to send a message to all standing code agents. If `<agent-type>` is supplied, it must be `code`; any other value should produce an error. If `<agent-type>` is omitted, the message is sent to all standing code agents. Sub-agents (simplify, review, test, commit) are short-lived and not addressable via broadcast.

## Team Structure

When a team is created, its structure is defined by the provided YAML file. There will be a default team provided, but users are free to create their own.

The current user session is always the runtime leader. The YAML file defines only standing agents and sub-agents; it does not define a separate leader process.

The team configuration format is:

```yaml
name: <team template name>
description: <team description>
tools:
  - <tool name>
model: <model name>
thinking: <thinking level>
agents:
  - nameTemplate: <agent name prefix>
    description: <agent description>
    type: default-code-agent
    count: <number of instances>
    tools:
      - <tool name>
    model: <model name>
    thinking: <thinking level>
    promptTemplate: <prompt template filename>
sub-agents:
  - nameTemplate: <sub-agent name prefix>
    description: <sub-agent description>
    type: default-review-agent | default-simplify-agent | default-test-agent | default-commit-agent
    maxAllowed: <max concurrent instances>
    tools:
      - <tool name>
    model: <model name>
    thinking: <thinking level>
    promptTemplate: <prompt template filename>
```

The valid tool names correspond to the tools available in the Pi coding agent: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. These names are passed directly to `AgentConfig.tools` when the child runtime is created.

Tool assignments are the mechanism for enforcing role boundaries:
- Agents that must not modify code (review, test) should be restricted to read-only tools: `read`, `grep`, `find`, `ls`.
- The commit agent only needs `read` and `bash` (for git commands). It has no reason to write or edit source files.
- Code and simplify agents need the full set: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`.

These tool lists must be set explicitly in the team configuration for each agent and sub-agent. When no `tools` field is present, the leader's session tools are inherited — which is full access. **Read-only agents must always have an explicit `tools` list.**

Rules:
- `agents` must always be a list of objects in the format above. Agents are created at team startup and last the lifetime of the team.
- `sub-agents` must always be a list of objects in the format above. Sub-agents are created by the leader on demand and exit after completing their single task.
- The top-level `tools`, `model`, and `thinking` values are inherited from the leader when not defined on an agent or sub-agent.
- Agent-level and sub-agent-level values replace inherited values. In particular, `tools` are not additive.
- `nameTemplate` is used to construct the individual agent name based on an incrementing number. For example, `nameTemplate: code` produces `code-1`, `code-2`, etc. Each constructed name must be unique across all agents and sub-agents.
- `count` specifies how many instances of a standing agent to create from a single entry. For example, `nameTemplate: code` with `count: 2` produces `code-1` and `code-2`. Omitting `count` defaults to `1`. Multiple entries with the same `nameTemplate` are also valid when their configurations differ; in that case each entry contributes its own `count` of agents.
- `maxAllowed` limits the number of concurrent instances of a sub-agent type. The leader will not spawn a new instance if the current count has reached this limit.
- Agent `type` must be `default-code-agent`. Sub-agent `type` must be one of `default-review-agent`, `default-simplify-agent`, `default-test-agent`, or `default-commit-agent`.
- `promptTemplate` is a filename only, referring to a file in the team prompt-template directory.
- The YAML `name` identifies the reusable template. The actual team instance name always comes from `/team create --name`.

If no values are supplied for the optional fields, the current session values should be used.

## Default Team Configuration

The default team configuration is bundled with the extension and used when no `--config` file is supplied. Custom configs can be at any path — the `--config` flag accepts an arbitrary file path.

On team creation, the default configuration should be copied into the team area so that future extension updates do not affect existing teams.

The default configuration is:

```yaml
name: "default-team"
description: "The default team used when no user configuration has been supplied."
agents:
  - nameTemplate: "code"
    description: "A code agent that will implement a code change"
    type: "default-code-agent"
    count: 2
    tools:
      - read
      - write
      - edit
      - bash
      - grep
      - find
      - ls
    promptTemplate: "code-prompt.md"
sub-agents:
  - nameTemplate: "review"
    description: "A review agent that will review a code change"
    type: "default-review-agent"
    maxAllowed: 1
    tools:
      - read
      - grep
      - find
      - ls
    promptTemplate: "review-prompt.md"
  - nameTemplate: "simplify"
    description: "A simplify agent that will simplify a code change"
    type: "default-simplify-agent"
    maxAllowed: 1
    tools:
      - read
      - write
      - edit
      - bash
      - grep
      - find
      - ls
    promptTemplate: "simplify-prompt.md"
  - nameTemplate: "test"
    description: "A test agent that will run the test suite against a reviewed change"
    type: "default-test-agent"
    maxAllowed: 1
    tools:
      - read
      - bash
      - grep
      - find
      - ls
    promptTemplate: "test-prompt.md"
  - nameTemplate: "commit"
    description: "A commit agent that will integrate a task lineage branch into main"
    type: "default-commit-agent"
    maxAllowed: 1
    tools:
      - read
      - bash
    promptTemplate: "commit-prompt.md"
```

The actual team instance name should be taken from the value supplied in the `/team create --name` command.

## Agent Spawning

Standing agents (code agents) are spawned as separate SDK-powered child Node processes at team startup using Node's `child_process` module. Each agent runs in its own process with its own Pi session created from documented SDK APIs. No SDK changes are required or permitted; the implementation must use the SDK as-is and prefer existing SDK functionality over custom reimplementation. The leader process manages the lifecycle of all standing agent processes for the duration of the team, using `ChildProcess` `exit` and `error` events to detect crashes.

Sub-agents (review, simplify, test, commit) are also spawned as separate SDK-powered child processes via `child_process` but are short-lived. The leader creates them on demand; they exit after completing their single task. The leader is responsible for tracking their process handles and detecting unexpected exits. The Agent SDK has no built-in subprocess spawning or lifecycle management — this is entirely custom infrastructure in the extension.

## Agent Workflow

### Durable State Ownership

To avoid race conditions and split-brain behaviour, the leader is the single owner of all durable team state transitions.

Leader-owned durable state includes:
- beads task status changes
- beads labels and comments used by the team workflow
- remedial-task creation and dependency/link creation in beads
- team-owned lineage state (`state/lineages.json`)
- integration queue state
- runtime lock / lease state
- dashboard state derived from the authoritative team model

Agent responsibilities are narrower:
- code agents may atomically claim `open` work when selecting a task, because claiming and task selection happen together
- code agents and simplify agents may modify code and create commits in the task worktree
- review and test agents produce findings and report them to the leader
- commit agents perform git integration steps and report success/failure to the leader

Unless explicitly stated otherwise, when this document says that a task is closed, deferred, labelled, commented on, or linked to another task, that durable change is performed by the leader after receiving the relevant agent result.

The full task lifecycle is a pipeline with five stages:

1. **Code agent** — claims an `open` task, implements the change in a worktree, commits to the task lineage branch, and notifies the leader.
2. **Simplify agent** (sub-agent, spawned by the leader after code agent completion) — runs the `code-simplifier` skill against the changed files in the same task worktree and commits any improvements to the same task lineage branch. This ensures the review agent sees the complete, holistic change rather than reviewing code agent output in isolation.
3. **Review agent** (sub-agent, spawned by the leader after simplify agent completion) — inspects the task lineage branch, including any simplifications, and either approves it or reports findings that cause the leader to raise a remedial task and close the original.
4. **Test agent** (sub-agent, spawned by the leader after review approval) — runs the test suite against the task worktree and either confirms the tests pass or reports findings that cause the leader to raise a remedial task and close the original.
5. **Commit agent** (sub-agent, spawned by the leader after test confirmation) — integrates the task lineage branch into `main` and deletes the worktree on success, or cancels and informs the leader on failure; the leader then applies the resulting durable workflow updates.

Consider the default team. It creates two standing code agents. Each code agent can independently select an `open` task to work on. Sub-agents are spawned by the leader as needed once tasks reach the appropriate pipeline stage.

### Code Agent Workflow

When a code agent selects a task:
1. The code agent atomically claims the task in the beads database. If the claim fails because another agent claimed it first, the code agent selects the next `open` task.
2. If the task has a remedial-task relationship to an earlier task in the same lineage, represented in beads by a `discovered-from` dependency and a parent-child link, the code agent reuses the existing worktree and branch recorded in the team-owned lineage state rather than deriving them from the immediate parent ID. That lineage state must include the resolved worktree path, the resolved branch name, the lineage root task ID, and the current review cycle count. If no such relationship exists, the code agent creates a new git worktree at `<worktree-dir>/task-<id>` on a branch named `task-<id>`, based on the current `main` branch, and stores those resolved values in the team-owned lineage state for later remedial tasks.
3. The code agent makes all code changes within that worktree.

Once the code change for a task has been completed, the code agent should:
- Create a Markdown summary file named `task-<id>-summary.md` (using the current task's ID, not the parent's) in the `~/.pi/teams/<team-name>/summaries` directory. Any agent that carries out subsequent work for this ticket will append its findings to the same file so that it contains a description of all work undertaken for that task.
- Commit the task changes to the task lineage branch.
- Send a message to the leader agent to inform them that the task has been completed. This message should include the task identifier and the full list of files touched by the task so that the simplify agent knows exactly which files to process.
- Leave the task as `in_progress`. The leader will mark the task `closed` after a successful integration into `main`.

The code agent is now finished with this task. The agent's context should be cleared by calling `agent.reset()`, which resets agent state. If `reset()` does not clear the message history, also set `agent.state.messages = []` before the next task. To limit token usage over long-running sessions, code agents should configure a `transformContext` hook that prunes old messages between tasks. The code agent can then select a new task.

#### Per-Task Timeout

The leader monitors elapsed time for each in-progress code agent task. If a task exceeds the limit set by `PI_TEAM_TASK_TIMEOUT_MINS` (default: `60`) without the code agent reporting completion, the leader treats it as equivalent to a crash: it hard-resets the task worktree and lineage branch, marks the task `open`, spawns a fresh replacement code agent, and logs a timeout event. The timed-out agent process is killed.

### Simplify Agent Workflow

The simplify agent is a sub-agent spawned by the leader after code agent completion. It runs inside the existing task worktree and commits to the same task lineage branch, so the review agent sees the code agent's change and any simplifications as a single coherent unit. It is not a standing team member.

When the leader spawns a simplify agent, it passes:
- the task identifier
- the task worktree path
- the list of files changed by the code agent
- the team summaries directory

The simplify agent runs the `code-simplifier` skill scoped to the changed file list within the task worktree, paying particular attention to the code agent's changes.

If improvements are identified:
- Makes the changes in the worktree.
- Commits the changes to the task lineage branch. The commit message should make clear this is a simplification pass.
- Appends a simplification section to the existing task summary file, describing the changes made.
- Informs the leader of the updated file list (union of code agent and simplify agent changes).
- Exits.

If no improvements are found:
- Informs the leader that no changes were needed.
- Exits. No summary changes are made.

### Review Agent Workflow

The review agent is a sub-agent spawned by the leader after the simplify agent completes (or is skipped due to a crash). The leader assigns the specific task directly when spawning; there is no claiming race.

When the leader spawns a review agent, it passes:
- the task identifier
- the task worktree path
- the full list of files touched (union of code agent and simplify agent changes)
- the team summaries directory

The review agent then:
1. Inspects the changes in the task worktree.
2. Does not modify the code.
3. Uses the file list supplied by the leader to identify the full set of touched files for the review.
4. Appends its findings to the task summary file (`task-<id>-summary.md` for the current task ID) using the structured format below.

Review findings must be appended as a structured Markdown section:

```markdown
## Review: task-<id>

**Outcome**: approved | issues-found

### Issues

1. **File**: `<path>`, **Line**: <n>
   **Severity**: error | warning | suggestion
   **Description**: <description of the issue>
```

The `Issues` list is omitted when the outcome is `approved`. Each issue must include a file path, line number, severity, and description. This structure ensures the remedial task has precise, actionable guidance for the code agent.

If no issues are found:
- The review agent informs the leader that the review is approved. The task remains `in_progress`; the leader will mark it `closed` after a successful integration into `main`.

If any issues are found:
- The review agent reports the structured issue list to the leader.
- The leader marks the current task as `closed` in beads.
- The leader creates a new task in beads to address the issues. The new task's description must include the structured issue list from the review findings so the code agent can work directly from it.
- The leader creates the new task with `--parent <original-task-id>` so beads records the parent-child relationship.
- The leader also records a `discovered-from` dependency on the original task. This dependency acts as the team's `caused-by` link.
- The leader updates the team-owned lineage state with the resolved worktree path, resolved branch name, lineage root task ID, and review cycle count so the code agent can reuse the same lineage state without requiring custom metadata support from beads.
- The leader does not queue the original task for integration.
- The remedial task enters the pipeline from the beginning: code agent → simplify agent → review agent → test agent → commit agent, working in the same worktree and on the same branch as the original task. This ensures consistent behaviour regardless of whether a task is original or remedial.

The review agent exits after completing its review.

### Review Cycling

A review may fail on the original task, remedial changes may be made, and a subsequent review may fail again, potentially repeating the cycle. To prevent this, a mechanism is needed to track the number of review cycles a task lineage has generated. The cycle count is stored in the team-owned lineage state for the lineage root task, not in beads metadata. Each time the leader creates a remedial task from review or test findings, the leader increments this counter on the lineage record. If the cycle count exceeds a limit, the leader marks the current task as `deferred`, applies the `team:blocked-max-review-cycles` label, adds a comment explaining that the maximum review cycle limit was reached, and notifies the user. The dashboard may render this condition as `Blocked` even though the underlying beads status is `deferred`. The limit should be set by the environment variable `PI_TEAM_MAX_REVIEW_CYCLES`, or default to `3` if that is not set.

Review cycling applies to the full remediation loop: code agent → simplify agent → review agent → test agent → remedial task. Both review failures and test failures increment `review_cycle_count` on the lineage record, since both result in a remedial task being raised. Integration failures are not counted as review cycles; they are a distinct failure mode reported directly to the user.

### Test Agent Workflow

The test agent is a sub-agent spawned by the leader after the review agent approves a task. The leader assigns the specific task directly when spawning; there is no claiming race.

When the leader spawns a test agent, it passes:
- the task identifier
- the task worktree path
- the full list of files touched (union of code agent and simplify agent changes)
- the team summaries directory

The test agent then:
1. Runs the test suite within the task worktree, scoped where possible to the files in the supplied list.
2. Does not modify the code.
3. Appends its findings to the task summary file (`task-<id>-summary.md` for the current task ID) using the structured format below.

Test findings must be appended as a structured Markdown section:

```markdown
## Test Run: task-<id>

**Outcome**: passed | failed

### Failures

1. **Test**: `<test name>`
   **File**: `<path>`, **Line**: <n>
   **Description**: <failure message or description>
```

The `Failures` list is omitted when the outcome is `passed`.

If all tests pass:
- The test agent informs the leader that the tests passed. The task remains `in_progress`; the leader will add it to the integration queue.

If any tests fail:
- The test agent reports the structured failure list to the leader.
- The leader marks the current task as `closed` in beads.
- The leader creates a new task in beads to address the failures. The new task's description must include the structured failure list so the code agent can work directly from it.
- The leader creates the new task with `--parent <original-task-id>` so beads records the parent-child relationship.
- The leader also records a `discovered-from` dependency on the original task. This dependency acts as the team's `caused-by` link.
- The leader updates the team-owned lineage state with the resolved worktree path, resolved branch name, lineage root task ID, and review cycle count so the code agent can reuse the same lineage state without requiring custom metadata support from beads.
- The leader does not queue the original task for integration.

The test agent exits after completing its run.

### Commit Agent Workflow

The commit agent is a sub-agent spawned by the leader after the test agent confirms a task passes. It is a basic agent responsible for integrating an approved task lineage into `main`. There is at most one commit agent running at any time; the leader queues additional approved tasks and processes them sequentially, which also guarantees exclusive use of the main repo working directory.

When the leader spawns a commit agent, it passes:
- the task identifier
- the resolved task-lineage branch name
- the resolved task-lineage worktree path
- the main repo working directory path

The commit agent then:
1. Rebases the task-lineage branch in the task worktree onto the current local `main` branch. This is a pre-integration conflict check intended to reduce failures later.
2. If the rebase succeeds, runs `git merge --ff-only <resolved-branch-name>` in the main repo working directory.
3. If the fast-forward merge succeeds:
   - Deletes the task worktree using `git worktree remove <worktree-path>`.
   - Deletes the resolved task-lineage branch.
   - Informs the leader of success.
4. If the rebase fails (conflict or other error):
   - Aborts the rebase (`git rebase --abort`) in the task worktree.
   - Leaves the worktree and branch intact for the user to inspect.
   - Informs the leader of failure with the reason.
   - Exits.
5. If the fast-forward merge fails (for example because `main` moved again or the repo state changed unexpectedly):
   - No merge commit should be created and normally no merge state will exist.
   - Leaves the worktree and branch intact for the user to inspect.
   - Informs the leader of failure with the reason.
   - Exits.

The commit agent has no persistent state and no beads interaction. Task state transitions and all other durable workflow state transitions are performed by the leader. Pushing to a remote is not the commit agent's responsibility; the user controls remote synchronisation.

### Leader Coordination

**On code agent completion:** When the leader receives a code-change-complete message, it updates authoritative team state for the task, then spawns a simplify sub-agent, passing the task identifier, the task worktree path, and the list of files touched by the task.

**On simplify agent completion:** Whether or not the simplify agent made changes, the leader updates authoritative team state for the task, then spawns a review sub-agent, passing the task identifier, the task worktree path, and the full list of files touched (union of code agent and simplify agent changes). The leader updates the UI based on start and finish messages from agents.

**On review approval:** When the leader receives a review-approved message, it records the approval in the task summary / event log and spawns a test sub-agent, passing the task identifier, the task worktree path, and the full list of files touched.

**On review failure:** When the leader receives review findings with issues, it performs all durable workflow updates itself: closes the current beads task, creates the remedial task, records the `parent-child` and `discovered-from` relationships, updates lineage state, increments `review_cycle_count`, and either re-enters the lineage at the code stage or defers/labels/comments the task if the cycle limit has been exceeded.

**On test pass:** When the leader receives a test-passed message, it labels the task in beads with `team:test-passed` and adds it to an internal integration queue. The beads label ensures that confirmed tasks survive a team restart and can be used to reconstruct the queue. The leader processes the integration queue sequentially — only one commit sub-agent may be active at a time — to avoid git conflicts between concurrent integrations. The leader spawns a commit sub-agent for the next queued task when the previous commit agent has finished. Tasks for code agents are delivered through the mailbox; each code-agent process sets `agent.followUpMode = "one-at-a-time"` during startup, maps queued work messages onto local SDK `agent.followUp(message)` calls, and maps steering messages to `agent.steer(...)`. This keeps mailbox transport and SDK queue semantics consistent.

**On test failure:** When the leader receives test-failed findings, it performs all durable workflow updates itself: closes the current beads task, creates the remedial task, records the `parent-child` and `discovered-from` relationships, updates lineage state, increments `review_cycle_count`, and either re-enters the lineage at the code stage or defers/labels/comments the task if the cycle limit has been exceeded.

**On commit success:** The leader removes any transient workflow labels that should no longer remain on the task, marks the task as `closed` in beads, updates lineage / queue state, and logs the event.

**On commit failure:** The leader leaves the task as `in_progress`, appends an event to the log, updates queue state accordingly, and notifies the user with the reason. The worktree and branch are left intact for manual inspection. This applies to both rebase failures and fast-forward integration failures. Once such conflicts arise, resolution is the user's responsibility: they should complete or abandon the rebase as appropriate, integrate the branch manually if desired, delete the worktree when finished, and update the task state in beads directly.

## Agent Prompts

Code agents should use the `code-prompt.md` template, passing the team worktrees directory as `$1` and the team summaries directory as `$2`.

Review sub-agents should use the `review-prompt.md` template, passing the task identifier as `$1`, the task worktree path as `$2`, the changed file list as `$3`, and the team summaries directory as `$4`.

Simplify sub-agents should use the `simplify-prompt.md` template, passing the task identifier as `$1`, the task worktree path as `$2`, the changed file list as `$3`, and the team summaries directory as `$4`.

Test sub-agents should use the `test-prompt.md` template, passing the task identifier as `$1`, the task worktree path as `$2`, the changed file list as `$3`, and the team summaries directory as `$4`.

Commit sub-agents should use the `commit-prompt.md` template, passing the task identifier as `$1`, the resolved task-lineage branch name as `$2`, the resolved task-lineage worktree path as `$3`, and the main repo working directory as `$4`.

## Agent Recovery

**Standing agents (code agents):** If a standing code agent process crashes mid-task, the leader will:
- Hard-reset the task lineage branch and worktree so that all task changes are discarded.
- Mark the interrupted task as `open` in beads so another agent can pick it up.
- Spawn a fresh replacement code agent process.
- Log the crash event to the team event log.

**Simplify sub-agents:** If a simplify agent crashes, the leader hard-resets the task worktree to the code agent's last commit (to remove any partial changes) before spawning the review sub-agent using the code agent's original file list. Simplification is opportunistic; the review agent will still review the code agent's change.

**Review sub-agents:** If a review sub-agent crashes, the leader leaves the task `in_progress`, discards any partial review state, and spawns a fresh review sub-agent for the same task.

**Test sub-agents:** If a test sub-agent crashes, the leader leaves the task `in_progress`, discards any partial test state, and spawns a fresh test sub-agent for the same task.

**Commit sub-agents:** If a commit agent crashes or exits without reporting a result, the leader treats it as a commit-stage failure: the task remains `in_progress`, the integration queue entry is retained, and the user is notified. The worktree and branch are left intact. Any partial rebase state should be cleaned up by running `git rebase --abort` in the task worktree if needed. A partial merge state in the main repo is not expected with `git merge --ff-only`, but if one somehow exists it should be cleaned up before notifying the user.

Worktrees are created by code agents and deleted by the commit agent after a successful integration, or left intact on integration failure for the user to inspect. The simplify agent works inside the existing task worktree and does not create or delete worktrees of its own.

## Tasks

The tasks the team should work on are stored in a beads database. Beads is installed per workspace, so when Pi runs in a workspace, the correct beads instance will be used automatically. Interaction with this database is detailed in the associated `beads` skill. Agents will be responsible for selecting the tasks to work on by querying the beads database.

The beads statuses used directly by the team are:
- `open`
- `in_progress`
- `deferred`
- `closed`

In addition:
- `br delete` creates tombstones internally, but tombstones are not used as a team workflow state
- dependency-blocked work is discovered through `br ready` / `br blocked`, not through a separate team-owned status
- the dashboard may render a task as `Blocked` when it is `deferred` and carries the label `team:blocked-max-review-cycles`

For team processing:
- code agents should only claim tasks that are `open`
- tasks being actively worked on remain `in_progress` through coding and review
- tasks are marked `closed` by the leader after a successful integration, not by the review agent
- tasks that exceed the review cycle limit become `deferred` and are labelled `team:blocked-max-review-cycles`
- review-generated remedial work should be created as new tasks rather than new states on the original task

Task selection uses atomic claiming with beads locking to prevent race conditions. When a code agent selects an `open` task, it must atomically claim it before beginning work. If the claim fails because another agent claimed it first, the agent selects the next `open` task instead. Once selected, a task will be marked as `in_progress`.

Code agents should ignore tasks blocked by dependencies. The expectation is that beads dependency handling is sufficient to serialize risky work.

There is no separate beads `in_review` state. Review progress is coordinated by the leader and reflected in the team UI.

If all tasks are complete, the team should inform the user and wait for further instructions. Only the user can stop the team.

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
|     +-- runtime-lock.json
|     +-- mailboxes
|     |   +-- leader-inbox.jsonl
|     |   +-- leader-cursor.json
|     +-- worktrees
|     +-- summaries
|     +-- logs
|     +-- state
|       +-- lineages.json
```

The `archives/` directory stores the `.zip` archive for each deleted team (`<team-name>.zip`).

The `logs/` directory contains a team event log (`events.jsonl`) that records timestamped JSON entries for task assignments, task state transitions, agent spawns and crashes, messages sent, and review results. This provides an audit trail for debugging and user visibility. To inspect detailed issues, open the log file directly.

The `state/lineages.json` file stores team-owned lineage data that beads does not model directly: resolved worktree paths, resolved branch names, lineage root task IDs, review cycle counters, and any other leader-owned lineage bookkeeping required to resume safely.

The `runtime-lock.json` file stores the active leader/session ownership record for the team. It prevents a second leader session from attaching to or restarting the same team concurrently. Stale locks must be detected and cleared only through explicit restart/delete recovery checks.

The `prompt-templates/` directory under `~/.pi/teams/` is specifically for team prompt templates. The default templates (`code-prompt.md`, `simplify-prompt.md`, `review-prompt.md`, `test-prompt.md`, `commit-prompt.md`) are bundled with the extension and copied on team creation. These are separate from the general prompt template system at `~/.pi/agent/prompts/`.

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
- the full team configuration snapshot used when the team was created, including all agent and sub-agent definitions and their settings

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

Each agent should also have a cursor file, for example `<agent-name>-cursor.json`, storing the last processed position in its inbox. Receivers should read from the last stored cursor position, process all new messages, translate each mailbox entry into an `AgentMessage` object (with `role`, `content`, and `timestamp`) and pass it to the appropriate local SDK queue (`agent.followUp(message)` for queued work and messages, `agent.steer(message)` for steering), and then advance the cursor. Once translated into SDK queue types, the SDK handles turn ordering and prioritisation.

Standing code agents should poll their mailbox for new messages every `PI_TEAM_MAILBOX_POLL_SECS` seconds, or every 5 seconds if that environment variable is not set. Each agent should have access to the mailbox of all other agents so they can write messages into the correct agent inbox.

Sub-agents (simplify, review, test, commit) use the same mailbox system and polling mechanism as code agents. The leader creates their inbox and cursor files when spawning them. On clean exit, the sub-agent's inbox and cursor files are removed. On crash, they are deleted by the leader during recovery or restart before replacement sub-agents are spawned, so no stale mailbox state is reused.

The leader also has its own mailbox inbox (`leader-inbox.jsonl`) and cursor file (`leader-cursor.json`). Agents report results to the leader by appending entries to the leader's inbox using the standard JSONL format. The leader polls its own inbox using the same polling interval and lock discipline as standing agents. This ensures all inter-process communication uses a single auditable mechanism, regardless of direction.

It is important that messages do not get lost, so agents must obtain an exclusive lock on the mailbox file before appending messages or advancing read cursors. Reading pending entries and advancing the cursor should happen under one lock scope.

The message subject should play the role of the message type, which should be standardised. For example, something like `task-25-coding-complete` or `task-16-integration-complete`.

## File Locking

To prevent data loss, any file that can be accessed by multiple agents must be locked before reading or writing. File locking must use the `proper-lockfile` npm package. This package handles stale lock detection, cross-process locking, and retry logic consistently with the rest of the application. If a mailbox lock cannot be obtained, retry after 5 seconds; the maximum number of retry cycles is controlled by `PI_MAILBOX_LOCK_ATTEMPTS` and defaults to `5`.

## Branch and Worktree Semantics

Each task lineage has one active branch and one active worktree. For a brand-new task, the lineage branch is named `task-<id>` and the lineage worktree is created at `<worktree-dir>/task-<id>`. The simplify agent commits to that same lineage branch and worktree; it does not create additional branches or worktrees.

Remedial tasks (those linked to an earlier task by a `discovered-from` dependency and parent-child relationship) reuse the branch and worktree of the root task in their lineage. Multiple beads task IDs may therefore share a single worktree and branch. Each task ID still produces its own summary file.

Code agents always branch from the current `main` branch when creating a new lineage. Remedial task code agents continue on the existing lineage branch.

The commit agent deletes both the worktree and branch after a successful integration into `main`. On failure, both are left intact for user inspection; the user is responsible for resolving conflicts, completing or abandoning any in-progress rebase, and updating the task state in beads.

Integrations are serialised by the leader's integration queue to reduce the chance of conflicts. Before integrating, the commit agent first rebases the task lineage branch onto the current local `main` branch in the task worktree to surface conflicts earlier. If that rebase fails, it is aborted and reported to the user. If the rebase succeeds, the commit agent uses `git merge --ff-only` in the main repo so no merge commit is created and any unexpected divergence fails cleanly. The system does not otherwise prevent overlapping work across unrelated tasks.

## User Interface

When a team is active, the leader session presents a **team dashboard** built from supported extension UI surfaces. The MVP implementation uses a persistent widget above the editor, plus status/footer/header updates and overlays for full agent/task/event views. It must not depend on private chat-pane replacement internals or require SDK changes.

```text
┌─────────────────────────────────────────────────┐
│  Team: my-team  [3/5 tasks]  Active             │
├─────────────────────────────────────────────────┤
│  AGENTS                                         │
│   code-1      ● Working    task-28              │
│   code-2      ○ Idle                            │
│   simplify-1  ◆ Running    task-28              │
│   review-1    ◆ Running    task-27              │
│   test-1      ◆ Running    task-26              │
│   commit-1    ◆ Running    task-25              │
├─────────────────────────────────────────────────┤
│  TASKS                                          │
│   #28 ✂️️ Simplifying  (simplify-1)              │
│   #27 🔍 In review    (review-1)                │
│   #26 ✍️ Testing      (test-1)                  │
│   #25 🔗 Integrating  (commit-1)                │
│   #24 ✅ Complete                               │
├─────────────────────────────────────────────────┤
│  EVENT LOG                                      │
│   12:34  simplify-1 started task-28             │
│   12:33  review-1 approved task-27              │
│   12:30  code-2 completed task-27               │
│   12:28  test-1 passed task-26                  │
└─────────────────────────────────────────────────┘
> /team send code-1 focus on error handling
```

### Dashboard Sections

The first working dashboard pass may render simpler rows than the full target layout below. Fixed-width name padding, overflow summaries, completed-task collapsing, and exact icon polish are desirable refinements for later in Phase 2 rather than blockers for the first working dashboard.

**Header bar** — a single highlighted line showing the team name, task progress fraction, and the current team status (`Active`, `Paused`, `Stopping`). All three values update live as tasks complete and the team transitions state.

**Agents panel** — one row per agent showing name, a status indicator, the status label, and the current task ID if working. Standing code agents use `●` (green for Working, dim for Idle, red for Crashed). Sub-agents (review, simplify, commit) use `◆` (cyan) and are shown only while active; they disappear from the panel when they exit. Agent name column is fixed-width, padded to the longest name. If more agents exist than can fit vertically, a `... and N more` line appears in muted text.

**Tasks panel** — one row per task showing ID, a status icon, status label, and assignee in parentheses when assigned. Active tasks appear first; completed tasks are collapsed into a summary line (`✓ N completed tasks`) when they would overflow. Status icons: `⏳` pending, `⚙️` coding, `✂️` simplifying, `🔍` in review, `✍️` testing, `🔗` integrating, `✅` complete, `⛔️` blocked.

**Event log** — timestamped `HH:MM` entries rendered from a ring buffer with capacity 50. Only the most recent entries that fit the available vertical space are shown, with a minimum of 3. The section header shows a scroll position indicator (`[8–12 of 31]`) when scrolled away from the bottom.

### Transitions

**Entering team mode** (on `/team create` or `/team restart`): implement the dashboard through the coding-agent extension UI hooks that are already documented for custom UI, commands, status lines, footers, overlays, editor replacement, and terminal-input handling. A `TeamDashboardComponent` should be created with initial state and attached through those extension/TUI integration points, and the `teamModeActive` flag is set. Editor focus is the default on entry to team mode. Use supported extension composition rather than relying on brittle private container references or SDK modifications.

**Pausing team mode** (on `/team pause`): update internal state to `paused`, broadcast `team-paused` to all code agents via their mailboxes, and call `setTeamStatus("Paused")` to update the header bar. No agents are stopped.

**Resuming team mode** (on `/team resume`): update internal state to `active`, broadcast `team-resumed` to all code agents, and call `setTeamStatus("Active")`.

**Exiting team mode** (on `/team stop` once confirmed): remove the `TeamDashboardComponent` through the same extension/TUI integration path, unset `teamModeActive`, and restore the normal interactive UI.

**Live updates**: `TeamDashboardComponent` exposes custom methods `updateAgent()`, `updateTask()`, `addEvent()`, and `setTeamStatus()`. These are not SDK APIs — they are methods on the custom component class. Each call updates internal state and calls `tui.requestRender()` to queue a re-render via the TUI's built-in coalesced render mechanism, so rapid event bursts do not cause excessive redraws.

### Editor Restrictions

While `teamModeActive` is true:
- Only `/team ...` subcommands are accepted.
- `/team help`, `/team hotkeys`, and `/team exit` are the supported team-mode utility commands.
- Any other slash command shows a status line: `Only /team commands are available during team mode`.
- Free-text input shows: `Use /team send <agent> <message> to communicate with agents`.
- Team mode should expose only team-specific autocomplete suggestions for `/team` subcommands: `send`, `steer`, `broadcast`, `stop`, `pause`, `resume`, `restart`, `delete`, `help`, `hotkeys`, `exit`. The exact editor/autocomplete integration hook must be confirmed in the coding-agent implementation.

### Keyboard Shortcuts

The following bindings are only active when `teamModeActive` is true:

| Key | Action |
|-----|--------|
| `up` / `down` | Scroll the event log (when editor is not focused) |
| `ctrl+a` | Open a full agent-list overlay (`SelectList`) via supported extension overlay APIs |
| `ctrl+t` | Open a full task-list overlay (`SelectList`) via supported extension overlay APIs |
| `tab` | Toggle focus between the dashboard and the editor |

### Edge Cases

- **Many agents or tasks**: panels truncate with an overflow indicator; full lists are available via the overlay shortcuts.
- **Agent crash**: the agent's row turns red; an event is appended to the log; the leader's recovery logic runs in the background.
- **Terminal resize**: all sections re-render at the new width on the next render pass — no cached widths.
- **Empty state**: agents panel shows `No agents yet` and tasks panel shows `No tasks yet` in muted text until data arrives.
- **Closing Pi while a team is active**: on `SIGTERM`/`SIGINT`, attempt a best-effort shutdown: send abort signals to all standing agents, wait up to 5 seconds for them to exit, then kill remaining processes. Any task that was `in_progress` at shutdown should be left as `in_progress` for the user to resolve on the next `/team restart`. This is intentionally a subset of the clean `/team stop` logic — the full cleanup (worktree reset, task rollback) is deferred to restart.

## Example Extensions

The code contains a number of example extensions that demonstrate the use of the Pi agent. These can be found under `packages/coding-agent/examples/extensions` in the pi-mono repository root.

## Phase 2

The following features are deferred to a second implementation phase.

### Pre-flight Conflict Detection

Before a code agent creates a worktree, the leader checks which files are currently being modified by other in-progress tasks. If there is significant overlap, the leader defers the claim and asks the code agent to select a different task instead. This reduces avoidable merge conflicts at the commit stage without changing the git workflow. Implementation requires file-level metadata to be tracked per in-progress task in the team's working state.

### `/team retry <task-id>`

When a commit agent fails due to a rebase conflict or unexpected `main` divergence, the leader notifies the user and leaves resolution to them. A `/team retry <task-id>` command re-enqueues the task in the integration queue, allowing the commit agent to reattempt integration after the user has resolved any conflicts. If the named task is not `in_progress` or is not associated with a failed integration, the command should fail and the user should be informed.

## Future Work

- Targeting specific tasks by tag or priority

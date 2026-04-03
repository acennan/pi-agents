# Potential Features for Autonomous Teams

This document captures follow-up ideas discussed while reviewing `docs/TEAMS_PROPOSAL.md`. These are not proposed edits to the main design document; they are candidate additions to consider later.

## Summary

The current proposal is already strong for an MVP. If the goal is minimum viable autonomy, the core workflow should remain narrow. The highest-value additions are mostly about operability rather than adding more agent behavior.

The biggest opportunities are:
- safer startup checks
- better restart and recovery behavior
- protection against repeated failure loops
- clearer operator feedback and control

## V1

These are the strongest candidates to include in the first usable version because they improve reliability more than they expand scope.

### 1. Preflight validation ✅

Before `/team create` and `/team restart`, verify:
- workspace is a git repo
- `main` exists
- worktree dir is writable
- beads is available
- config is valid
- referenced prompt templates exist

Why it adds value:
- prevents avoidable runtime failures
- cheap to implement
- high trust value

### 2. Restart reconciliation ✅

On restart, reconcile:
- `in_progress` tasks with no live agent
- orphaned worktrees
- stale mailbox/cursor files
- queued `test-passed` tasks awaiting integration
- crashed sub-agent remnants

Why it adds value:
- the design depends on filesystem state, git state, beads state, and child processes
- restart should be a real recovery path, not just a relaunch mechanism

### 3. Failure quarantine for repeated crashes/timeouts

Add a retry counter for:
- code-agent crashes
- task timeouts
- optionally repeated commit-stage failures

After N failures:
- mark the task or lineage `blocked`
- log a clear reason
- notify the user

Why it adds value:
- avoids infinite retry loops
- prevents poison-pill tasks from consuming capacity

### 4. Explicit idle / no-work state ✅

When no claimable tasks exist, show whether the team is:
- idle because all work is done
- idle because tasks are blocked, deferred, or draft
- idle because dependencies prevent progress

Why it adds value:
- reduces ambiguity
- helps the user understand whether intervention is needed

## V1.1

These are high-value additions but not essential to prove the model.

### 5. Drain mode

Introduce a mode between `pause` and `stop` that:
- stops assigning new tasks
- lets active tasks finish at a safe boundary or complete their current lineage
- then transitions to idle

Why it adds value:
- operationally safer than a hard stop
- useful before maintenance, rebases, or inspection

### 6. Attention-needed notifications ✅

Surface prominent notices for:
- tasks blocked due to review-cycle limit
- repeated crashes or timeouts
- integration failure
- restart reconciliation issues
- no claimable work for actionable reasons

Why it adds value:
- the event log is passive
- users should not have to watch the dashboard constantly

### 7. Lineage-level summary ✅

In addition to per-task summaries, maintain a higher-level lineage summary that captures:
- lineage root task
- descendant remedial tasks
- review and test failures over time
- final outcome or blocked status

Why it adds value:
- makes remediation chains easier for humans to understand
- improves handoff and debugging

### 8. Configurable integration approval gate ✅

Add an optional mode to require user approval before the commit stage:
- `auto`
- `manual-approve-before-merge`

Why it adds value:
- helps adoption for cautious users
- adds control without changing the rest of the workflow

## Phase 2

These features add strategic value but also broaden the design and increase complexity.

### 9. Priority/tag-aware scheduling

Extend task selection to support:
- priority-first processing
- tag targeting
- task class filters
- weighted scheduling rules

Why it adds value:
- makes behavior feel more intentional
- improves usefulness on real backlogs

### 10. Pre-flight conflict detection

Before a code agent starts work, check overlap with files currently being changed by other in-progress tasks.

Why it adds value:
- reduces avoidable integration conflicts
- but requires extra metadata and coordination

### 11. `/team retry <task-id>` ✅

Allow a user to re-enqueue a task for integration after manually resolving conflicts.

Why it adds value:
- useful once manual conflict resolution becomes common
- not required for first end-to-end flow

### 12. Smarter scheduling heuristics

Possible heuristics include:
- avoid working on the same area concurrently
- prefer shorter or lower-risk tasks first
- reserve capacity for quick wins
- deprioritize flaky lineages

Why it adds value:
- improves throughput and conflict avoidance
- but is optimization rather than foundation

### 13. Richer drill-down UI

Possible additions include:
- lineage history views
- blocked-reason inspection
- crash-history inspection
- integration-queue inspection

Why it adds value:
- improves operability
- but the dashboard can remain simpler initially

## Recommended prioritization

### V1
1. Preflight validation
2. Restart reconciliation
3. Failure quarantine / retry cap
4. Explicit idle / no-work states

### V1.1
5. Drain mode
6. Attention-needed notifications
7. Lineage-level summary
8. Optional manual approval before integration

### Phase 2
9. Priority/tag-aware scheduling
10. Pre-flight conflict detection
11. `/team retry <task-id>`
12. Smarter scheduling heuristics
13. Richer drill-down UI

## Key takeaway

For this design, the next best functionality is not more agent behavior. It is better operational safety, recovery, and user visibility.
